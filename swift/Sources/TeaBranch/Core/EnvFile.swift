import Foundation

/// Reading and rewriting the `.env*` files that define a worktree's isolated environment.
enum EnvFile {
    /// Search order for a plain read — most specific file wins, same as the Rust backend.
    private static let searchPaths = [
        "enterprise/app-ee/.env.development.local",
        ".env.development.local",
        "enterprise/app-ee/.env.local",
        ".env.local",
        "enterprise/app-ee/.env.development",
        ".env.development",
        "enterprise/app-ee/.env",
        ".env",
    ]

    /// The files TeaBranch writes to (first existing one wins).
    private static let writablePaths = [
        "enterprise/app-ee/.env.development.local",
        ".env.development.local",
    ]

    static func value(_ key: String, in worktree: URL) -> String? {
        let prefix = key + "="
        for relative in searchPaths {
            let path = worktree.appendingPathComponent(relative)
            guard let contents = try? String(contentsOf: path, encoding: .utf8) else { continue }
            for rawLine in contents.split(separator: "\n", omittingEmptySubsequences: false) {
                let line = rawLine.trimmingCharacters(in: .whitespaces)
                if line.hasPrefix("#") || !line.contains("=") { continue }
                if line.hasPrefix(prefix) {
                    return String(line.dropFirst(prefix.count))
                }
            }
        }
        return nil
    }

    static func port(_ key: String, in worktree: URL) -> UInt16? {
        value(key, in: worktree).flatMap { UInt16($0.trimmingCharacters(in: .whitespaces)) }
    }

    static func baseDatabaseURL(in worktree: URL) -> String? {
        value("PRISMA_DATABASE_URL", in: worktree)
    }

    static func overrides(in worktree: URL) -> WorktreeEnvOverrides {
        WorktreeEnvOverrides(
            port: value("PORT", in: worktree),
            socketPort: value("SOCKET_PORT", in: worktree),
            serverPort: value("SERVER_PORT", in: worktree),
            publicOrigin: value("PUBLIC_ORIGIN", in: worktree),
            storagePrefix: value("STORAGE_PREFIX", in: worktree),
            prismaDatabaseURL: value("PRISMA_DATABASE_URL", in: worktree),
            publicDatabaseProxy: value("PUBLIC_DATABASE_PROXY", in: worktree),
            backendCacheRedisURI: value("BACKEND_CACHE_REDIS_URI", in: worktree),
            sandboxTeableEndpoint: value("SANDBOX_TEABLE_ENDPOINT", in: worktree)
        )
    }

    // MARK: - Full-file editing

    /// One assignment in the worktree's env file.
    struct Entry: Hashable, Identifiable, Sendable {
        var key: String
        var value: String
        /// Whether TeaBranch generated this key and relies on it for isolation.
        var isManaged: Bool { WorktreeEnvOverrides.allKeys.contains(key) }

        var id: String { key }
    }

    /// The writable env file for a worktree, if it has one.
    static func writableURL(in worktree: URL) -> URL? {
        writablePaths
            .map { worktree.appendingPathComponent($0) }
            .first { FileManager.default.fileExists(atPath: $0.path) }
    }

    /// Split one line into `(key, value)`, or `nil` when it isn't an assignment.
    ///
    /// Both halves are trimmed: `FOO = bar` and `FOO=bar` name the same variable, and treating
    /// them differently is how you end up with two entries for one key.
    private static func parseAssignment(_ rawLine: some StringProtocol) -> (key: String, value: String)? {
        let line = rawLine.trimmingCharacters(in: .whitespaces)
        guard !line.hasPrefix("#"), let equals = line.firstIndex(of: "=") else { return nil }
        let key = String(line[line.startIndex..<equals]).trimmingCharacters(in: .whitespaces)
        guard !key.isEmpty else { return nil }
        let value = String(line[line.index(after: equals)...]).trimmingCharacters(in: .whitespaces)
        return (key, value)
    }

    /// Every assignment in the worktree's own env file, in file order.
    ///
    /// Only the writable file, not the whole search chain: these are the values this worktree
    /// overrides, and showing inherited defaults from `.env.development` alongside them would
    /// invite editing a key that then gets written to a different file than it was read from.
    ///
    /// A key assigned more than once resolves to its **last** value — dotenv builds an object, so
    /// later lines overwrite earlier ones, and showing the first would show a value the running
    /// process never sees.
    static func entries(in worktree: URL) -> [Entry] {
        guard let target = writableURL(in: worktree),
              let contents = try? String(contentsOf: target, encoding: .utf8)
        else { return [] }

        var order: [String] = []
        var values: [String: String] = [:]
        for rawLine in contents.split(separator: "\n", omittingEmptySubsequences: false) {
            guard let (key, value) = parseAssignment(rawLine) else { continue }
            if values[key] == nil { order.append(key) }
            values[key] = value
        }
        return order.map { Entry(key: $0, value: values[$0] ?? "") }
    }

    /// Write `entries` back, preserving comments, blank lines and the order of everything that
    /// was already there.
    ///
    /// Keys removed from `entries` are deleted from the file; keys added are appended. Every line
    /// that is not an assignment survives byte for byte — the file carries the `# WORKTREE_SLOT=`
    /// marker the slot allocator reads, and losing it would break port assignment for every
    /// worktree created afterwards.
    static func writeEntries(_ entries: [Entry], in worktree: URL) throws {
        guard let target = writableURL(in: worktree) else {
            throw TeaBranchError("No .env.development.local found in worktree")
        }

        let contents = try String(contentsOf: target, encoding: .utf8)
        let values = Dictionary(entries.map { ($0.key, $0.value) }, uniquingKeysWith: { _, last in last })

        let lines = contents.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)

        // Where each key is assigned for the last time. That line is the one that decides the
        // value, so it is the only one an edit may touch — rewriting the earlier duplicates too
        // would change lines the user never edited, and deleting them would silently flip which
        // assignment wins.
        var decidingLine: [String: Int] = [:]
        for (index, line) in lines.enumerated() {
            if let (key, _) = parseAssignment(line) { decidingLine[key] = index }
        }

        var output: [String] = []
        var seen = Set<String>()

        for (index, line) in lines.enumerated() {
            guard let (key, existing) = parseAssignment(line) else {
                output.append(line)   // comment, blank line, or anything we don't understand
                continue
            }
            guard let value = values[key] else { continue }  // removed by the editor
            seen.insert(key)

            // Unchanged lines go back byte for byte. Re-emitting them normalised would rewrite
            // `FOO = bar` as `FOO=bar` on every save — a diff the user never asked for, in a file
            // that is usually under version control.
            let isDecider = decidingLine[key] == index
            output.append(isDecider && existing != value ? "\(key)=\(value)" : line)
        }

        for entry in entries where !seen.contains(entry.key) {
            output.append("\(entry.key)=\(entry.value)")
        }

        try output.joined(separator: "\n").write(to: target, atomically: true, encoding: .utf8)
    }

    /// Rewrite the override keys in place, appending any that weren't in the file yet.
    /// Every other line is preserved byte for byte.
    static func writeOverrides(_ overrides: WorktreeEnvOverrides, in worktree: URL) throws {
        let target = writablePaths
            .map { worktree.appendingPathComponent($0) }
            .first { FileManager.default.fileExists(atPath: $0.path) }

        guard let target else {
            throw TeaBranchError("No .env.development.local found in worktree")
        }

        let contents = try String(contentsOf: target, encoding: .utf8)
        let newValues = Dictionary(uniqueKeysWithValues: overrides.assignments.map { ($0.key, $0.value) })

        var output: [String] = []
        var replaced = Set<String>()

        for rawLine in contents.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let matched = WorktreeEnvOverrides.allKeys.first { trimmed.hasPrefix("\($0)=") }

            if let key = matched, let value = newValues[key] {
                output.append("\(key)=\(value)")
                replaced.insert(key)
            } else {
                output.append(line)
            }
        }

        for (key, value) in overrides.assignments where !replaced.contains(key) {
            output.append("\(key)=\(value)")
        }

        try output.joined(separator: "\n").write(to: target, atomically: true, encoding: .utf8)
    }
}

/// PostgreSQL URL surgery — the app rewrites the database name in a connection string a lot.
enum DatabaseURL {
    /// `postgresql://u:p@h:5432/teable?schema=public` → `…/teable_my_branch?schema=public`
    static func replacingName(_ url: String, with newName: String) -> String {
        guard let range = url.range(of: "://", options: .backwards) else { return url }
        let afterScheme = url[range.upperBound...]
        guard let pathStart = afterScheme.firstIndex(of: "/") else { return url }

        let prefix = url[..<pathStart] + "/"
        let afterName = afterScheme[afterScheme.index(after: pathStart)...]
        let query = afterName.firstIndex(of: "?").map { String(afterName[$0...]) } ?? ""
        return prefix + newName + query
    }

    static func name(of url: String) -> String? {
        guard let range = url.range(of: "://", options: .backwards) else { return nil }
        let afterScheme = url[range.upperBound...]
        guard let pathStart = afterScheme.firstIndex(of: "/") else { return nil }

        let afterName = afterScheme[afterScheme.index(after: pathStart)...]
        let end = afterName.firstIndex(of: "?") ?? afterName.endIndex
        let name = String(afterName[..<end])
        return name.isEmpty ? nil : name
    }

    /// A safe database name derived from a branch: `feat/my-thing` → `teable_feat_my_thing`.
    static func name(forBranch branch: String) -> String {
        let safe = branch
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "-", with: "_")
            .lowercased()
        return "teable_\(safe)"
    }
}

struct TeaBranchError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
