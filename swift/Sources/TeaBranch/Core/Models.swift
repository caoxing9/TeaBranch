import Foundation

enum BranchStatus: String, Codable, Hashable, Sendable {
    case running, stopped, building, error

    var label: String {
        switch self {
        case .running: return "Running"
        case .stopped: return "Stopped"
        case .building: return "Building"
        case .error: return "Error"
        }
    }

    /// List ordering: live things first, dead things last.
    var sortRank: Int {
        switch self {
        case .running: return 0
        case .building: return 1
        case .error: return 2
        case .stopped: return 3
        }
    }

    var isLive: Bool { self == .running || self == .building }
}

struct BranchEnvironment: Codable, Hashable, Identifiable, Sendable {
    var branchName: String
    var worktreePath: String?
    var port: UInt16?
    var backendPort: UInt16?
    var socketPort: UInt16?
    var status: BranchStatus
    var databaseName: String?

    var id: String { branchName }
}

struct Branch: Hashable, Identifiable, Sendable {
    var name: String
    var isCurrent: Bool
    var environment: BranchEnvironment?
    /// Whether this worktree was created by TeaBranch (vs. added by hand with `git worktree add`).
    var managed: Bool
    var worktreePath: String?

    var id: String { name }
    var status: BranchStatus { environment?.status ?? .stopped }
    /// The worktree path from the live environment, falling back to the one git reported.
    var effectiveWorktreePath: String? { environment?.worktreePath ?? worktreePath }
}

struct AppSettings: Codable, Hashable, Sendable {
    var projectPath: String?
    var basePort: UInt16 = 3001
    var defaultStartCommand: String = "npm run dev"
    var terminalApp: String?

    var projectURL: URL? {
        projectPath.map { URL(fileURLWithPath: $0) }
    }
}

struct NgrokTunnel: Codable, Hashable, Sendable {
    var branchName: String
    var port: UInt16
    var publicURL: String
}

struct WorktreeDbInfo: Hashable, Identifiable, Sendable {
    var branchName: String
    var databaseName: String?
    var databaseURL: String?
    var redisURI: String?

    var id: String { branchName }
}

/// The env keys TeaBranch owns in a worktree's `.env.development.local`.
struct WorktreeEnvOverrides: Hashable, Sendable {
    var port: String?
    var socketPort: String?
    var serverPort: String?
    var publicOrigin: String?
    var storagePrefix: String?
    var prismaDatabaseURL: String?
    var publicDatabaseProxy: String?
    var backendCacheRedisURI: String?
    var sandboxTeableEndpoint: String?

    static let empty = WorktreeEnvOverrides()

    /// Key/value pairs in file order, skipping unset entries.
    var assignments: [(key: String, value: String)] {
        let pairs: [(String, String?)] = [
            ("PORT", port),
            ("SOCKET_PORT", socketPort),
            ("SERVER_PORT", serverPort),
            ("PUBLIC_ORIGIN", publicOrigin),
            ("STORAGE_PREFIX", storagePrefix),
            ("PRISMA_DATABASE_URL", prismaDatabaseURL),
            ("PUBLIC_DATABASE_PROXY", publicDatabaseProxy),
            ("BACKEND_CACHE_REDIS_URI", backendCacheRedisURI),
            ("SANDBOX_TEABLE_ENDPOINT", sandboxTeableEndpoint),
        ]
        return pairs.compactMap { key, value in value.map { (key, $0) } }
    }

    static let allKeys = [
        "PORT", "SOCKET_PORT", "SERVER_PORT", "PUBLIC_ORIGIN", "STORAGE_PREFIX",
        "PRISMA_DATABASE_URL", "PUBLIC_DATABASE_PROXY", "BACKEND_CACHE_REDIS_URI",
        "SANDBOX_TEABLE_ENDPOINT",
    ]
}

enum DevCategory: String, Codable, CaseIterable, Hashable, Sendable {
    case developing, todo, done

    var label: String {
        switch self {
        case .developing: return "开发中"
        case .todo: return "待开发"
        case .done: return "已完成"
        }
    }

    var sortRank: Int {
        switch self {
        case .developing: return 0
        case .todo: return 1
        case .done: return 2
        }
    }
}

/// How a new worktree gets its database.
enum DbMode: Hashable, Sendable {
    /// Fresh database from the base template, named after the branch.
    case new
    /// Fresh database cloned from another worktree's database, named after the branch.
    case clone(sourceBranch: String)
    /// Point straight at another worktree's database and Redis.
    case reuse(sourceBranch: String)

    var sourceBranch: String? {
        switch self {
        case .new: return nil
        case .clone(let branch), .reuse(let branch): return branch
        }
    }
}

/// One step of the worktree creation pipeline, reported back to the UI as it runs.
struct WorktreeProgress: Hashable, Sendable {
    var step: String
    var message: String
    var done: Bool
}
