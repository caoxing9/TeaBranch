import Darwin
import Foundation

/// One dev process to start, with the port it is expected to serve on.
struct StartCommand: Hashable {
    var label: String
    var command: String
    var port: UInt16
    var environment: [String: String]
}

/// Starting, supervising and stopping a branch's dev servers.
///
/// Everything here runs off the main thread: callers dispatch to `ProcessManager.queue`, and
/// the log readers and watchdogs live on their own threads.
enum ProcessManager {
    /// Where start/stop work runs. **Concurrent**, one slot per branch in practice.
    ///
    /// This was a serial queue, which was the wrong tool for the invariant it was defending. The
    /// thing that must not interleave is *port allocation* — a few microseconds of arithmetic —
    /// but a serial queue also made every other branch wait out a whole start (`pnpm install`,
    /// migrations) or a whole stop (now bounded by how long a dev server takes to die). Running
    /// several branches at once is the entire point of the app, so the exclusion moved down to
    /// `allocationLock`, which guards exactly the critical section and nothing else.
    static let queue = DispatchQueue(
        label: "sh.teabranch.process",
        qos: .userInitiated,
        attributes: .concurrent
    )

    /// Held across "read the ports in use → claim ours", so two concurrent starts can't pick the
    /// same free port. Nothing slow happens inside it.
    private static let allocationLock = NSLock()

    /// One lock per branch, so operations on the *same* branch still serialise.
    ///
    /// Making the queue concurrent bought parallelism across branches but removed the only thing
    /// ordering work within one: Start (which can spend minutes in `pnpm install`) and Delete
    /// (`git worktree remove --force`) could run at the same time, on the same directory. Different
    /// branches still never wait for each other.
    private static let branchLocks = BranchLocks()

    private final class BranchLocks: @unchecked Sendable {
        private let lock = NSLock()
        private var locks: [String: NSRecursiveLock] = [:]

        func lock(for branch: String) -> NSRecursiveLock {
            lock.lock()
            defer { lock.unlock() }
            if let existing = locks[branch] { return existing }
            let created = NSRecursiveLock()
            locks[branch] = created
            return created
        }
    }

    /// Run `body` with exclusive access to one branch. Recursive, so `stop` nested inside a
    /// delete or a restart does not deadlock.
    static func withBranchLock<T>(_ branch: String, _ body: () throws -> T) rethrows -> T {
        let lock = branchLocks.lock(for: branch)
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    // MARK: - Start

    static func start(branch: String) throws {
        try withBranchLock(branch) { try performStart(branch: branch) }
    }

    private static func performStart(branch: String) throws {
        let state = AppState.shared
        guard let repo = state.projectURL else {
            throw TeaBranchError("No project path set")
        }
        if let environment = state.environment(branch), environment.status.isLive {
            throw TeaBranchError("Branch is already running")
        }

        let worktree = try GitService.worktreePath(for: branch, in: repo)

        // Pick the ports and claim them under the lock, so two branches starting at once can't
        // both be handed the same free port. The liveness guard is re-checked inside it for the
        // same reason — the one above is a fast path, this is the one that decides.
        allocationLock.lock()
        if let environment = state.environment(branch), environment.status.isLive {
            allocationLock.unlock()
            throw TeaBranchError("Branch is already running")
        }

        // Ports come from the worktree's own env file when it has them — that env file is the
        // contract the dev servers themselves read. Only fall back to allocation if it doesn't.
        var used = state.portsInUse()
        let basePort = state.settings.basePort

        let backendPort = EnvFile.port("SERVER_PORT", in: worktree)
            ?? Ports.findAvailable(from: basePort, used: used)
        used.insert(backendPort)
        let socketPort = EnvFile.port("SOCKET_PORT", in: worktree)
            ?? Ports.findAvailable(from: backendPort &+ 1, used: used)
        used.insert(socketPort)
        let frontendPort = EnvFile.port("PORT", in: worktree)
            ?? Ports.findAvailable(from: socketPort &+ 1, used: used)

        let databaseName = EnvFile.baseDatabaseURL(in: worktree).flatMap { DatabaseURL.name(of: $0) }
            ?? DatabaseURL.name(forBranch: branch)

        state.setEnvironment(BranchEnvironment(
            branchName: branch,
            worktreePath: worktree.path,
            port: frontendPort,
            backendPort: backendPort,
            socketPort: socketPort,
            status: .building,
            databaseName: databaseName
        ))
        allocationLock.unlock()

        Log.info("""
            start_branch: branch=\(branch), worktree=\(worktree.path), \
            backend_port=\(backendPort), socket_port=\(socketPort), frontend_port=\(frontendPort)
            """)
        AppEvents.post(.environmentsChanged)

        do {
            try startService(
                branch: branch,
                worktree: worktree,
                backendPort: backendPort,
                socketPort: socketPort,
                frontendPort: frontendPort
            )
        } catch {
            state.mutateEnvironment(branch) { $0.status = .error }
            AppEvents.post(.environmentsChanged)
            throw error
        }
    }

    private static func startService(
        branch: String,
        worktree: URL,
        backendPort: UInt16,
        socketPort: UInt16,
        frontendPort: UInt16
    ) throws {
        let state = AppState.shared

        note(branch, "Starting \(branch)")

        // A stale Next.js dev lock makes the next boot bail with "is another instance running?".
        for relative in ["enterprise/app-ee/.next/dev/lock", ".next/dev/lock"] {
            let lock = worktree.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: lock.path) {
                Log.info("Removing stale Next.js lock: \(lock.path)")
                try? FileManager.default.removeItem(at: lock)
            }
        }

        // Reclaim our ports from zombies left by a previous run before anything tries to bind.
        for port in [backendPort, socketPort, frontendPort] {
            if Ports.isListening(port) {
                note(branch, "Port \(port) is still held — reclaiming it")
            }
            Ports.reclaim(port: port)
        }

        try ensureDependencies(in: worktree, branch: branch)

        var sharedEnvironment: [String: String] = [:]

        if let envURL = EnvFile.baseDatabaseURL(in: worktree) {
            note(branch, "Checking database")
            do {
                let url = try DatabaseService.ensureExists(url: envURL)
                Log.info("Using database URL: \(url)")
                sharedEnvironment["PRISMA_DATABASE_URL"] = url
            } catch {
                Log.warn("database check failed: \(error.localizedDescription). Using env URL.")
                sharedEnvironment["PRISMA_DATABASE_URL"] = envURL
            }
        } else {
            Log.info("No PRISMA_DATABASE_URL found, skipping database setup")
        }

        if let redisURI = EnvFile.value("BACKEND_CACHE_REDIS_URI", in: worktree) {
            Log.info("Using Redis URI: \(redisURI)")
            sharedEnvironment["BACKEND_CACHE_REDIS_URI"] = redisURI
        }

        var commands = detectStartCommands(
            worktree: worktree,
            backendPort: backendPort,
            socketPort: socketPort,
            frontendPort: frontendPort
        )
        for index in commands.indices {
            commands[index].environment.merge(sharedEnvironment) { _, new in new }
        }

        for command in commands {
            note(branch, "Launching \(command.label) on port \(command.port)")
            try spawn(command, branch: branch, worktree: worktree)
        }
        note(branch, "Waiting for the first output…")

        state.mutateEnvironment(branch) { $0.status = .running }
        let generation = state.bumpWatchdogGeneration(branch: branch)
        startWatchdog(branch: branch, worktree: worktree, commands: commands, generation: generation)

        AppEvents.post(.environmentsChanged)
    }

    // MARK: - Command detection

    /// Work out what to run from `package.json`.
    ///
    /// Teable splits its dev server in two (`dev:backend:swc` + `dev:frontend`); anything else
    /// falls back to a single `dev`/`start` script.
    static func detectStartCommands(
        worktree: URL,
        backendPort: UInt16,
        socketPort: UInt16,
        frontendPort: UInt16
    ) -> [StartCommand] {
        let fallback = StartCommand(
            label: "dev",
            command: "npm run dev",
            port: frontendPort,
            environment: ["PORT": String(frontendPort)]
        )

        guard
            let data = try? Data(contentsOf: worktree.appendingPathComponent("package.json")),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let scripts = json["scripts"] as? [String: Any]
        else {
            return [fallback]
        }

        let packageManager = detectPackageManager(in: worktree)

        if let backendScript = scripts["dev:backend:swc"] as? String,
           let frontendScript = scripts["dev:frontend"] as? String {
            // Ports go in as *process* environment variables, not just via the env file:
            // Next.js reads the dev server port from the process env before it loads .env.
            return [
                StartCommand(
                    label: "backend",
                    command: strippingEnvironmentPrefix(backendScript),
                    port: backendPort,
                    environment: [
                        "SERVER_PORT": String(backendPort),
                        "SOCKET_PORT": String(socketPort),
                    ]
                ),
                StartCommand(
                    label: "frontend",
                    command: strippingEnvironmentPrefix(frontendScript),
                    port: frontendPort,
                    environment: [
                        "SERVER_PORT": String(backendPort),
                        "SOCKET_PORT": String(socketPort),
                        "PORT": String(frontendPort),
                    ]
                ),
            ]
        }

        let scriptName = scripts["dev"] != nil ? "dev" : (scripts["start"] != nil ? "start" : "dev")
        return [StartCommand(
            label: "dev",
            command: "\(packageManager) run \(scriptName)",
            port: frontendPort,
            environment: ["PORT": String(frontendPort)]
        )]
    }

    /// `SERVER_PORT=3003 SOCKET_PORT=3003 pnpm -r dev` → `pnpm -r dev`.
    /// We set those ourselves, from the allocation above.
    static func strippingEnvironmentPrefix(_ script: String) -> String {
        var parts: [Substring] = []
        var reachedCommand = false
        for part in script.split(whereSeparator: \.isWhitespace) {
            if !reachedCommand && part.contains("=") { continue }
            reachedCommand = true
            parts.append(part)
        }
        return parts.joined(separator: " ")
    }

    static func detectPackageManager(in worktree: URL) -> String {
        let exists = { (name: String) in
            FileManager.default.fileExists(atPath: worktree.appendingPathComponent(name).path)
        }
        if exists("pnpm-lock.yaml") { return "pnpm" }
        if exists("yarn.lock") { return "yarn" }
        if exists("bun.lock") || exists("bun.lockb") { return "bun" }
        return "npm"
    }

    private static func ensureDependencies(in worktree: URL, branch: String) throws {
        guard !FileManager.default.fileExists(atPath: worktree.appendingPathComponent("node_modules").path) else {
            return
        }
        let manager = detectPackageManager(in: worktree)
        note(branch, "Installing dependencies — first run for this worktree, expect several minutes")
        guard try runStreaming("\(manager) install", cwd: worktree, branch: branch, label: "dev") else {
            throw TeaBranchError("Dependency install failed — see the log for what \(manager) said.")
        }
    }

    // MARK: - Progress narration

    /// Say what the start is doing, in the branch's own log.
    ///
    /// Everything between clicking Start and the dev server's first line — reclaiming ports,
    /// `pnpm install`, provisioning the database — used to happen in complete silence, so a start
    /// that legitimately takes four minutes was indistinguishable from one that had hung. The log
    /// pane sat on "Waiting for output…" the whole time. These lines are that missing output.
    private static func note(_ branch: String, _ message: String) {
        AppState.shared.logs.append(branch: branch, text: "[dev] \u{001B}[36m▸\u{001B}[0m \(message)")
    }

    /// Run a command to completion with its output streamed into the branch log as it arrives.
    ///
    /// `Shell.sh` would block and hand back the output only at the end, which for `pnpm install`
    /// means several minutes of nothing followed by a wall of text.
    @discardableResult
    private static func runStreaming(
        _ command: String,
        cwd: URL,
        branch: String,
        label: String
    ) throws -> Bool {
        let child = try Spawn.shell(command: command, cwd: cwd.path)
        let tag = "[\(label)] "
        let append: (String) -> Void = { line in
            AppState.shared.logs.append(branch: branch, text: tag + line)
        }
        child.standardOutput.streamLines(append)
        child.standardError.streamLines(append)

        let finished = DispatchSemaphore(value: 0)
        let outcome = Mutex(false)
        Spawn.reap(pid: child.pid) { reason in
            outcome.set(reason.isClean)
            finished.signal()
        }
        finished.wait()
        return outcome.get()
    }

    /// Minimal box so the reap callback's result can cross back to this thread.
    private final class Mutex: @unchecked Sendable {
        private let lock = NSLock()
        private var value: Bool
        init(_ value: Bool) { self.value = value }
        func set(_ newValue: Bool) { lock.lock(); value = newValue; lock.unlock() }
        func get() -> Bool { lock.lock(); defer { lock.unlock() }; return value }
    }

    // MARK: - Spawning

    @discardableResult
    private static func spawn(_ command: StartCommand, branch: String, worktree: URL) throws -> pid_t {
        Log.info("""
            spawn: branch=\(branch), label=\(command.label), cmd='\(command.command)', \
            dir=\(worktree.path), port=\(command.port)
            """)

        var environment = command.environment
        // Cap Node's heap so a watch-mode rebuild loop can't eat the machine. Append rather
        // than overwrite, in case the user already set NODE_OPTIONS.
        let existingNodeOptions = ProcessInfo.processInfo.environment["NODE_OPTIONS"] ?? ""
        if !existingNodeOptions.contains("--max-old-space-size") {
            environment["NODE_OPTIONS"] = existingNodeOptions.isEmpty
                ? "--max-old-space-size=768"
                : "\(existingNodeOptions) --max-old-space-size=768"
        }

        let child = try Spawn.shell(command: command.command, cwd: worktree.path, extraEnv: environment)
        let tag = "[\(command.label)] "

        let append: (String) -> Void = { line in
            AppState.shared.logs.append(branch: branch, text: tag + line)
        }
        child.standardOutput.streamLines(append)
        child.standardError.streamLines(append)

        Spawn.reap(pid: child.pid) { reason in
            Log.info("process exited: branch=\(branch), label=\(command.label), \(reason.description)")

            // Surface the exit in the log stream under the right per-source tab. Without this a
            // single process crashing (the frontend dying while the backend keeps going) is
            // invisible — the log just goes quiet.
            AppState.shared.logs.append(branch: branch, text: "\(tag)⚠️  process \(reason.description)")

            let state = AppState.shared
            state.removePID(branch: branch, label: command.label)
            if !state.isManagingProcesses(branch: branch) {
                state.mutateEnvironment(branch) { environment in
                    if environment.status == .running { environment.status = .error }
                }
            }
            AppEvents.post(.environmentsChanged)
        }

        AppState.shared.setPID(child.pid, branch: branch, label: command.label)
        return child.pid
    }

    // MARK: - Health watchdog

    /// How long a process gets to bring its port up after (re)spawn. First compiles of the
    /// backend take minutes, so this is generous.
    private static let bootGrace: TimeInterval = 300
    private static let tick: TimeInterval = 10
    /// Failed probes tolerated once the port has been seen up — watch-mode rebuilds drop it.
    private static let missLimit = 9
    private static let maxRestarts = 3

    private final class WatchedProcess {
        let command: StartCommand
        var spawnedAt = Date()
        var everUp = false
        var misses = 0
        var upStreak = 0
        var restarts = 0
        var gaveUp = false

        init(command: StartCommand) { self.command = command }
    }

    /// Supervise by PORT, not just by PID.
    ///
    /// A dev-server wrapper (`nest start -w`) happily outlives its crashed inner app, leaving a
    /// live process with a dead port — invisible to the exit monitor. So: if a port never comes
    /// up within the boot grace, or goes dark long enough while the process is alive, or the
    /// process dies outright, restart that one command (bounded) and say so in the log.
    private static func startWatchdog(
        branch: String,
        worktree: URL,
        commands: [StartCommand],
        generation: UInt64
    ) {
        let watched = commands.map(WatchedProcess.init)

        Thread.detachNewThread {
            while true {
                Thread.sleep(forTimeInterval: tick)

                let state = AppState.shared
                // Retire when superseded by a newer start/stop, or when the branch is stopped.
                guard state.watchdogGeneration(branch: branch) == generation else { return }
                guard let status = state.environment(branch)?.status, status != .stopped else { return }

                for process in watched where !process.gaveUp {
                    step(process, branch: branch, worktree: worktree)
                }
            }
        }
    }

    private static func step(_ process: WatchedProcess, branch: String, worktree: URL) {
        let state = AppState.shared
        let listening = Ports.isListening(process.command.port)
        let pidAlive = state.hasPID(branch: branch, label: process.command.label)

        if listening {
            process.everUp = true
            process.misses = 0
            process.upStreak += 1
            // Healthy for a minute — forgive past restarts.
            if process.upStreak >= 6 { process.restarts = 0 }
            return
        }
        process.upStreak = 0

        let unhealthy: Bool
        if !pidAlive {
            unhealthy = true // Gone entirely; the exit monitor already logged it.
        } else if !process.everUp {
            unhealthy = Date().timeIntervalSince(process.spawnedAt) > bootGrace
        } else {
            process.misses += 1
            unhealthy = process.misses >= missLimit
        }
        guard unhealthy else { return }

        if process.restarts >= maxRestarts {
            process.gaveUp = true
            watchdogLog(
                branch: branch,
                label: process.command.label,
                "port \(process.command.port) still dead after \(process.restarts) restarts — giving up, check the logs above"
            )
            state.mutateEnvironment(branch) { $0.status = .error }
            AppEvents.post(.environmentsChanged)
            return
        }

        process.restarts += 1
        let reason: String
        if !pidAlive {
            reason = "process exited"
        } else if !process.everUp {
            reason = "port \(process.command.port) never came up (process alive but not serving)"
        } else {
            reason = "port \(process.command.port) went dark while the process kept running"
        }
        watchdogLog(
            branch: branch,
            label: process.command.label,
            "\(reason) — auto-restarting (\(process.restarts)/\(maxRestarts))"
        )

        if let pid = state.removePID(branch: branch, label: process.command.label) {
            killpg(pid, SIGTERM)
        }
        Ports.reclaim(port: process.command.port)

        do {
            try spawn(process.command, branch: branch, worktree: worktree)
            process.spawnedAt = Date()
            process.everUp = false
            process.misses = 0
            state.mutateEnvironment(branch) { $0.status = .running }
            AppEvents.post(.environmentsChanged)
        } catch {
            watchdogLog(
                branch: branch,
                label: process.command.label,
                "restart failed: \(error.localizedDescription)"
            )
        }
    }

    private static func watchdogLog(branch: String, label: String, _ message: String) {
        Log.info("watchdog: branch=\(branch), label=\(label): \(message)")
        AppState.shared.logs.append(branch: branch, text: "[\(label)] 🩺 TeaBranch watchdog: \(message)")
    }

    // MARK: - Stop

    /// Stop a branch and *wait until it is actually stopped*.
    ///
    /// This used to fire SIGTERM, immediately declare the branch stopped, and escalate three
    /// seconds later from a detached block. Two things then went wrong at once:
    ///
    ///  - `takePIDs` had already emptied our PID table, so `isManagingProcesses` went false and
    ///    the 6-second reconcile loop adopted the branch. Reconcile reads the ports out of the
    ///    worktree's own env file, saw the still-dying server answering, and set it back to
    ///    Running. The user saw Stop do nothing.
    ///  - A worktree recovered as an *orphan* has no PIDs of ours at all, so the SIGTERM pass was
    ///    a no-op and only the delayed port kill could touch it.
    ///
    /// So: hold a suppression flag the reconcile loop respects, kill by process group *and* by
    /// port, block until the ports are free, and throw if they never are. Stop is slow now — it
    /// is bounded by how long the dev server takes to die — but it is honest, and it runs on
    /// `ProcessManager.queue`, never on the main thread.
    static func stop(branch: String) throws {
        try withBranchLock(branch) { try performStop(branch: branch) }
    }

    private static func performStop(branch: String) throws {
        let state = AppState.shared

        // Nothing running means nothing to tear down. This guard is what keeps Delete safe: a
        // stopped branch has no recorded ports, and reclaiming the ones named in its env file
        // would SIGKILL whatever unrelated process happens to hold them today.
        let isLive = state.environment(branch)?.status.isLive ?? false
        guard isLive || state.isManagingProcesses(branch: branch) else {
            state.mutateEnvironment(branch) { $0.status = .stopped }
            return
        }

        // Retire the watchdog before tearing anything down, so it can't read an intentional
        // stop as a crash and respawn what we're killing.
        state.bumpWatchdogGeneration(branch: branch)
        state.beginStopping(branch: branch)
        defer { state.endStopping(branch: branch) }

        let ports = portsToReclaim(branch: branch)
        let pids = state.takePIDs(branch: branch)
        for pid in pids {
            killpg(pid, SIGTERM)
        }

        // Reclaim escalates (SIGTERM → SIGKILL) and waits, and works by port — which is what
        // reaches an orphan, and what reaches a child that escaped its process group.
        var stuck: [(port: UInt16, holders: [pid_t])] = []
        for port in ports {
            let survivors = Ports.reclaim(port: port)
            if !survivors.isEmpty { stuck.append((port, survivors)) }
        }

        // `Ports.reclaim` is where the SIGTERM→SIGKILL grace period lives, and it only runs per
        // port. With no ports to wait on, the escalation below would follow SIGTERM instantly and
        // hard-kill a dev server before it could flush anything, so the wait happens here instead.
        if ports.isEmpty, !pids.isEmpty {
            for _ in 0..<12 {
                if !pids.contains(where: { killpg($0, 0) == 0 }) { break }
                Thread.sleep(forTimeInterval: 0.25)
            }
        }

        // Anything of ours still alive after all that gets the group SIGKILL.
        for pid in pids where killpg(pid, 0) == 0 {
            killpg(pid, SIGKILL)
        }

        guard stuck.isEmpty else {
            let detail = stuck
                .map { "port \($0.port) (pid \($0.holders.map(String.init).joined(separator: ", ")))" }
                .joined(separator: "; ")
            // Leave the status alone: the server really is still up, and reconcile reporting it as
            // Running is the truth. What was missing was anyone saying *why* Stop didn't take.
            state.logs.append(
                branch: branch,
                text: "[dev] ⛔️ TeaBranch: stop failed — still listening on \(detail) after SIGTERM and SIGKILL"
            )
            AppEvents.post(.environmentsChanged)
            throw TeaBranchError("Stop failed — still listening on \(detail).")
        }

        state.mutateEnvironment(branch) { environment in
            environment.status = .stopped
            environment.port = nil
            environment.backendPort = nil
            environment.socketPort = nil
        }
        // Logs deliberately survive a stop. You stop a server *because* something went wrong, and
        // wiping the output at that exact moment threw away the reason.

        AppEvents.post(.environmentsChanged)
    }

    /// Every port this branch might be holding.
    ///
    /// Prefers what we recorded when we started it, and falls back to the worktree's env file —
    /// which is the only record that exists for an orphan we merely adopted, and the same source
    /// the reconcile loop reads, so Stop and reconcile can no longer disagree about what to look at.
    private static func portsToReclaim(branch: String) -> [UInt16] {
        let state = AppState.shared
        let environment = state.environment(branch)

        let recorded = [environment?.port, environment?.backendPort, environment?.socketPort]
            .compactMap { $0 }
        if !recorded.isEmpty { return recorded }

        guard let path = environment?.worktreePath
                ?? state.projectURL.flatMap({ try? GitService.worktreePath(for: branch, in: $0).path })
        else { return [] }

        let overrides = EnvFile.overrides(in: URL(fileURLWithPath: path))
        return [overrides.port, overrides.serverPort, overrides.socketPort]
            .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
            .compactMap(UInt16.init)
    }

    /// Kill everything we started. Called on quit.
    static func cleanupAll() {
        let state = AppState.shared
        for pid in state.allPIDs() {
            killpg(pid, SIGKILL)
        }
        if let pid = state.ngrokPID {
            killpg(pid, SIGKILL)
        }
        for environment in state.environments where environment.status.isLive {
            [environment.port, environment.backendPort, environment.socketPort]
                .compactMap { $0 }
                .forEach { Ports.kill(port: $0) }
        }
    }

    // MARK: - Reconcile

    /// Detect dev servers running on a worktree's configured ports that we don't own — orphans
    /// left behind when TeaBranch was force-quit (a clean quit kills them via `cleanupAll`, a
    /// crash does not).
    ///
    /// For each worktree we are *not* actively managing, mark it Running if its frontend or
    /// backend port answers, and downgrade a previously-recovered environment to Stopped once
    /// its ports go away. Recovered environments have no captured stdout, so their logs don't
    /// backfill — but status and Stop (port-level kill) work. Safe to call repeatedly.
    static func reconcile() {
        let state = AppState.shared
        guard let repo = state.projectURL else { return }

        let listening = Ports.allListening()
        var changed = false

        for entry in GitService.worktrees(in: repo) {
            // Environments we manage belong to their own exit monitor.
            guard !state.isManagingProcesses(branch: entry.branch) else { continue }
            // A stop in flight has already emptied the PID table, so without this the branch looks
            // like an orphan and gets adopted — and its still-dying ports read as Running.
            guard !state.isStopping(branch: entry.branch) else { continue }

            let overrides = EnvFile.overrides(in: entry.path)
            let frontendPort = overrides.port.flatMap { UInt16($0.trimmingCharacters(in: .whitespaces)) }
            let backendPort = overrides.serverPort.flatMap { UInt16($0.trimmingCharacters(in: .whitespaces)) }
            let socketPort = overrides.socketPort.flatMap { UInt16($0.trimmingCharacters(in: .whitespaces)) }

            let live = (frontendPort.map(listening.contains) ?? false)
                || (backendPort.map(listening.contains) ?? false)

            let previousStatus = state.environment(entry.branch)?.status

            if live {
                if previousStatus != .running { changed = true }
                state.setEnvironment(BranchEnvironment(
                    branchName: entry.branch,
                    worktreePath: entry.path.path,
                    port: frontendPort,
                    backendPort: backendPort,
                    socketPort: socketPort,
                    status: .running,
                    databaseName: overrides.prismaDatabaseURL.flatMap { DatabaseURL.name(of: $0) }
                ))
            } else if previousStatus == .running {
                // A previously-recovered environment whose ports vanished — the orphan exited.
                state.mutateEnvironment(entry.branch) { environment in
                    environment.status = .stopped
                    environment.port = nil
                    environment.backendPort = nil
                    environment.socketPort = nil
                }
                changed = true
            }
        }

        if changed {
            AppEvents.post(.environmentsChanged)
        }
    }

    /// Background loop that keeps recovered/orphaned state in sync, mirroring the Rust build's
    /// 6-second reconcile thread.
    static func startReconcileLoop() {
        Thread.detachNewThread {
            Thread.sleep(forTimeInterval: 0.8)
            while true {
                reconcile()
                NgrokService.reconcile()
                Thread.sleep(forTimeInterval: 6)
            }
        }
    }
}
