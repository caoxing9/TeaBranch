import Darwin
import Foundation

/// A long-lived child process (a dev server, an ngrok agent) with its output piped back.
final class ChildProcess {
    let pid: pid_t
    let standardOutput: FileHandle
    let standardError: FileHandle

    init(pid: pid_t, standardOutput: FileHandle, standardError: FileHandle) {
        self.pid = pid
        self.standardOutput = standardOutput
        self.standardError = standardError
    }
}

enum SpawnError: LocalizedError {
    case pipeFailed(Int32)
    case spawnFailed(String, Int32)

    var errorDescription: String? {
        switch self {
        case .pipeFailed(let code):
            return "Failed to create pipe (errno \(code))"
        case .spawnFailed(let command, let code):
            return "Failed to start \(command): \(String(cString: strerror(code)))"
        }
    }
}

/// Starting detached child processes.
///
/// `Foundation.Process` cannot put a child into its own process group, and that is the whole
/// trick behind stopping a dev server: `pnpm dev` forks a tree of node processes, and only
/// `killpg` on a dedicated group takes the whole tree down. So we go straight to `posix_spawn`
/// with `POSIX_SPAWN_SETPGROUP`, which makes the child its own group leader (pgid == pid).
enum Spawn {
    /// Run `command` under `/bin/sh` from `cwd`, in a fresh process group, with stdin on
    /// /dev/null and stdout/stderr piped back.
    ///
    /// stdin matters: `next dev` turns on interactive keypress handling when stdin looks like
    /// a TTY and exits cleanly the moment it hits EOF — which is why the frontend used to die
    /// right after printing "Ready" while the backend survived.
    static func shell(
        command: String,
        cwd: String,
        extraEnv: [String: String] = [:]
    ) throws -> ChildProcess {
        // `cd` inside the shell rather than posix_spawn's chdir file action: the _np spelling
        // is deprecated on recent SDKs and the non-suffixed one is too new for our floor.
        let script = "cd -- \(cwd.shellQuoted) || exit 127\n\(command)"
        return try spawn(arguments: ["/bin/sh", "-c", script], extraEnv: extraEnv, label: command)
    }

    /// Run an executable resolved through PATH, in a fresh process group, with piped output.
    static func tool(
        _ executable: String,
        _ arguments: [String],
        extraEnv: [String: String] = [:]
    ) throws -> ChildProcess {
        try spawn(arguments: ["/usr/bin/env", executable] + arguments, extraEnv: extraEnv, label: executable)
    }

    /// Reap a child in the background and report how it exited. Without this, finished dev
    /// servers linger as zombies for the lifetime of the app.
    static func reap(pid: pid_t, onExit: @escaping (ExitReason) -> Void) {
        Thread.detachNewThread {
            var status: Int32 = 0
            while waitpid(pid, &status, 0) < 0 {
                if errno != EINTR { onExit(.unknown); return }
            }
            onExit(.from(status: status))
        }
    }

    enum ExitReason {
        case code(Int32)
        case signal(Int32)
        case unknown

        static func from(status: Int32) -> ExitReason {
            // WIFEXITED / WEXITSTATUS / WTERMSIG are C macros, unavailable to Swift.
            if status & 0x7F == 0 { return .code((status >> 8) & 0xFF) }
            if status & 0x7F != 0x7F { return .signal(status & 0x7F) }
            return .unknown
        }

        var isClean: Bool {
            if case .code(0) = self { return true }
            return false
        }

        var description: String {
            switch self {
            case .code(0): return "exited cleanly"
            case .code(let code): return "exited with code \(code)"
            case .signal(let signal): return "terminated by signal \(signal)"
            case .unknown: return "exited for an unknown reason"
            }
        }
    }

    /// SIGTERM the whole process group, then SIGKILL what is left.
    static func killGroup(_ pid: pid_t, graceSeconds: Double = 0.3) {
        killpg(pid, SIGTERM)
        DispatchQueue.global().asyncAfter(deadline: .now() + graceSeconds) {
            killpg(pid, SIGKILL)
        }
    }

    /// Raise this process's file-descriptor soft limit; children inherit it.
    ///
    /// GUI apps inherit `launchctl limit maxfiles` (256 by default), far too low for
    /// webpack/swc/chokidar dev servers — they hang silently on first compile with EMFILE.
    static func raiseFileDescriptorLimit() {
        var limit = rlimit()
        guard getrlimit(RLIMIT_NOFILE, &limit) == 0 else { return }
        let target = min(limit.rlim_max, 65536)
        guard limit.rlim_cur < target else { return }
        limit.rlim_cur = target
        if setrlimit(RLIMIT_NOFILE, &limit) == 0 {
            Log.info("Raised RLIMIT_NOFILE to \(target)")
        }
    }

    // MARK: - Internals

    private static func spawn(
        arguments: [String],
        extraEnv: [String: String],
        label: String
    ) throws -> ChildProcess {
        var outPipe: [Int32] = [-1, -1]
        var errPipe: [Int32] = [-1, -1]
        guard pipe(&outPipe) == 0 else { throw SpawnError.pipeFailed(errno) }
        guard pipe(&errPipe) == 0 else {
            close(outPipe[0]); close(outPipe[1])
            throw SpawnError.pipeFailed(errno)
        }

        var fileActions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&fileActions)
        posix_spawn_file_actions_addopen(&fileActions, STDIN_FILENO, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&fileActions, outPipe[1], STDOUT_FILENO)
        posix_spawn_file_actions_adddup2(&fileActions, errPipe[1], STDERR_FILENO)
        posix_spawn_file_actions_addclose(&fileActions, outPipe[0])
        posix_spawn_file_actions_addclose(&fileActions, errPipe[0])

        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP))
        posix_spawnattr_setpgroup(&attributes, 0)

        let environment = Shell.childEnvironment(extra: extraEnv).map { "\($0.key)=\($0.value)" }

        var argv: [UnsafeMutablePointer<CChar>?] = arguments.map { strdup($0) }
        argv.append(nil)
        var envp: [UnsafeMutablePointer<CChar>?] = environment.map { strdup($0) }
        envp.append(nil)

        defer {
            argv.forEach { free($0) }
            envp.forEach { free($0) }
            posix_spawn_file_actions_destroy(&fileActions)
            posix_spawnattr_destroy(&attributes)
            close(outPipe[1])
            close(errPipe[1])
        }

        var pid: pid_t = 0
        let result = posix_spawn(&pid, arguments[0], &fileActions, &attributes, &argv, &envp)
        guard result == 0 else {
            close(outPipe[0])
            close(errPipe[0])
            throw SpawnError.spawnFailed(label, result)
        }

        return ChildProcess(
            pid: pid,
            standardOutput: FileHandle(fileDescriptor: outPipe[0], closeOnDealloc: true),
            standardError: FileHandle(fileDescriptor: errPipe[0], closeOnDealloc: true)
        )
    }
}

extension FileHandle {
    /// Read the handle to EOF on a dedicated thread, invoking `onLine` for each complete line.
    func streamLines(_ onLine: @escaping (String) -> Void) {
        Thread.detachNewThread { [self] in
            var pending = Data()
            while true {
                let chunk = (try? read(upToCount: 8192)) ?? Data()
                if chunk.isEmpty { break }
                pending.append(chunk)
                while let newline = pending.firstIndex(of: 0x0A) {
                    let lineData = pending[pending.startIndex..<newline]
                    pending.removeSubrange(pending.startIndex...newline)
                    var line = String(decoding: lineData, as: UTF8.self)
                    if line.hasSuffix("\r") { line.removeLast() }
                    onLine(line)
                }
            }
            if !pending.isEmpty {
                onLine(String(decoding: pending, as: UTF8.self))
            }
            // No explicit close: the handle owns its descriptor (`closeOnDealloc`), and closing
            // twice would shut down whatever unrelated file inherited the recycled fd number.
        }
    }
}
