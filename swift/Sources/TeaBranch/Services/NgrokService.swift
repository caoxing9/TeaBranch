import Darwin
import Foundation

/// The single ngrok tunnel the app manages (the free plan allows one agent at a time).
enum NgrokService {
    private static let startTimeout: TimeInterval = 25

    /// Pull the public URL out of ngrok's log stream.
    ///
    /// `t=… lvl=info msg="started tunnel" … addr=http://localhost:5103 url=https://abc.ngrok-free.app`
    static func publicURL(inLogLine line: String) -> String? {
        guard line.contains("started tunnel"), let range = line.range(of: " url=") else { return nil }
        let rest = line[range.upperBound...]
        let end = rest.firstIndex(where: \.isWhitespace) ?? rest.endIndex
        let url = String(rest[..<end])
        return url.hasPrefix("http://") || url.hasPrefix("https://") ? url : nil
    }

    /// Start a tunnel for a branch's SERVER_PORT and record it in the worktree's env file as
    /// SANDBOX_TEABLE_ENDPOINT. Blocks until ngrok reports the URL (or times out).
    static func start(branch: String) throws -> NgrokTunnel {
        let state = AppState.shared
        guard let repo = state.projectURL else {
            throw TeaBranchError("No project path set")
        }

        // Only one agent at a time — retire whatever is running first.
        if let existing = state.ngrokPID {
            Spawn.killGroup(existing)
            state.takeNgrok()
        }

        let worktree = try GitService.worktreePath(for: branch, in: repo)
        guard let portValue = EnvFile.value("SERVER_PORT", in: worktree) else {
            throw TeaBranchError("SERVER_PORT not found in worktree env file")
        }
        guard let port = UInt16(portValue.trimmingCharacters(in: .whitespaces)) else {
            throw TeaBranchError("Invalid SERVER_PORT '\(portValue)'")
        }

        state.ngrokLogs.clear(branch: AppState.ngrokLogKey)

        let child = try Spawn.tool("ngrok", ["http", String(port), "--log=stdout"])
        let pid = child.pid

        let urlBox = URLBox()
        child.standardOutput.streamLines { line in
            if let url = publicURL(inLogLine: line) { urlBox.deliver(url) }
            state.ngrokLogs.append(branch: AppState.ngrokLogKey, text: line)
        }
        child.standardError.streamLines { line in
            state.ngrokLogs.append(branch: AppState.ngrokLogKey, text: "[stderr] \(line)")
        }
        Spawn.reap(pid: pid) { reason in
            Log.info("ngrok exited: \(reason.description)")
        }

        guard let publicURL = urlBox.wait(timeout: startTimeout) else {
            Spawn.killGroup(pid)
            throw TeaBranchError("Timed out waiting for ngrok tunnel")
        }

        // Point the sandbox at the tunnel. Failing here shouldn't kill the tunnel we just got.
        var overrides = WorktreeEnvOverrides.empty
        overrides.sandboxTeableEndpoint = publicURL
        do {
            try EnvFile.writeOverrides(overrides, in: worktree)
        } catch {
            Log.warn("tunnel started but failed to update env file: \(error.localizedDescription)")
        }

        let tunnel = NgrokTunnel(branchName: branch, port: port, publicURL: publicURL)
        state.ngrokPID = pid
        state.ngrokTunnel = tunnel
        AppEvents.post(.ngrokChanged)
        return tunnel
    }

    static func stop() {
        let (pid, _) = AppState.shared.takeNgrok()
        if let pid { Spawn.killGroup(pid) }
        AppEvents.post(.ngrokChanged)
    }

    /// Recover (or clear) a tunnel that may still be running, e.g. after a force-quit.
    ///
    /// The local agent API at 127.0.0.1:4040 is the source of truth: if a tunnel is up we adopt
    /// it, and if the agent is gone we drop the one we were tracking. Safe to call repeatedly.
    static func reconcile() {
        let state = AppState.shared
        let response = Shell.run("curl", ["-s", "--max-time", "2", "http://127.0.0.1:4040/api/tunnels"])

        guard response.ok, !response.stdout.isEmpty else {
            clearStaleTunnel()
            return
        }
        guard
            let data = response.stdout.data(using: .utf8),
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let tunnels = payload["tunnels"] as? [[String: Any]]
        else {
            return
        }

        let tunnel = tunnels.first { ($0["public_url"] as? String)?.hasPrefix("https") == true } ?? tunnels.first
        guard let tunnel, let publicURL = tunnel["public_url"] as? String, !publicURL.isEmpty else {
            clearStaleTunnel()
            return
        }
        // Already tracking this exact tunnel.
        if state.ngrokTunnel?.publicURL == publicURL { return }

        let localPort = (tunnel["config"] as? [String: Any])
            .flatMap { $0["addr"] as? String }
            .flatMap { $0.split(separator: ":").last.flatMap { UInt16($0) } } ?? 0

        let branch = state.projectURL
            .flatMap { GitService.branch(forServerPort: localPort, in: $0) } ?? ""

        state.ngrokPID = firstPID(named: "ngrok")
        state.ngrokTunnel = NgrokTunnel(branchName: branch, port: localPort, publicURL: publicURL)
        AppEvents.post(.ngrokChanged)
    }

    private static func clearStaleTunnel() {
        let (_, tunnel) = AppState.shared.takeNgrok()
        if tunnel != nil {
            AppEvents.post(.ngrokChanged)
        }
    }

    private static func firstPID(named name: String) -> pid_t? {
        Shell.run("pgrep", ["-x", name]).stdout
            .split(whereSeparator: \.isWhitespace)
            .first
            .flatMap { pid_t($0) }
    }

    /// One-shot rendezvous between the log-reader thread and the caller waiting for the URL.
    private final class URLBox: @unchecked Sendable {
        private let semaphore = DispatchSemaphore(value: 0)
        private let lock = NSLock()
        private var url: String?
        private var delivered = false

        func deliver(_ value: String) {
            lock.lock()
            defer { lock.unlock() }
            guard !delivered else { return }
            delivered = true
            url = value
            semaphore.signal()
        }

        func wait(timeout: TimeInterval) -> String? {
            guard semaphore.wait(timeout: .now() + timeout) == .success else { return nil }
            lock.lock()
            defer { lock.unlock() }
            return url
        }
    }
}
