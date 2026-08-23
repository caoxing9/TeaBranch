import Darwin
import Foundation

/// One process belonging to a branch's dev servers.
struct ProcessSample: Hashable, Identifiable, Sendable {
    let pid: pid_t
    /// Executable name, without the path.
    let name: String
    let cpuPercent: Double
    let residentBytes: UInt64
    /// Which of the branch's commands this process belongs to (`backend`, `frontend`, …).
    /// Assigned after parsing, once the row has been matched to a target.
    var group: String
    /// Wall-clock age in seconds. Kept numeric so a branch's uptime is the max of its processes
    /// rather than whichever formatted string happens to sort highest.
    let elapsedSeconds: Int

    var id: pid_t { pid }

    var uptime: String { ProcessStats.formatDuration(elapsedSeconds) }
}

/// What a branch is costing right now.
struct BranchUsage: Hashable, Sendable {
    var processes: [ProcessSample] = []
    var cpuPercent: Double = 0
    var residentBytes: UInt64 = 0

    var isEmpty: Bool { processes.isEmpty }

    /// How long this branch has been up — the age of its oldest surviving process. A watch-mode
    /// restart replaces one command without resetting the others, so the max is the honest answer
    /// to "since when has this branch been running".
    var uptimeSeconds: Int { processes.map(\.elapsedSeconds).max() ?? 0 }
    var uptime: String { ProcessStats.formatDuration(uptimeSeconds) }
}

/// Per-worktree resource usage, sampled from `ps`.
///
/// Everything TeaBranch spawns becomes its own process group leader (`POSIX_SPAWN_SETPGROUP` with
/// pgroup 0), so a branch's entire tree — `pnpm` → `turbo` → `next dev`, and every worker they
/// fork — shares one pgid. That makes "what is this branch using" a single grouping key rather
/// than a tree walk, and lets one `ps` invocation cover every branch at once instead of one per
/// process.
enum ProcessStats {
    /// What a branch can be identified by: the process groups we started for it, and the ports it
    /// is serving on. Either is enough.
    struct Target: Sendable {
        var branch: String
        /// Process-group leader → the label of the command we started in it.
        var pgids: [pid_t: String]
        var ports: [UInt16]
    }

    /// Sample every target in one pass.
    ///
    /// Blocking — spawns `ps`, and `lsof` when some target has to be resolved by port. Call it off
    /// the main thread.
    ///
    /// Resolving by port matters more than it looks: after TeaBranch restarts, the reconcile loop
    /// re-adopts still-running dev servers by probing their ports, and it has no PIDs for them at
    /// all. Keying resource usage purely off our own PID table meant the panel was empty for every
    /// branch until you stopped and started it again — which is to say, most of the time.
    static func sample(targets: [Target]) -> [String: BranchUsage] {
        guard !targets.isEmpty else { return [:] }

        // Only pay for lsof when at least one branch has no PIDs of ours.
        let needsPortLookup = targets.contains { $0.pgids.isEmpty && !$0.ports.isEmpty }

        // When every branch is one we started, `ps -g` lets the kernel do the filtering — on a
        // machine with ~900 processes that is the difference between scanning all of them and
        // scanning four. The orphan path still needs the full table, because resolving a port to
        // a process group means looking up a pid we don't know in advance.
        // `args` rather than `comm`: every process in a node toolchain reports `comm` as "node",
        // so a nine-row table would read "node" nine times. The script name is in the arguments.
        let columns = "pid=,pgid=,%cpu=,rss=,etime=,args="
        let knownPgids = targets.flatMap { Array($0.pgids.keys) }
        let result: CommandResult = (!needsPortLookup && !knownPgids.isEmpty)
            ? Shell.run("ps", ["-o", columns, "-g", knownPgids.map(String.init).joined(separator: ",")])
            : Shell.run("ps", ["-Ao", columns])
        guard result.ok else { return [:] }

        var rows: [(pgid: pid_t, process: ProcessSample)] = []
        var pgidByPID: [pid_t: pid_t] = [:]
        for line in result.stdout.split(separator: "\n") {
            guard let row = parse(line) else { continue }
            rows.append(row)
            pgidByPID[row.process.pid] = row.pgid
        }

        let listeners = needsPortLookup ? Ports.listenersByPort() : [:]

        var usage: [String: BranchUsage] = [:]
        for target in targets {
            var labelByPgid = target.pgids
            if labelByPgid.isEmpty {
                // Map each serving port to its listener, then to that listener's process group —
                // which is the same group the whole `pnpm → node` tree lives in. A recovered
                // orphan has no command label of ours, so it is named after the port it serves.
                for port in target.ports {
                    guard let pid = listeners[port], let pgid = pgidByPID[pid] else { continue }
                    labelByPgid[pgid] = ":\(port)"
                }
            }
            guard !labelByPgid.isEmpty else { continue }

            var merged = BranchUsage()
            for row in rows {
                guard let group = labelByPgid[row.pgid] else { continue }
                var process = row.process
                process.group = group
                merged.processes.append(process)
                merged.cpuPercent += process.cpuPercent
                merged.residentBytes += process.residentBytes
            }
            guard !merged.isEmpty else { continue }

            // Grouped by command, heaviest first inside each — when a branch has a dozen workers,
            // the one actually burning the memory is the only one you are looking for.
            merged.processes.sort {
                $0.group == $1.group ? $0.residentBytes > $1.residentBytes : $0.group < $1.group
            }
            usage[target.branch] = merged
        }
        return usage
    }

    // MARK: - Parsing

    private static func parse(_ line: Substring) -> (pgid: pid_t, process: ProcessSample)? {
        // Fields are space-separated and `comm` may itself contain spaces, so the first five are
        // split off positionally and the remainder is the command.
        let fields = line.split(separator: " ", maxSplits: 5, omittingEmptySubsequences: true)
        guard fields.count == 6,
              let pid = pid_t(fields[0]),
              let pgid = pid_t(fields[1]),
              let cpu = Double(fields[2]),
              let rssKB = UInt64(fields[3])
        else { return nil }

        return (
            pgid,
            ProcessSample(
                pid: pid,
                name: scriptName(fromArgs: String(fields[5])),
                cpuPercent: cpu,
                residentBytes: rssKB * 1024,
                group: "",
                elapsedSeconds: parseElapsed(String(fields[4]))
            )
        )
    }

    /// The useful half of a command line.
    ///
    /// `node -r …/source-map-support/register.js …/backend-ee/dist/index` should read as `index`,
    /// not as `node` and not as `register`. So: skip the interpreter, skip flags, skip the value
    /// that follows the flags which take one, skip `KEY=value` env prefixes, and name the first
    /// real argument left. Anything that isn't a node invocation keeps its own name.
    static func scriptName(fromArgs args: String) -> String {
        let tokens = args.split(separator: " ").map(String.init)
        guard let first = tokens.first else { return args }

        let executable = basename(first)
        guard executable == "node" || executable == "node.js" else { return executable }

        /// Flags that consume the token after them.
        let valueFlags: Set<String> = ["-r", "--require", "--import", "--loader", "-e", "--eval"]

        var index = 1
        while index < tokens.count {
            let token = tokens[index]
            if valueFlags.contains(token) {
                index += 2
                continue
            }
            if token.hasPrefix("-") || token.contains("=") {
                index += 1
                continue
            }
            var name = basename(token)
            if name.hasSuffix(".js") { name = String(name.dropLast(3)) }
            if name.hasSuffix(".mjs") || name.hasSuffix(".cjs") { name = String(name.dropLast(4)) }
            return name.isEmpty ? executable : name
        }
        return executable
    }

    private static func basename(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    /// `ps` prints elapsed time as `[[dd-]hh:]mm:ss`.
    static func parseElapsed(_ raw: String) -> Int {
        var days = 0
        var rest = raw
        if let dash = raw.firstIndex(of: "-") {
            days = Int(raw[raw.startIndex..<dash]) ?? 0
            rest = String(raw[raw.index(after: dash)...])
        }

        let parts = rest.split(separator: ":").compactMap { Int($0) }
        switch parts.count {
        case 3: return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]
        case 2: return days * 86400 + parts[0] * 60 + parts[1]
        case 1: return days * 86400 + parts[0]
        default: return 0
        }
    }

    /// The coarsest useful unit — a dev server's age is interesting to the minute, never to the
    /// second once it is past one.
    static func formatDuration(_ seconds: Int) -> String {
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        if hours > 0 { return "\(hours)h \(minutes)m" }
        if minutes > 0 { return "\(minutes)m" }
        return "\(seconds)s"
    }

    /// Bytes as a short human string, matching the density of the rest of the inspector.
    static func formatBytes(_ bytes: UInt64) -> String {
        let units = ["B", "KB", "MB", "GB", "TB"]
        var value = Double(bytes)
        var unit = 0
        while value >= 1024, unit < units.count - 1 {
            value /= 1024
            unit += 1
        }
        return value >= 100 || unit == 0
            ? String(format: "%.0f %@", value, units[unit])
            : String(format: "%.1f %@", value, units[unit])
    }
}
