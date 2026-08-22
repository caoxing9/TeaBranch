import Darwin
import Foundation

/// Port probing and reclaiming.
enum Ports {
    /// Whether we could bind the port right now.
    static func isAvailable(_ port: UInt16) -> Bool {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return false }
        defer { close(descriptor) }

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        address.sin_addr.s_addr = inet_addr("127.0.0.1")

        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return bound == 0
    }

    /// Ports we refuse to hand a worktree, even when nothing is bound to them right now.
    ///
    /// `isAvailable` only answers "can I bind this *this second*". Postgres, Redis and the rest
    /// are usually running but not always, so a worktree created while one happened to be down
    /// would take its port and then collide the moment it came back. These are the ports where
    /// that is predictable enough to be worth reserving.
    private static let reservedPorts: Set<UInt16> = [
        // macOS itself. AirPlay Receiver / Control Center claim these on modern releases and
        // hand back a confusing "port in use" long after you've stopped looking for the cause.
        5000, 7000,
        // Datastores.
        3306,  // MySQL / MariaDB
        5432,  // PostgreSQL
        6379,  // Redis
        11211, // Memcached
        27017, // MongoDB
        9200, 9300, // Elasticsearch
        5672, 15672, // RabbitMQ
        // Things a dev machine tends to be running anyway.
        8080, 8443, 9000, 9090, 4000, 5173, 5174,
    ]

    /// Whether a port should be skipped when allocating.
    ///
    /// Below 1024 needs root, and 49152+ is the ephemeral range the kernel hands out for outbound
    /// connections — binding a listener in there invites a random collision that is nearly
    /// impossible to reproduce.
    static func isReserved(_ port: UInt16) -> Bool {
        port < 1024 || port >= 49152 || reservedPorts.contains(port)
    }

    /// First port at or after `start` that is both free on the machine and unclaimed by us.
    static func findAvailable(from start: UInt16, used: Set<UInt16>) -> UInt16 {
        var port = start
        while used.contains(port) || isReserved(port) || !isAvailable(port) {
            guard port < UInt16.max else { return start }
            port += 1
        }
        return port
    }

    /// PIDs currently LISTENing on the port.
    static func listeners(on port: UInt16) -> [pid_t] {
        let result = Shell.run("lsof", ["-ti", "tcp:\(port)", "-sTCP:LISTEN"])
        return result.stdout.split(whereSeparator: \.isWhitespace).compactMap { pid_t($0) }
    }

    static func isListening(_ port: UInt16) -> Bool {
        !listeners(on: port).isEmpty
    }

    /// Every port in LISTEN state, from a single `lsof` call.
    ///
    /// The reconcile loop needs the status of two or three ports per worktree; probing them
    /// one at a time meant dozens of `lsof` spawns every few seconds.
    static func allListening() -> Set<UInt16> {
        // `-F n` prints one field per line; the ones we want look like `n127.0.0.1:3000`
        // or `n*:5432`.
        let result = Shell.run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "n"])
        var ports: Set<UInt16> = []

        for line in result.stdout.split(separator: "\n") where line.hasPrefix("n") {
            let address = line.dropFirst()
            guard let colon = address.lastIndex(of: ":"),
                  let port = UInt16(address[address.index(after: colon)...])
            else { continue }
            ports.insert(port)
        }
        return ports
    }

    /// Every LISTENing port mapped to the PID holding it, from a single `lsof` call.
    ///
    /// `-F pn` emits a `p<pid>` line followed by an `n<address>` line per socket, so one pass
    /// recovers the whole table. This is how a branch that TeaBranch did *not* start — an orphan
    /// adopted by the reconcile loop after a restart — can still be attributed to a process:
    /// its ports are the only handle we have on it.
    static func listenersByPort() -> [UInt16: pid_t] {
        let result = Shell.run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"])
        guard result.ok else { return [:] }

        var map: [UInt16: pid_t] = [:]
        var currentPID: pid_t?

        for line in result.stdout.split(separator: "\n") {
            guard let marker = line.first else { continue }
            let value = line.dropFirst()

            switch marker {
            case "p":
                currentPID = pid_t(value)
            case "n":
                guard let pid = currentPID,
                      let colon = value.lastIndex(of: ":"),
                      let port = UInt16(value[value.index(after: colon)...])
                else { continue }
                // First writer wins: a port bound on several addresses is still one process.
                if map[port] == nil { map[port] = pid }
            default:
                continue
            }
        }
        return map
    }

    /// SIGKILL anything bound to the port — the last-resort cleanup path.
    static func kill(port: UInt16) {
        let result = Shell.run("lsof", ["-ti", "tcp:\(port)"])
        for pid in result.stdout.split(whereSeparator: \.isWhitespace).compactMap({ pid_t($0) }) {
            Darwin.kill(pid, SIGKILL)
        }
    }

    /// SIGTERM → wait → SIGKILL → wait, until nothing is LISTENing on the port.
    ///
    /// Returns the PIDs that survived all of it — empty means the port is genuinely free. Callers
    /// need that answer rather than a fire-and-forget: "Stop" that silently leaves a server up is
    /// the single most confusing thing this app can do, so the one caller that can't fix it still
    /// has to be able to *say* so.
    ///
    /// Also called before binding a port ourselves: a new dev server otherwise races the kernel
    /// and fails to bind with EADDRINUSE while the old socket sits in TIME_WAIT.
    @discardableResult
    static func reclaim(port: UInt16) -> [pid_t] {
        let holders = listeners(on: port)
        guard !holders.isEmpty else { return [] }

        Log.info("Port \(port) held by \(holders), sending SIGTERM")
        holders.forEach { Darwin.kill($0, SIGTERM) }
        if let survivors = waitForRelease(port: port, deadline: 4), survivors.isEmpty {
            return []
        }

        let remaining = listeners(on: port)
        guard !remaining.isEmpty else { return [] }
        Log.info("Port \(port) still held by \(remaining), SIGKILL")
        remaining.forEach { Darwin.kill($0, SIGKILL) }

        let survivors = waitForRelease(port: port, deadline: 3) ?? []
        if !survivors.isEmpty {
            Log.warn("port \(port) still held by \(survivors) after SIGKILL")
        }
        return survivors
    }

    /// Poll until nothing LISTENs on `port`, or `deadline` seconds elapse.
    ///
    /// Returns `[]` once the port is free, or the surviving PIDs on timeout. Each probe is an
    /// `lsof` spawn, so the cadence is 250ms rather than tight-looping: a server that dies
    /// promptly costs two or three probes, and the slow path is bounded instead of frequent.
    private static func waitForRelease(port: UInt16, deadline: TimeInterval) -> [pid_t]? {
        let end = Date().addingTimeInterval(deadline)
        while Date() < end {
            let holders = listeners(on: port)
            if holders.isEmpty { return [] }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return listeners(on: port)
    }
}
