import Foundation

struct CommandResult {
    let status: Int32
    let stdout: String
    let stderr: String

    var ok: Bool { status == 0 }
    var trimmedOut: String { stdout.trimmingCharacters(in: .whitespacesAndNewlines) }
}

/// Blocking command execution with the user's real PATH.
///
/// A bundled macOS app inherits launchd's minimal PATH, not the one from the user's shell
/// profile, so `git` / `pnpm` / `psql` / `ngrok` would all be missing. We resolve the login
/// shell's PATH once and hand it to every child process.
enum Shell {
    /// The user's PATH as reported by their login shell. Resolved once, lazily.
    static let userPath: String = resolveUserPath()

    /// Run an executable, resolved through PATH, and capture its output.
    @discardableResult
    static func run(
        _ executable: String,
        _ arguments: [String],
        cwd: URL? = nil,
        extraEnv: [String: String] = [:]
    ) -> CommandResult {
        capture(executable: "/usr/bin/env", arguments: [executable] + arguments, cwd: cwd, extraEnv: extraEnv)
    }

    /// Run a shell command string (`sh -c`) and capture its output.
    @discardableResult
    static func sh(_ command: String, cwd: URL? = nil, extraEnv: [String: String] = [:]) -> CommandResult {
        capture(executable: "/bin/sh", arguments: ["-c", command], cwd: cwd, extraEnv: extraEnv)
    }

    /// Run `git` inside a repository.
    @discardableResult
    static func git(_ arguments: [String], cwd: URL) -> CommandResult {
        run("git", arguments, cwd: cwd)
    }

    /// The environment handed to every child: the process environment with PATH replaced.
    static func childEnvironment(extra: [String: String] = [:]) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = userPath
        for (key, value) in extra { env[key] = value }
        return env
    }

    // MARK: - Internals

    /// A fresh /dev/null handle per child, never `FileHandle.nullDevice` — the singleton is
    /// shared process-wide and closing it (see below) would break every other caller.
    private static func nullDevice(forReading: Bool) -> FileHandle? {
        forReading
            ? FileHandle(forReadingAtPath: "/dev/null")
            : FileHandle(forWritingAtPath: "/dev/null")
    }

    private static func capture(
        executable: String,
        arguments: [String],
        cwd: URL?,
        extraEnv: [String: String]
    ) -> CommandResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = childEnvironment(extra: extraEnv)
        if let cwd { process.currentDirectoryURL = cwd }

        let outPipe = Pipe()
        let errPipe = Pipe()
        let stdinHandle = nullDevice(forReading: true)
        process.standardOutput = outPipe
        process.standardError = errPipe
        process.standardInput = stdinHandle as Any

        // Foundation closes the child-side write ends once the child is up, but the parent's
        // read ends and this stdin handle are ours to close — and nothing else ever will.
        // Leaking three descriptors per command is fatal here: the reconcile loop alone runs
        // several commands every few seconds, and a GUI app starts with a 256 descriptor
        // budget, so the app would start failing to spawn anything within a minute.
        defer {
            try? outPipe.fileHandleForReading.close()
            try? errPipe.fileHandleForReading.close()
            try? stdinHandle?.close()
        }

        do {
            try process.run()
        } catch {
            return CommandResult(status: -1, stdout: "", stderr: "Failed to run \(executable): \(error.localizedDescription)")
        }

        // Drain both pipes concurrently — reading them in sequence deadlocks as soon as a
        // child fills the other pipe's buffer.
        var outData = Data()
        var errData = Data()
        let group = DispatchGroup()
        DispatchQueue.global().async(group: group) {
            outData = outPipe.fileHandleForReading.readDataToEndOfFile()
        }
        DispatchQueue.global().async(group: group) {
            errData = errPipe.fileHandleForReading.readDataToEndOfFile()
        }
        group.wait()
        process.waitUntilExit()

        return CommandResult(
            status: process.terminationStatus,
            stdout: String(decoding: outData, as: UTF8.self),
            stderr: String(decoding: errData, as: UTF8.self)
        )
    }

    private static func resolveUserPath() -> String {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"

        if let path = probePath(shell, ["-lic", "echo $PATH"]) {
            Log.info("Resolved user PATH from \(shell)")
            return path
        }
        if shell != "/bin/bash", let path = probePath("/bin/bash", ["-lc", "echo $PATH"]) {
            Log.info("Resolved user PATH from /bin/bash")
            return path
        }

        Log.warn("Could not resolve user PATH, using the inherited one")
        return ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"
    }

    private static func probePath(_ shell: String, _ arguments: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: shell)
        process.arguments = arguments
        let stdinHandle = nullDevice(forReading: true)
        let stderrHandle = nullDevice(forReading: false)
        process.standardInput = stdinHandle as Any
        process.standardError = stderrHandle as Any
        let pipe = Pipe()
        process.standardOutput = pipe

        defer {
            try? pipe.fileHandleForReading.close()
            try? stdinHandle?.close()
            try? stderrHandle?.close()
        }

        do {
            try process.run()
        } catch {
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        let path = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return path.isEmpty ? nil : path
    }
}

extension String {
    /// Quote a path/value for safe interpolation into a `sh -c` command string.
    var shellQuoted: String {
        "'" + replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
