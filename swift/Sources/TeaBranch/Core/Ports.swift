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

    /// First port at or after `start` that is both free on the machine and unclaimed by us.
    static func findAvailable(from start: UInt16, used: Set<UInt16>) -> UInt16 {
        var port = start
        while used.contains(port) || !isAvailable(port) {
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

    /// SIGKILL anything bound to the port — the last-resort cleanup path.
    static func kill(port: UInt16) {
        let result = Shell.run("lsof", ["-ti", "tcp:\(port)"])
        for pid in result.stdout.split(whereSeparator: \.isWhitespace).compactMap({ pid_t($0) }) {
            Darwin.kill(pid, SIGKILL)
        }
    }

    /// SIGTERM → wait → SIGKILL → poll until the LISTEN socket is really gone.
    ///
    /// Call this before binding a port ourselves: a new dev server otherwise races the kernel
    /// and fails to bind with EADDRINUSE while the old socket sits in TIME_WAIT.
    static func reclaim(port: UInt16) {
        let holders = listeners(on: port)
        guard !holders.isEmpty else { return }

        Log.info("Port \(port) held by \(holders), sending SIGTERM")
        holders.forEach { Darwin.kill($0, SIGTERM) }

        for _ in 0..<10 {
            Thread.sleep(forTimeInterval: 0.2)
            if listeners(on: port).isEmpty { break }
        }

        let remaining = listeners(on: port)
        if !remaining.isEmpty {
            Log.info("Port \(port) still held by \(remaining), SIGKILL")
            remaining.forEach { Darwin.kill($0, SIGKILL) }
        }

        for _ in 0..<25 {
            if listeners(on: port).isEmpty { return }
            Thread.sleep(forTimeInterval: 0.2)
        }
        Log.warn("port \(port) still listening after 5s")
    }
}
