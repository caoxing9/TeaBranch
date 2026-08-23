import AppKit
import Foundation

/// Where Claude Code keeps the working files it generates for a directory.
///
/// The layout is `/private/tmp/claude-<uid>/<slug>/<session-uuid>/{scratchpad,tasks}`, where the
/// slug is the working directory with every `/` turned into `-`. That path is derivable but not
/// memorable, and it is where every script, note and intermediate artefact an agent produced for
/// a worktree ends up — so getting to it should be a button, not an archaeology exercise.
///
/// Nothing here creates anything: if the agent has never run in a worktree, there is simply
/// nothing to open, and the button that calls this stays hidden.
enum AgentScratchService {
    /// Root of the per-directory scratch space for a worktree, or `nil` if it doesn't exist.
    static func root(for worktreePath: String) -> URL? {
        let slug = URL(fileURLWithPath: worktreePath)
            .standardizedFileURL
            .path
            .replacingOccurrences(of: "/", with: "-")

        let root = URL(fileURLWithPath: "/private/tmp")
            .appendingPathComponent("claude-\(getuid())")
            .appendingPathComponent(slug)

        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory),
              isDirectory.boolValue
        else { return nil }
        return root
    }

    static func exists(for worktreePath: String) -> Bool { root(for: worktreePath) != nil }

    /// Open the worktree's scratch root in Finder.
    ///
    /// The root, not a session inside it: which session you want depends on which conversation you
    /// are thinking of, and that is a judgement Finder is better placed to help with than a guess
    /// at "the most recent one". One level up shows them all, sorted however you like.
    static func reveal(for worktreePath: String) {
        guard let root = root(for: worktreePath) else { return }
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: root.path)
    }
}
