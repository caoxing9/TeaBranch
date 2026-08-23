import Foundation

/// Everything the app learns from `git` about the repository and its worktrees.
enum GitService {
    struct WorktreeEntry: Hashable {
        let branch: String
        let path: URL
    }

    /// Parse `git worktree list --porcelain`. Detached worktrees (no `branch` line) are skipped
    /// — the app only ever operates on branch-backed worktrees.
    static func worktrees(in repo: URL) -> [WorktreeEntry] {
        let result = Shell.git(["worktree", "list", "--porcelain"], cwd: repo)
        guard result.ok else { return [] }
        return parseWorktreeList(result.stdout)
    }

    static func parseWorktreeList(_ output: String) -> [WorktreeEntry] {
        var entries: [WorktreeEntry] = []
        var path: String?

        for line in output.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("worktree ") {
                path = String(line.dropFirst("worktree ".count))
            } else if line.hasPrefix("branch ") {
                let reference = String(line.dropFirst("branch ".count))
                let name = reference.hasPrefix("refs/heads/")
                    ? String(reference.dropFirst("refs/heads/".count))
                    : reference
                if let path {
                    entries.append(WorktreeEntry(branch: name, path: URL(fileURLWithPath: path)))
                }
            } else if line.isEmpty {
                path = nil
            }
        }
        return entries
    }

    static func currentBranch(in repo: URL) -> String? {
        let result = Shell.git(["rev-parse", "--abbrev-ref", "HEAD"], cwd: repo)
        guard result.ok else { return nil }
        let branch = result.trimmedOut
        return branch.isEmpty ? nil : branch
    }

    /// The branches shown in the UI: one per worktree, current first, then alphabetical.
    static func branches(in repo: URL, environments: [String: BranchEnvironment]) throws -> [Branch] {
        let result = Shell.git(["worktree", "list", "--porcelain"], cwd: repo)
        guard result.ok else {
            throw TeaBranchError("git worktree list failed: \(result.stderr.trimmingCharacters(in: .whitespacesAndNewlines))")
        }

        let head = currentBranch(in: repo)
        let branches = parseWorktreeList(result.stdout).map { entry in
            Branch(
                name: entry.branch,
                isCurrent: head == entry.branch,
                environment: environments[entry.branch],
                managed: isManaged(worktree: entry.path, repo: repo),
                worktreePath: entry.path.path
            )
        }

        return branches.sorted { left, right in
            if left.isCurrent != right.isCurrent { return left.isCurrent }
            return left.name.localizedStandardCompare(right.name) == .orderedAscending
        }
    }

    /// Where a branch's worktree lives. Falls back to the repo itself when the branch is simply
    /// the main checkout's HEAD.
    static func worktreePath(for branch: String, in repo: URL) throws -> URL {
        if let entry = worktrees(in: repo).first(where: { $0.branch == branch }) {
            return entry.path
        }
        if currentBranch(in: repo) == branch {
            return repo
        }
        throw TeaBranchError(
            "No worktree found for branch '\(branch)'. Create one first with `git worktree add`."
        )
    }

    /// Memoised `isManaged` answers, keyed by worktree path.
    ///
    /// The uncached version reads up to two env files per worktree, and it is called once per
    /// worktree on *every* branch refresh — which the watchdog and the reconcile loop trigger
    /// several times during a single start. With twenty worktrees that was ~40 file reads a
    /// burst, to answer a question whose answer is fixed at creation time.
    private static let managedCache = ManagedCache()

    private final class ManagedCache: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [String: Bool] = [:]

        func value(for path: String, compute: () -> Bool) -> Bool {
            lock.lock()
            if let cached = values[path] {
                lock.unlock()
                return cached
            }
            lock.unlock()

            let computed = compute()
            lock.lock()
            values[path] = computed
            lock.unlock()
            return computed
        }

        func forget(_ path: String) {
            lock.lock()
            values.removeValue(forKey: path)
            lock.unlock()
        }
    }

    /// Drop a cached answer — call when a worktree is created or removed.
    static func forgetManaged(worktree: URL) {
        managedCache.forget(worktree.standardizedFileURL.path)
    }

    /// A worktree counts as TeaBranch-managed if it sits under the `<repo>-worktree/` sibling
    /// directory, or if its env file still carries the marker we write during creation.
    static func isManaged(worktree: URL, repo: URL) -> Bool {
        managedCache.value(for: worktree.standardizedFileURL.path) {
            computeIsManaged(worktree: worktree, repo: repo)
        }
    }

    private static func computeIsManaged(worktree: URL, repo: URL) -> Bool {
        let repoName = repo.lastPathComponent
        let managedBase = repo.deletingLastPathComponent().appendingPathComponent("\(repoName)-worktree")
        if worktree.path == managedBase.path || worktree.path.hasPrefix(managedBase.path + "/") {
            return true
        }

        for relative in ["enterprise/app-ee/.env.development.local", ".env.development.local"] {
            let path = worktree.appendingPathComponent(relative)
            guard let contents = try? String(contentsOf: path, encoding: .utf8) else { continue }
            if contents.contains("# WORKTREE_SLOT=") || contents.contains("# ---- BranchPilot overrides ----") {
                return true
            }
        }
        return false
    }

    /// Database / Redis configuration of every worktree, for the "reuse an existing instance"
    /// pickers.
    static func worktreeDbInfo(in repo: URL) -> [WorktreeDbInfo] {
        worktrees(in: repo).map { entry in
            let databaseURL = EnvFile.baseDatabaseURL(in: entry.path)
            return WorktreeDbInfo(
                branchName: entry.branch,
                databaseName: databaseURL.flatMap { DatabaseURL.name(of: $0) },
                databaseURL: databaseURL,
                redisURI: EnvFile.value("BACKEND_CACHE_REDIS_URI", in: entry.path)
            )
        }
    }

    /// Map a forwarded local port back to a branch via its SERVER_PORT.
    static func branch(forServerPort port: UInt16, in repo: URL) -> String? {
        guard port != 0 else { return nil }
        return worktrees(in: repo)
            .first { EnvFile.port("SERVER_PORT", in: $0.path) == port }?
            .branch
    }
}
