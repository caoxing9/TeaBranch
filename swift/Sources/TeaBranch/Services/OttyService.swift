import AppKit
import Foundation

/// Otty integration, driven through its bundled `otty-cli` control socket.
///
/// Every other terminal in `TerminalService` is reached by faking keystrokes: activate the app,
/// send ⌘T through System Events, type a `cd` line. That needs Accessibility permission, races the
/// app's own startup, and silently types into the wrong window if focus moves. Otty ships a real
/// control CLI, so none of that applies here — a tab is created by asking for one, with its working
/// directory and command supplied up front, and the result is reported back.
///
/// It is also the only terminal we can *read*: `tab list` reports each tab's cwd, which is what
/// lets a branch row show that it already has a terminal (and an agent) open on its worktree.
enum OttyService {
    static let bundleIdentifier = "io.appmakes.otty"

    struct Tab: Hashable, Sendable {
        let id: String
        let cwd: String
        let title: String
        /// Name of the foreground process, when Otty reports one.
        let process: String
    }

    // MARK: - Discovery

    /// The app bundle, wherever it is installed.
    static var appURL: URL? {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier)
    }

    /// The bundled control CLI. Not looked up on `PATH`: the shim users install there is a
    /// per-session wrapper in a temp directory, while this one is always present and always
    /// matches the installed app.
    static var cliPath: String? {
        guard let appURL else { return nil }
        let cli = appURL.appendingPathComponent("Contents/MacOS/otty-cli")
        return FileManager.default.isExecutableFile(atPath: cli.path) ? cli.path : nil
    }

    static var isInstalled: Bool { cliPath != nil }

    static var isRunning: Bool {
        NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == bundleIdentifier }
    }

    // MARK: - Opening

    /// Open `path` in a tab, optionally running `command` in it.
    ///
    /// A running instance gets a new tab; a cold one gets a window, because `tab new` talks to a
    /// control socket that does not exist yet. Both carry the cwd and command, so the caller does
    /// not have to type a `cd` into a shell and hope.
    static func open(path: String, title: String, command: String? = nil) throws {
        guard let cliPath else {
            throw TeaBranchError("Otty is not installed.")
        }

        var arguments: [String]
        if isRunning {
            arguments = ["tab", "new", "--cwd", path, "--title", title]
        } else {
            arguments = ["open", path, "--title", title]
        }
        if let command, !command.isEmpty {
            arguments += ["--command", command]
        }

        let result = Shell.run(cliPath, arguments)
        guard result.ok else {
            throw TeaBranchError(
                "Otty refused the request: \(result.stderr.trimmingCharacters(in: .whitespacesAndNewlines))"
            )
        }
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier).map {
            NSWorkspace.shared.openApplication(at: $0, configuration: .init())
        }
    }

    // MARK: - Reading

    /// Every open tab, or `[]` when Otty isn't running (its control socket only exists then).
    ///
    /// Blocking — call it off the main thread.
    static func tabs() -> [Tab] {
        guard let cliPath, isRunning else { return [] }

        let result = Shell.run(cliPath, ["tab", "list", "--json"])
        guard result.ok, let data = result.stdout.data(using: .utf8) else { return [] }

        struct Payload: Decodable {
            struct Entry: Decodable {
                var id: String
                var cwd: String?
                var title: String?
                var process: String?
            }
            var data: [Entry]
        }

        guard let payload = try? JSONDecoder().decode(Payload.self, from: data) else { return [] }
        return payload.data.map {
            Tab(
                id: $0.id,
                cwd: $0.cwd ?? "",
                title: $0.title ?? "",
                process: $0.process ?? ""
            )
        }
    }

    /// Worktree paths that currently have at least one Otty tab open on them.
    ///
    /// Compared by resolved path so a tab opened through a symlink still matches the worktree git
    /// reported. A tab sitting in a *subdirectory* of the worktree counts too — you are still
    /// working on that branch when you have cd'd into `apps/nextjs-app`.
    static func openWorktreePaths(among worktrees: [String]) -> Set<String> {
        let tabs = tabs()
        guard !tabs.isEmpty else { return [] }

        let cwds = tabs.map { URL(fileURLWithPath: $0.cwd).standardizedFileURL.path }
        var matched: Set<String> = []

        for worktree in worktrees {
            let root = URL(fileURLWithPath: worktree).standardizedFileURL.path
            if cwds.contains(where: { $0 == root || $0.hasPrefix(root + "/") }) {
                matched.insert(worktree)
            }
        }
        return matched
    }
}
