import Foundation

// MARK: - Teable

/// Where the issue table lives and how its columns map onto what the pipeline needs.
///
/// Kept in its own `teable.json` rather than in `AppSettings`: that struct uses synthesised
/// `Codable`, so adding a non-optional key to it would make every existing settings file fail to
/// decode and silently drop the user back to onboarding.
struct TeableConfig: Codable, Hashable, Sendable {
    var baseURL = "https://app.teable.ai"
    var baseId = "bserJ2pmgiLHFHfXNwE"
    var tableId = "tblNHimLUhUDtC3K7Jk"
    var viewId: String? = "viwn9Y3Rsy0H5W4yOCQ"

    // Column mapping, by field name. Unset means "guess from the schema".
    var titleField: String?
    var bodyField: String?
    var statusField: String?
    var idField: String?
    /// User field that says whose issue it is. Unset means "guess from the schema".
    var assigneeField: String?
    /// Only load issues assigned to the signed-in user — filtered by Teable, through `Me`.
    var onlyMine = true
    /// Where the PR link is written back once one exists. Nil disables write-back.
    var prField: String?
    /// Status written back once a PR is open. Nil leaves the status alone.
    var doneStatus: String?

    /// Auto mode picks up issues whose status is one of these.
    var fixStatuses: [String] = []
    var autoFix = false
    /// Issues worked on per batch. The next batch starts only after this one has fully settled.
    var batchSize = 3
    /// Start the next batch on its own once the current one settles, instead of waiting for a click.
    var autoNextBatch = false
    /// Prepended to the issue id. Empty by default: the branch *is* the issue id, so `T2312` is
    /// what you search for in git, GitHub and the branch list alike.
    var branchPrefix = ""

    var fixModel = AgentModel()
    var reviewEngine: ReviewEngine = .codex
    var reviewModel = AgentModel()
    /// Passed to `codex exec -m`. Empty uses whatever `~/.codex/config.toml` says.
    var codexModel = ""
    /// Run a review as soon as the fix agent has opened a PR.
    var autoReview = true
    /// Hand review findings back to the issue's own agent and re-review the result.
    var sendReviewToAgent = true
    /// Review → fix rounds before the loop stops and waits for a human.
    var maxReviewRounds = 2

    var magpieURL = "http://127.0.0.1:3425"

    init() {}

    /// Decode field by field so a config written by an older build keeps working.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = TeableConfig()
        baseURL = try c.decodeIfPresent(String.self, forKey: .baseURL) ?? d.baseURL
        baseId = try c.decodeIfPresent(String.self, forKey: .baseId) ?? d.baseId
        tableId = try c.decodeIfPresent(String.self, forKey: .tableId) ?? d.tableId
        viewId = try c.decodeIfPresent(String.self, forKey: .viewId) ?? nil
        titleField = try c.decodeIfPresent(String.self, forKey: .titleField)
        bodyField = try c.decodeIfPresent(String.self, forKey: .bodyField)
        statusField = try c.decodeIfPresent(String.self, forKey: .statusField)
        idField = try c.decodeIfPresent(String.self, forKey: .idField)
        assigneeField = try c.decodeIfPresent(String.self, forKey: .assigneeField)
        onlyMine = try c.decodeIfPresent(Bool.self, forKey: .onlyMine) ?? d.onlyMine
        prField = try c.decodeIfPresent(String.self, forKey: .prField)
        doneStatus = try c.decodeIfPresent(String.self, forKey: .doneStatus)
        fixStatuses = try c.decodeIfPresent([String].self, forKey: .fixStatuses) ?? d.fixStatuses
        autoFix = try c.decodeIfPresent(Bool.self, forKey: .autoFix) ?? d.autoFix
        batchSize = try c.decodeIfPresent(Int.self, forKey: .batchSize) ?? d.batchSize
        autoNextBatch = try c.decodeIfPresent(Bool.self, forKey: .autoNextBatch) ?? d.autoNextBatch
        branchPrefix = try c.decodeIfPresent(String.self, forKey: .branchPrefix) ?? d.branchPrefix
        fixModel = try c.decodeIfPresent(AgentModel.self, forKey: .fixModel) ?? d.fixModel
        reviewEngine = try c.decodeIfPresent(ReviewEngine.self, forKey: .reviewEngine) ?? d.reviewEngine
        reviewModel = try c.decodeIfPresent(AgentModel.self, forKey: .reviewModel) ?? d.reviewModel
        codexModel = try c.decodeIfPresent(String.self, forKey: .codexModel) ?? d.codexModel
        autoReview = try c.decodeIfPresent(Bool.self, forKey: .autoReview) ?? d.autoReview
        sendReviewToAgent = try c.decodeIfPresent(Bool.self, forKey: .sendReviewToAgent) ?? d.sendReviewToAgent
        maxReviewRounds = try c.decodeIfPresent(Int.self, forKey: .maxReviewRounds) ?? d.maxReviewRounds
        magpieURL = try c.decodeIfPresent(String.self, forKey: .magpieURL) ?? d.magpieURL
    }

    var apiBase: String { baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")) }

    /// The record opened in the Teable web app.
    func recordURL(_ recordId: String) -> URL? {
        var path = "\(apiBase)/base/\(baseId)/table/\(tableId)"
        if let viewId { path += "/\(viewId)" }
        return URL(string: "\(path)?recordId=\(recordId)")
    }

    /// Pull base/table/view ids out of a URL copied from the browser.
    mutating func apply(tableURL: String) -> Bool {
        guard let url = URL(string: tableURL.trimmingCharacters(in: .whitespaces)),
              let host = url.host else { return false }
        let parts = url.pathComponents
        func after(_ key: String) -> String? {
            parts.firstIndex(of: key).flatMap { $0 + 1 < parts.count ? parts[$0 + 1] : nil }
        }
        guard let base = after("base"), let table = after("table") else { return false }
        baseURL = "\(url.scheme ?? "https")://\(host)\(url.port.map { ":\($0)" } ?? "")"
        baseId = base
        tableId = table
        if let tableIndex = parts.firstIndex(of: "table"), tableIndex + 2 < parts.count {
            viewId = parts[tableIndex + 2]
        } else {
            viewId = nil
        }
        return true
    }
}

struct TeableUser: Codable, Hashable, Sendable {
    var id: String
    var name: String
    var email: String?
}

struct TeableField: Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    var type: String
    var isPrimary: Bool
    /// Choice names for select fields, in order.
    var choices: [String]
    /// A user field that holds several people.
    var isMultiple = false

    /// Fields that hold a person, which a "mine" filter can match against `Me`.
    var isUser: Bool { type == "user" || type == "createdBy" || type == "lastModifiedBy" }
}

/// One row, every cell already rendered to text by the API (`cellFormat=text`).
struct TeableRecord: Hashable, Identifiable, Sendable {
    var id: String
    var autoNumber: Int?
    var fields: [String: String]
}

/// A record seen through the column mapping.
struct Issue: Hashable, Identifiable, Sendable {
    var record: TeableRecord
    var title: String
    var body: String
    var status: String?
    /// What goes into the branch name, commit and PR title.
    var key: String

    var id: String { record.id }
}

// MARK: - Agents

enum ModelProvider: String, Codable, Hashable, Sendable {
    /// Claude Code's own login and default model.
    case claude
    /// Claude Code pointed at the Magpie gateway, which speaks `/v1/messages` for every model it
    /// routes — Codex, GPT, DeepSeek and so on.
    case magpie
}

struct AgentModel: Codable, Hashable, Sendable {
    var provider: ModelProvider = .claude
    /// Model id. For `.claude` an alias like `opus`; nil uses the CLI default.
    var model: String?

    var label: String {
        switch provider {
        case .claude: return model.map { "Claude · \($0)" } ?? "Claude (default)"
        case .magpie: return "Magpie · \(model ?? "default")"
        }
    }
}

enum ReviewEngine: String, Codable, CaseIterable, Hashable, Sendable {
    case codex, claude

    var label: String {
        switch self {
        case .codex: return "Codex CLI"
        case .claude: return "Claude Code"
        }
    }
}

// MARK: - Runs

enum IssuePhase: String, Codable, Hashable, Sendable {
    case queued, preparing, fixing, prOpen, reviewing, finished, failed, cancelled

    var label: String {
        switch self {
        case .queued: return "排队中"
        case .preparing: return "创建 worktree"
        case .fixing: return "修复中"
        case .prOpen: return "PR 待审查"
        case .reviewing: return "Review 中"
        case .finished: return "已结束"
        case .failed: return "失败"
        case .cancelled: return "已取消"
        }
    }

    var isActive: Bool { self == .queued || self == .preparing || self == .fixing || self == .reviewing }
}

struct ReviewRecord: Codable, Hashable, Sendable {
    var engine: ReviewEngine
    var model: String
    var text: String
    var approved: Bool
    var round: Int
    var at: Date
}

/// Everything TeaBranch knows about one issue's automation, persisted across launches.
struct IssueRun: Codable, Hashable, Sendable {
    var recordId: String
    var issueKey: String
    var title: String
    var branch: String
    /// The issue's own Claude Code conversation. Every follow-up resumes it.
    var sessionId: String
    var phase: IssuePhase
    /// Set once the worktree pipeline (env, install, database) has run to the end. A worktree
    /// directory without it was cut short and must be rebuilt, not reused. Optional so runs
    /// saved before it existed still decode.
    var worktreeReady: Bool?
    var prURL: String?
    var lastError: String?
    var reviews: [ReviewRecord] = []
    var costUSD: Double = 0
    var createdAt: Date
    var updatedAt: Date

    var reviewRound: Int { reviews.count }
}

/// One line in an issue's conversation pane.
struct ConversationEntry: Codable, Hashable, Identifiable, Sendable {
    enum Kind: String, Codable, Sendable {
        case user, assistant, tool, toolResult, system, result, error, review
    }
    enum Channel: String, Codable, Sendable {
        /// The issue's main agent.
        case agent
        /// Reviewer output.
        case review
    }

    var id = UUID()
    var kind: Kind
    var channel: Channel = .agent
    var text: String
    var isError = false
    var at = Date()
}
