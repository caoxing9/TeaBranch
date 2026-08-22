import Foundation

/// Creating and destroying isolated worktrees — the `wt` shell workflow, in code:
/// fetch develop → add worktree → write an env file with unique ports/DB/Redis → install
/// dependencies → provision and migrate the database.
enum WorktreeService {
    /// The branch every new worktree is cut from, and the default database to reuse.
    ///
    /// Hard-coded because it is Teable's integration branch, not a preference — a worktree cut
    /// from anywhere else would not match the schema of the database this app provisions.
    static let baseBranch = "develop"

    /// The env keys we take ownership of when generating a worktree's env file.
    private static let generatedKeys = [
        "PORT", "SOCKET_PORT", "SERVER_PORT", "PUBLIC_ORIGIN",
        "STORAGE_PREFIX", "PRISMA_DATABASE_URL", "PUBLIC_DATABASE_PROXY",
        "BACKEND_CACHE_REDIS_URI",
    ]

    static func worktreeBase(for repo: URL) -> URL {
        repo.deletingLastPathComponent().appendingPathComponent("\(repo.lastPathComponent)-worktree")
    }

    static func worktreeDirectory(for branch: String, repo: URL) -> URL {
        worktreeBase(for: repo).appendingPathComponent(branch.replacingOccurrences(of: "/", with: "-"))
    }

    // MARK: - Creation

    @discardableResult
    static func create(
        branch: String,
        repo: URL,
        dbMode: DbMode,
        progress: @escaping (WorktreeProgress) -> Void
    ) throws -> URL {
        let base = worktreeBase(for: repo)
        let worktree = worktreeDirectory(for: branch, repo: repo)

        if FileManager.default.fileExists(atPath: worktree.path) {
            return worktree
        }
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)

        // 1. Fetch the branch point.
        progress(WorktreeProgress(step: "fetch", message: "Fetching origin/\(baseBranch)...", done: false))
        let fetch = Shell.git(["fetch", "origin", baseBranch], cwd: repo)
        guard fetch.ok else {
            throw TeaBranchError("git fetch failed: \(fetch.stderr)")
        }

        // 2. Add the worktree, branching off origin/develop.
        progress(WorktreeProgress(step: "branch", message: "Creating branch \(branch)...", done: false))
        let add = Shell.git(
            ["worktree", "add", "-b", branch, worktree.path, "origin/\(baseBranch)", "--no-track"],
            cwd: repo
        )
        if !add.ok {
            guard add.stderr.contains("already exists") else {
                throw TeaBranchError("git worktree add failed: \(add.stderr)")
            }
            // The branch is already there — check it out into the worktree as-is.
            let retry = Shell.git(["worktree", "add", worktree.path, branch], cwd: repo)
            guard retry.ok else {
                throw TeaBranchError("git worktree add failed: \(retry.stderr)")
            }
        }

        // 3. Env file with an isolated port block, database and Redis index.
        progress(WorktreeProgress(step: "env", message: "Setting up environment...", done: false))
        // A brand-new worktree must not inherit a cached answer from a path that was reused.
        GitService.forgetManaged(worktree: worktree)
        let slot = assignSlot(repo: repo)
        let branchDbName = DatabaseURL.name(forBranch: branch)

        var databaseURLOverride: String?
        var redisURIOverride: String?
        var skipDatabaseCreation = false

        if case .reuse(let sourceBranch) = dbMode {
            let source = try sourceInfo(for: sourceBranch, repo: repo)
            databaseURLOverride = source.databaseURL
            redisURIOverride = source.redisURI
            skipDatabaseCreation = true
        }

        let envDatabaseName = databaseURLOverride.flatMap { DatabaseURL.name(of: $0) } ?? branchDbName

        try writeEnvFile(
            repo: repo,
            worktree: worktree,
            slot: slot,
            databaseName: envDatabaseName,
            databaseURLOverride: databaseURLOverride,
            redisURIOverride: redisURIOverride
        )

        // 4. Dependencies.
        progress(WorktreeProgress(step: "install", message: "Installing dependencies (pnpm install)...", done: false))
        let install = Shell.sh("pnpm install", cwd: worktree)
        guard install.ok else {
            throw TeaBranchError("pnpm install failed: \(install.stderr)")
        }

        // 5. Database.
        if skipDatabaseCreation {
            progress(WorktreeProgress(step: "database", message: "Reusing existing database (no creation needed)", done: false))
            Log.info("Skipping database creation (reuse mode)")
        } else {
            progress(WorktreeProgress(step: "database", message: "Setting up database...", done: false))
            if let baseURL = EnvFile.baseDatabaseURL(in: repo) {
                let template: String
                if case .clone(let sourceBranch) = dbMode {
                    template = try sourceInfo(for: sourceBranch, repo: repo).databaseName ?? "teable"
                } else {
                    template = DatabaseURL.name(of: baseURL) ?? "teable"
                }
                do {
                    let url = try DatabaseService.create(name: branchDbName, from: template, baseURL: baseURL)
                    Log.info("Created database '\(branchDbName)' from template '\(template)': \(url)")
                } catch {
                    // Non-fatal: migration below may still bring the database up.
                    Log.warn("database creation failed: \(error.localizedDescription). Will try migration anyway.")
                }
            }
        }

        // 6. Prisma client + migrations. Always run: the client is per-worktree (it lives in
        // node_modules) and `migrate deploy` is idempotent, so this is safe even when reusing.
        progress(WorktreeProgress(step: "migrate", message: "Running database migration (make postgres.mode)...", done: false))
        let migrate = Shell.sh("make postgres.mode", cwd: worktree)
        if !migrate.ok {
            Log.warn("migration may have failed: \(migrate.stderr)")
        }

        progress(WorktreeProgress(step: "done", message: "Worktree ready!", done: true))
        return worktree
    }

    private static func sourceInfo(for branch: String, repo: URL) throws -> WorktreeDbInfo {
        guard let info = GitService.worktreeDbInfo(in: repo).first(where: { $0.branchName == branch }) else {
            throw TeaBranchError("Source branch '\(branch)' not found or has no worktree")
        }
        return info
    }

    // MARK: - Slot allocation

    /// Pick a free "slot", which fixes a worktree's whole port block (3000 + slot*100).
    ///
    /// Slot markers are ignored entirely; only the real port values matter. A worktree's
    /// `# WORKTREE_SLOT` and its actual `PORT` drift apart whenever a derived port was already
    /// taken, so trusting the marker hands the same port to two worktrees, which then kill each
    /// other's dev servers.
    static func assignSlot(repo: URL) -> UInt32 {
        var usedPorts = Set<UInt16>()

        var directories = [repo]
        let base = worktreeBase(for: repo)
        if let entries = try? FileManager.default.contentsOfDirectory(at: base, includingPropertiesForKeys: [.isDirectoryKey]) {
            directories.append(contentsOf: entries.filter(\.hasDirectoryPath))
        }

        // Only the *ports* matter, not the slot markers. A marker says which slot a worktree was
        // given; the ports say what is actually spoken for, and those are what can collide.
        for directory in directories {
            let envPath = directory.appendingPathComponent("enterprise/app-ee/.env.development.local")
            guard let contents = try? String(contentsOf: envPath, encoding: .utf8) else { continue }
            for rawLine in contents.split(separator: "\n") {
                let line = rawLine.trimmingCharacters(in: .whitespaces)
                for key in ["PORT=", "SOCKET_PORT=", "SERVER_PORT="] where line.hasPrefix(key) {
                    let value = line.dropFirst(key.count).trimmingCharacters(in: .whitespaces)
                    if let port = UInt16(value) { usedPorts.insert(port) }
                }
            }
        }

        // Search upward from the first slot, not from `max + 1`.
        //
        // The old version only ever counted up, so deleting the worktrees at slots 1–8 and keeping
        // slot 9 still handed the next one slot 10. Over a few months of churn the block drifts
        // into five-figure territory, and every gap left by a deleted worktree stays empty
        // forever. Scanning from the bottom reuses those gaps, which is also what keeps the ports
        // in a range you can recognise on sight.
        var slot: UInt32 = 1
        while true {
            let base = 3000 + slot * 100
            guard base + 3 <= UInt32(UInt16.max) else { return slot }
            let port = UInt16(base)
            let companion = UInt16(base + 3)

            let collides = usedPorts.contains(port)
                || usedPorts.contains(companion)
                || Ports.isReserved(port)
                || Ports.isReserved(companion)
                || !Ports.isAvailable(port)
                || !Ports.isAvailable(companion)
            if !collides { return slot }
            slot += 1
        }
    }

    // MARK: - Env file generation

    /// Copy the main repo's env file, dropping the keys we own and appending our own block.
    static func writeEnvFile(
        repo: URL,
        worktree: URL,
        slot: UInt32,
        databaseName: String,
        databaseURLOverride: String?,
        redisURIOverride: String?
    ) throws {
        let port = 3000 + slot * 100
        let socketPort = port + 3
        let serverPort = port + 3

        let baseContents = ["enterprise/app-ee/.env.development.local", "enterprise/app-ee/.env.development"]
            .lazy
            .map { repo.appendingPathComponent($0) }
            .compactMap { try? String(contentsOf: $0, encoding: .utf8) }
            .first ?? ""

        var lines = ["# WORKTREE_SLOT=\(slot)"]
        for rawLine in baseContents.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = rawLine.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("# WORKTREE_SLOT=") { continue }
            if generatedKeys.contains(where: { trimmed.hasPrefix("\($0)=") }) { continue }
            lines.append(String(rawLine))
        }

        let databaseURL = databaseURLOverride ?? {
            let base = EnvFile.baseDatabaseURL(in: repo)
                ?? "postgresql://teable:teable@127.0.0.1:5432/\(databaseName)?schema=public&statement_cache_size=1"
            return DatabaseURL.replacingName(base, with: databaseName)
        }()
        let redisURI = redisURIOverride ?? "redis://:teable@127.0.0.1:6379/\(slot)"

        lines.append(contentsOf: [
            "",
            "# ---- BranchPilot overrides ----",
            "PORT=\(port)",
            "SOCKET_PORT=\(socketPort)",
            "SERVER_PORT=\(serverPort)",
            "PUBLIC_ORIGIN=http://127.0.0.1:\(port)",
            "STORAGE_PREFIX=http://127.0.0.1:\(port)",
            "PRISMA_DATABASE_URL=\(databaseURL)",
            "PUBLIC_DATABASE_PROXY=127.0.0.1:5432",
            "BACKEND_CACHE_REDIS_URI=\(redisURI)",
        ])

        let target = worktree.appendingPathComponent("enterprise/app-ee/.env.development.local")
        try FileManager.default.createDirectory(
            at: target.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try lines.joined(separator: "\n").write(to: target, atomically: true, encoding: .utf8)
    }

    // MARK: - Removal

    static func remove(branch: String, repo: URL) throws {
        let safeName = branch.replacingOccurrences(of: "/", with: "-")
        let candidates = [
            worktreeBase(for: repo).appendingPathComponent(safeName),
            // Legacy layout, before worktrees moved to a sibling directory.
            repo.appendingPathComponent(".worktrees").appendingPathComponent(safeName),
        ]

        for path in candidates where FileManager.default.fileExists(atPath: path.path) {
            GitService.forgetManaged(worktree: path)
            let result = Shell.git(["worktree", "remove", "--force", path.path], cwd: repo)
            if result.ok { return }

            // The directory is there but git no longer tracks it as a worktree.
            if result.stderr.contains("is not a working tree") {
                try FileManager.default.removeItem(at: path)
                return
            }
            throw TeaBranchError("git worktree remove failed: \(result.stderr)")
        }

        // Externally created worktree: ask git where it lives.
        if let entry = GitService.worktrees(in: repo).first(where: { $0.branch == branch }) {
            let result = Shell.git(["worktree", "remove", "--force", entry.path.path], cwd: repo)
            guard result.ok else {
                throw TeaBranchError("git worktree remove failed: \(result.stderr)")
            }
        }
    }
}
