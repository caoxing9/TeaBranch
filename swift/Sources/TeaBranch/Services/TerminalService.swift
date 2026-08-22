import AppKit
import Foundation

/// Opening a worktree in an external editor or terminal.
///
/// Terminals get a **new tab** in the already-running instance rather than a new window.
/// How that is done depends on what the app exposes:
///   - Otty has a real control CLI — a tab is requested, with cwd and command supplied. No
///     Accessibility permission, no keystroke faking, and it reports failure. See `OttyService`.
///   - Warp has a URL scheme (`warp://action/new_tab?path=…`) — no permissions either.
///   - iTerm has a real AppleScript dictionary — `create tab with default profile`.
///   - Terminal, Ghostty and Kero have no tab API, so we drive ⌘T through System Events,
///     which needs Accessibility permission for TeaBranch.
///   - Everything else falls back to `open -a`, which opens a window.
///
/// Only the first of those can also run a *command* in the new tab reliably, which is what the
/// agent action needs — see `openAgent`.
enum TerminalService {
    struct Preset: Hashable, Identifiable {
        /// `nil` means "system default", stored as no value in settings.
        let value: String?
        let label: String
        /// Whether we can put the worktree in a new tab of the running instance.
        let supportsTabs: Bool
        /// Whether we can start a command in that tab without typing it as keystrokes.
        var supportsCommands: Bool = false

        var id: String { value ?? "" }
    }

    static let presets: [Preset] = [
        Preset(value: "Otty", label: "Otty", supportsTabs: true, supportsCommands: true),
        Preset(value: nil, label: "System Default (Terminal)", supportsTabs: true),
        Preset(value: "Warp", label: "Warp", supportsTabs: true),
        Preset(value: "iTerm", label: "iTerm", supportsTabs: true, supportsCommands: true),
        Preset(value: "Ghostty", label: "Ghostty", supportsTabs: true),
        Preset(value: "Kero", label: "Kero", supportsTabs: true),
        Preset(value: "Alacritty", label: "Alacritty", supportsTabs: false),
        Preset(value: "Kitty", label: "Kitty", supportsTabs: false),
        Preset(value: "Hyper", label: "Hyper", supportsTabs: false),
    ]

    /// Terminals that are Ghostty (or a fork of it): same CLI flags, same lack of a tab API.
    private static let ghosttyFamily = ["ghostty", "kero"]

    static func isOtty(_ app: String?) -> Bool {
        app?.caseInsensitiveCompare("Otty") == .orderedSame
    }

    // MARK: - Terminal

    static func openTerminal(at path: String, using app: String?, title: String) throws {
        try open(at: path, using: app, title: title, command: nil)
    }

    /// Open the worktree and start the coding agent in it.
    ///
    /// The command is run by the terminal itself rather than typed in, so it does not depend on
    /// shell aliases resolving in a non-interactive context — `cc` is an alias in the user's
    /// zshrc and would not exist here, so settings carry the expanded command.
    static func openAgent(at path: String, using app: String?, title: String, command: String) throws {
        guard !command.trimmingCharacters(in: .whitespaces).isEmpty else {
            throw TeaBranchError("No agent command configured — set one in Settings.")
        }
        try open(at: path, using: app, title: title, command: command)
    }

    /// Whether `app` can start a command in a new tab for us.
    static func canRunCommands(in app: String?) -> Bool {
        guard let app, !app.isEmpty else { return false }
        if isOtty(app) { return OttyService.isInstalled }
        return presets.first { $0.value?.caseInsensitiveCompare(app) == .orderedSame }?
            .supportsCommands ?? false
    }

    private static func open(at path: String, using app: String?, title: String, command: String?) throws {
        guard FileManager.default.fileExists(atPath: path) else {
            throw TeaBranchError("Path does not exist: \(path)")
        }

        if isOtty(app) {
            try OttyService.open(path: path, title: title, command: command)
            return
        }

        // Every remaining terminal is driven by keystrokes or opens a bare window, so a command
        // can only be delivered by appending it to the `cd` line we type.
        guard let app, !app.isEmpty else {
            try openSystemTerminal(at: path, command: command)
            return
        }

        if app.caseInsensitiveCompare("Warp") == .orderedSame {
            try openWarp(at: path)
        } else if app.caseInsensitiveCompare("iTerm") == .orderedSame
                    || app.caseInsensitiveCompare("iTerm2") == .orderedSame {
            try openITerm(at: path, command: command)
        } else if ghosttyFamily.contains(app.lowercased()) {
            try openGhosttyLike(app: app, at: path, command: command)
        } else {
            let result = Shell.run("open", ["-a", app, path])
            guard result.ok else {
                throw TeaBranchError("Failed to open \(app): \(result.stderr)")
            }
        }
    }

    /// Terminal.app: ⌘T for the tab, then `do script … in front window` to run in it.
    private static func openSystemTerminal(at path: String, command: String?) throws {
        let line = cdCommand(for: path, then: command)
        let script = """
        tell application "Terminal"
            activate
            if (count of windows) is 0 then
                do script "\(appleScriptLiteral(line))"
            else
                tell application "System Events" to keystroke "t" using {command down}
                delay 0.2
                do script "\(appleScriptLiteral(line))" in front window
            end if
        end tell
        """
        try runAppleScript(script, failureHint: "Terminal")
    }

    private static func openWarp(at path: String) throws {
        var components = URLComponents()
        components.scheme = "warp"
        components.host = "action"
        components.path = "/new_tab"
        components.queryItems = [URLQueryItem(name: "path", value: path)]

        guard let url = components.url else {
            throw TeaBranchError("Could not build a warp:// URL for \(path)")
        }
        guard NSWorkspace.shared.open(url) else {
            throw TeaBranchError("Failed to open Warp (is it installed?)")
        }
    }

    private static func openITerm(at path: String, command: String?) throws {
        let script = """
        tell application "iTerm"
            activate
            if (count of windows) is 0 then
                create window with default profile
            else
                tell current window to create tab with default profile
            end if
            tell current session of current window to write text "\(appleScriptLiteral(cdCommand(for: path, then: command)))"
        end tell
        """
        try runAppleScript(script, failureHint: "iTerm")
    }

    /// Ghostty and its forks (Kero) expose no IPC for tabs, so we drive the running instance:
    /// activate → ⌘T → type `cd <path> && clear` → Return. If it isn't running yet, launch it
    /// with `--working-directory`, which lands in the first window anyway.
    private static func openGhosttyLike(app: String, at path: String, command: String?) throws {
        guard isRunning(app: app) else {
            let result = Shell.run("open", ["-na", app, "--args", "--working-directory=\(path)"])
            guard result.ok else {
                throw TeaBranchError("Failed to open \(app): \(result.stderr)")
            }
            return
        }

        let script = """
        tell application "\(appleScriptLiteral(app))" to activate
        delay 0.15
        tell application "System Events"
            keystroke "t" using {command down}
            delay 0.12
            keystroke "\(appleScriptLiteral(cdCommand(for: path, then: command)))"
            keystroke return
        end tell
        """
        try runAppleScript(script, failureHint: app)
    }

    // MARK: - Editor

    static func openInVSCode(path: String) throws {
        let directory = URL(fileURLWithPath: path)

        // Prefer a .code-workspace in the worktree root so VS Code opens the multi-root
        // workspace instead of a plain folder.
        let workspace = (try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        ))?.first { $0.pathExtension == "code-workspace" }

        let target = workspace?.path ?? path
        let result = Shell.run("code", ["-n", target])
        guard result.ok else {
            throw TeaBranchError("Failed to open VS Code: \(result.stderr.isEmpty ? "is the `code` command installed?" : result.stderr)")
        }
    }

    // MARK: - Helpers

    private static func cdCommand(for path: String, then command: String? = nil) -> String {
        let base = "cd \(path.shellQuoted) && clear"
        guard let command, !command.trimmingCharacters(in: .whitespaces).isEmpty else { return base }
        return "\(base) && \(command)"
    }

    /// Escape a string for embedding in an AppleScript double-quoted literal.
    private static func appleScriptLiteral(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }

    private static func runAppleScript(_ script: String, failureHint: String) throws {
        let result = Shell.run("osascript", ["-e", script])
        guard result.ok else {
            throw TeaBranchError("""
                Failed to drive \(failureHint): \(result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)) \
                (grant Accessibility permission to TeaBranch in System Settings → Privacy & Security)
                """)
        }
    }

    private static func isRunning(app: String) -> Bool {
        NSWorkspace.shared.runningApplications.contains { running in
            if running.localizedName?.caseInsensitiveCompare(app) == .orderedSame { return true }
            let bundleName = running.bundleURL?.deletingPathExtension().lastPathComponent
            return bundleName?.caseInsensitiveCompare(app) == .orderedSame
        }
    }
}
