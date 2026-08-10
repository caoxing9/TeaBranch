import AppKit
import Foundation

/// Opening a worktree in an external editor or terminal.
///
/// Terminals get a **new tab** in the already-running instance rather than a new window.
/// How that is done depends on what the app exposes:
///   - Warp has a URL scheme (`warp://action/new_tab?path=…`) — cleanest, no permissions.
///   - iTerm has a real AppleScript dictionary — `create tab with default profile`.
///   - Terminal, Ghostty and Kero have no tab API, so we drive ⌘T through System Events,
///     which needs Accessibility permission for TeaBranch.
///   - Everything else falls back to `open -a`, which opens a window.
enum TerminalService {
    struct Preset: Hashable, Identifiable {
        /// `nil` means "system default", stored as no value in settings.
        let value: String?
        let label: String
        /// Whether we can put the worktree in a new tab of the running instance.
        let supportsTabs: Bool

        var id: String { value ?? "" }
    }

    static let presets: [Preset] = [
        Preset(value: nil, label: "System Default (Terminal)", supportsTabs: true),
        Preset(value: "Warp", label: "Warp", supportsTabs: true),
        Preset(value: "iTerm", label: "iTerm", supportsTabs: true),
        Preset(value: "Ghostty", label: "Ghostty", supportsTabs: true),
        Preset(value: "Kero", label: "Kero", supportsTabs: true),
        Preset(value: "Alacritty", label: "Alacritty", supportsTabs: false),
        Preset(value: "Kitty", label: "Kitty", supportsTabs: false),
        Preset(value: "Hyper", label: "Hyper", supportsTabs: false),
    ]

    /// Terminals that are Ghostty (or a fork of it): same CLI flags, same lack of a tab API.
    private static let ghosttyFamily = ["ghostty", "kero"]

    // MARK: - Terminal

    static func openTerminal(at path: String, using app: String?) throws {
        guard FileManager.default.fileExists(atPath: path) else {
            throw TeaBranchError("Path does not exist: \(path)")
        }

        guard let app, !app.isEmpty else {
            try openSystemTerminal(at: path)
            return
        }

        if app.caseInsensitiveCompare("Warp") == .orderedSame {
            try openWarp(at: path)
        } else if app.caseInsensitiveCompare("iTerm") == .orderedSame
                    || app.caseInsensitiveCompare("iTerm2") == .orderedSame {
            try openITerm(at: path)
        } else if ghosttyFamily.contains(app.lowercased()) {
            try openGhosttyLike(app: app, at: path)
        } else {
            let result = Shell.run("open", ["-a", app, path])
            guard result.ok else {
                throw TeaBranchError("Failed to open \(app): \(result.stderr)")
            }
        }
    }

    /// Terminal.app: ⌘T for the tab, then `do script … in front window` to run in it.
    private static func openSystemTerminal(at path: String) throws {
        let script = """
        tell application "Terminal"
            activate
            if (count of windows) is 0 then
                do script "\(appleScriptLiteral(cdCommand(for: path)))"
            else
                tell application "System Events" to keystroke "t" using {command down}
                delay 0.2
                do script "\(appleScriptLiteral(cdCommand(for: path)))" in front window
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

    private static func openITerm(at path: String) throws {
        let script = """
        tell application "iTerm"
            activate
            if (count of windows) is 0 then
                create window with default profile
            else
                tell current window to create tab with default profile
            end if
            tell current session of current window to write text "\(appleScriptLiteral(cdCommand(for: path)))"
        end tell
        """
        try runAppleScript(script, failureHint: "iTerm")
    }

    /// Ghostty and its forks (Kero) expose no IPC for tabs, so we drive the running instance:
    /// activate → ⌘T → type `cd <path> && clear` → Return. If it isn't running yet, launch it
    /// with `--working-directory`, which lands in the first window anyway.
    private static func openGhosttyLike(app: String, at path: String) throws {
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
            keystroke "\(appleScriptLiteral(cdCommand(for: path)))"
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

    private static func cdCommand(for path: String) -> String {
        "cd \(path.shellQuoted) && clear"
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
