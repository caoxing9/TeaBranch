import AppKit
import Observation
import SwiftUI

/// The Issues side of the app: Teable login, the issue table, and each issue's automation.
///
/// Mirrors `AppModel`'s split — services block on background queues, this owns the UI's copy.
@MainActor
@Observable
final class IssuesModel {
    enum Filter: String, CaseIterable {
        case all, active, review, untouched

        var label: String {
            switch self {
            case .all: return "全部"
            case .active: return "进行中"
            case .review: return "待审查"
            case .untouched: return "未处理"
            }
        }
    }

    private(set) var config = SettingsStore.loadTeableConfig()
    private(set) var user: TeableUser?
    private(set) var fields: [TeableField] = []
    private(set) var records: [TeableRecord] = []
    private(set) var runs: [String: IssueRun] = IssueAgentService.shared.allRuns
    private(set) var queue = IssueAgentService.shared.queueState
    private(set) var isLoading = false
    private(set) var isSigningIn = false
    private(set) var lastLoaded: Date?
    var errorMessage: String?

    /// Every selected row. One opens that issue; several open the batch panel.
    var selection: Set<String> = []
    var searchText = ""
    var filter: Filter = .all
    /// Field name → accepted values, for select fields like 状态 / Type. Empty means no filter.
    /// Remembered across launches: it is how you scope the list, not a one-off search.
    var fieldFilters: [String: Set<String>] = [:] {
        didSet {
            let raw = fieldFilters.mapValues { Array($0) }
            UserDefaults.standard.set(raw, forKey: Self.fieldFiltersKey)
        }
    }
    private static let fieldFiltersKey = "teabranch.issueFieldFilters"

    var selectedIssueId: String? { selection.count == 1 ? selection.first : nil }
    var showSettings = false

    /// Bumped whenever the selected issue's conversation grows, so the pane re-reads it.
    private(set) var transcriptGeneration = 0
    private(set) var magpieModels: [String] = []
    private(set) var magpieError: String?

    private var autoTimer: Timer?

    var isLoggedIn: Bool { user != nil }

    init() {
        let raw = UserDefaults.standard.dictionary(forKey: Self.fieldFiltersKey) as? [String: [String]] ?? [:]
        fieldFilters = raw.mapValues(Set.init)

        NotificationCenter.default.addObserver(forName: .issueBatchFinished, object: nil, queue: .main) { [weak self] note in
            MainActor.assumeIsolated {
                guard let summary = note.object as? BatchSummary else { return }
                self?.notifyBatchFinished(summary)
            }
        }
        NotificationCenter.default.addObserver(forName: .issueRunsChanged, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.runs = IssueAgentService.shared.allRuns
                self?.queue = IssueAgentService.shared.queueState
            }
        }
        NotificationCenter.default.addObserver(forName: .issueTranscriptChanged, object: nil, queue: .main) { [weak self] note in
            MainActor.assumeIsolated {
                guard let self, note.object as? String == self.selectedIssueId else { return }
                self.transcriptGeneration &+= 1
            }
        }
    }

    /// Sign in with the stored token, if there is one.
    func start() {
        guard let token = Keychain.read(Keychain.teableToken) else { return }
        signIn(token: token, persist: false)
        scheduleAutoMode()
    }

    // MARK: - Auth

    func signIn(token: String, baseURL: String? = nil, persist: Bool = true) {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if let baseURL, !baseURL.isEmpty {
            updateConfig { $0.baseURL = baseURL }
        }
        isSigningIn = true
        errorMessage = nil
        let config = config

        Background.run {
            do {
                let user: TeableUser
                do {
                    user = try TeableService.me(config: config, token: trimmed)
                } catch {
                    // A token scoped only to the table may not read the profile endpoint; reading
                    // the table is the check that actually matters.
                    _ = try TeableService.fields(config: config, token: trimmed)
                    user = TeableUser(id: "token", name: "已登录（令牌）", email: nil)
                }
                if persist { Keychain.write(trimmed, for: Keychain.teableToken) }
                onMain {
                    self.user = user
                    self.isSigningIn = false
                    self.reload()
                }
            } catch {
                let message = error.localizedDescription
                onMain {
                    self.isSigningIn = false
                    self.errorMessage = message
                }
            }
        }
    }

    func signOut() {
        Keychain.write(nil, for: Keychain.teableToken)
        user = nil
        records = []
        fields = []
        selection = []
    }

    func openTokenPage() {
        if let url = TeableService.tokenPageURL(baseURL: config.baseURL) { NSWorkspace.shared.open(url) }
    }

    // MARK: - Loading

    func reload() {
        guard let token = Keychain.read(Keychain.teableToken), !isLoading else { return }
        isLoading = true
        let config = config
        Background.run {
            do {
                let fields = try TeableService.fields(config: config, token: token)
                // Filtered server-side: someone else's issues never reach this machine, so auto
                // mode cannot pick one up either.
                var mine: TeableField?
                if config.onlyMine {
                    mine = Self.assigneeField(in: fields, configured: config.assigneeField)
                    guard mine != nil else {
                        throw TeaBranchError("“只看我的”需要一个人员字段 — 在 Issue 设置里选“负责人”字段")
                    }
                }
                let records = try TeableService.records(
                    config: config,
                    token: token,
                    filter: mine.map(TeableService.mineFilter)
                )
                onMain {
                    self.fields = fields
                    self.records = records
                    self.isLoading = false
                    self.lastLoaded = Date()
                    self.errorMessage = nil
                    let issues = self.issues
                    Background.run { IssueAgentService.shared.restoreQueue(issues) }
                    self.runAutoMode()
                }
            } catch {
                let message = error.localizedDescription
                onMain {
                    self.isLoading = false
                    self.errorMessage = message
                }
            }
        }
    }

    // MARK: - Column mapping

    var titleField: String? {
        config.titleField ?? fields.first(where: \.isPrimary)?.name ?? fields.first?.name
    }

    var bodyField: String? {
        config.bodyField ?? guess(names: ["描述", "问题描述", "详情", "内容", "description", "detail", "body"])
            ?? fields.first { $0.type == "longText" && $0.name != titleField }?.name
    }

    var statusField: String? {
        config.statusField ?? guess(names: ["状态", "status", "state"], types: ["singleSelect"])
    }

    var idField: String? {
        // A column named like an issue id wins whatever its type — it is usually a formula such as
        // "T" & autoNumber, and that is the id people use in branch names and PR titles.
        config.idField
            ?? fields.first { ["issue id", "issueid", "issue_id", "编号", "id"].contains($0.name.lowercased()) }?.name
            ?? fields.first { $0.type == "autoNumber" }?.name
    }

    var assigneeField: String? {
        Self.assigneeField(in: fields, configured: config.assigneeField)?.name
    }

    var userFields: [TeableField] { fields.filter(\.isUser) }

    /// The configured person field, else the most assignee-sounding one.
    nonisolated static func assigneeField(in fields: [TeableField], configured: String?) -> TeableField? {
        let people = fields.filter(\.isUser)
        if let configured { return people.first { $0.name == configured } }
        let names = ["负责人", "处理人", "指派", "经办人", "开发", "assignee", "owner", "developer", "dev"]
        for name in names {
            if let hit = people.first(where: { $0.name.lowercased() == name }) { return hit }
        }
        for name in names {
            if let hit = people.first(where: { $0.name.lowercased().contains(name) }) { return hit }
        }
        return people.first { $0.type == "user" }
    }

    var statusChoices: [String] {
        guard let statusField else { return [] }
        return fields.first { $0.name == statusField }?.choices ?? []
    }

    private func guess(names: [String], types: [String]? = nil) -> String? {
        let candidates = types.map { allowed in fields.filter { allowed.contains($0.type) } } ?? fields
        for name in names {
            if let hit = candidates.first(where: { $0.name.lowercased() == name }) { return hit.name }
        }
        for name in names {
            if let hit = candidates.first(where: { $0.name.lowercased().contains(name) }) { return hit.name }
        }
        return nil
    }

    func issue(for record: TeableRecord) -> Issue {
        let title = titleField.flatMap { record.fields[$0] }.flatMap { $0.isEmpty ? nil : $0 } ?? "(无标题)"
        let key = idField.flatMap { record.fields[$0] }.flatMap { $0.isEmpty ? nil : $0 }
            ?? record.autoNumber.map { "#\($0)" }
            ?? record.id
        return Issue(
            record: record,
            title: title,
            body: bodyField.flatMap { record.fields[$0] } ?? "",
            status: statusField.flatMap { record.fields[$0] },
            key: key
        )
    }

    var issues: [Issue] { records.map(issue(for:)) }

    var visibleIssues: [Issue] {
        let query = searchText.trimmingCharacters(in: .whitespaces).lowercased()
        return issues.filter { issue in
            if !query.isEmpty,
               !issue.title.lowercased().contains(query),
               !issue.key.lowercased().contains(query) {
                return false
            }
            for (field, accepted) in fieldFilters where !accepted.isEmpty {
                // Multi-select cells arrive as "a, b" in text format.
                let values = Set((issue.record.fields[field] ?? "").components(separatedBy: ", "))
                if values.isDisjoint(with: accepted) { return false }
            }
            let run = runs[issue.id]
            switch filter {
            case .all: return true
            case .active: return run?.phase.isActive == true
            case .review: return run?.phase == .prOpen
            case .untouched: return run == nil
            }
        }
    }

    /// Select fields with their choices — what the filter menu offers.
    var filterableFields: [TeableField] {
        fields.filter { ($0.type == "singleSelect" || $0.type == "multipleSelect") && !$0.choices.isEmpty }
    }

    var activeFieldFilterCount: Int { fieldFilters.values.filter { !$0.isEmpty }.count }

    func toggleFieldFilter(_ field: String, value: String) {
        var accepted = fieldFilters[field] ?? []
        if accepted.contains(value) { accepted.remove(value) } else { accepted.insert(value) }
        fieldFilters[field] = accepted.isEmpty ? nil : accepted
    }

    func clearFieldFilters() { fieldFilters = [:] }

    var selectedIssues: [Issue] {
        issues.filter { selection.contains($0.id) }
    }

    /// Selected issues a fix can still be queued for: never run, or last run failed / stopped.
    var fixableSelection: [Issue] {
        selectedIssues.filter { issue in
            guard let run = runs[issue.id] else { return true }
            return run.phase == .failed || run.phase == .cancelled
        }
    }

    func selectAllVisible() { selection = Set(visibleIssues.map(\.id)) }

    var selectedIssue: Issue? {
        selectedIssueId.flatMap { id in records.first { $0.id == id } }.map(issue(for:))
    }

    func run(for issue: Issue) -> IssueRun? { runs[issue.id] }

    func transcript(for issue: Issue) -> [ConversationEntry] {
        _ = transcriptGeneration
        return IssueAgentService.shared.transcript(issue.id)
    }

    func isAgentRunning(_ issue: Issue) -> Bool {
        _ = runs[issue.id]
        return IssueAgentService.shared.isRunning(issue.id)
    }

    // MARK: - Actions

    func fix(_ issue: Issue) {
        guard AppState.shared.projectURL != nil else {
            errorMessage = "先在分支页选择 Teable 仓库"
            return
        }
        Notifier.requestAuthorizationIfNeeded()
        let service = IssueAgentService.shared
        Background.run { service.enqueueFix(issue) }
    }

    /// Untouched issues in the current list, in list order — what "全部加入队列" would queue.
    var queueableIssues: [Issue] { visibleIssues.filter { runs[$0.id] == nil } }

    func enqueueAll(_ list: [Issue]) {
        guard AppState.shared.projectURL != nil else {
            errorMessage = "先在分支页选择 Teable 仓库"
            return
        }
        Notifier.requestAuthorizationIfNeeded()
        Background.run { list.forEach(IssueAgentService.shared.enqueueFix) }
    }

    func startNextBatch() {
        Background.run { IssueAgentService.shared.startNextBatch() }
    }

    /// 1-based place in the queue, for queued issues not yet in a batch.
    func queuePosition(_ issue: Issue) -> Int? {
        queue.waiting.firstIndex(of: issue.id).map { $0 + 1 }
    }

    func send(_ message: String, to issue: Issue) {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        perform { try IssueAgentService.shared.send(text, to: issue) }
    }

    func review(_ issue: Issue) {
        perform { try IssueAgentService.shared.review(issue) }
    }

    func sendReviewToAgent(_ issue: Issue) {
        perform { try IssueAgentService.shared.sendLatestReview(to: issue) }
    }

    func postReviewToPR(_ issue: Issue) {
        perform { try IssueAgentService.shared.postLatestReviewToPR(issue.id) }
    }

    func cancel(_ issue: Issue) {
        let id = issue.id
        Background.run { IssueAgentService.shared.cancel(id) }
    }

    func reset(_ issue: Issue) {
        let id = issue.id
        Background.run { IssueAgentService.shared.reset(id) }
    }

    func openInTerminal(_ issue: Issue, terminalApp: String?, agentCommand: String) {
        guard let run = runs[issue.id],
              let path = IssueAgentService.shared.worktreePath(for: run),
              let command = IssueAgentService.shared.resumeCommand(for: issue.id, baseCommand: agentCommand)
        else { return }
        let title = run.branch
        perform { try TerminalService.openAgent(at: path, using: terminalApp, title: title, command: command) }
    }

    func openRecord(_ issue: Issue) {
        if let url = config.recordURL(issue.id) { NSWorkspace.shared.open(url) }
    }

    func openPR(_ issue: Issue) {
        if let prURL = runs[issue.id]?.prURL, let url = URL(string: prURL) { NSWorkspace.shared.open(url) }
    }

    private func perform(_ work: @escaping @Sendable () throws -> Void) {
        Background.run {
            do {
                try work()
            } catch {
                let message = error.localizedDescription
                onMain { self.errorMessage = message }
            }
        }
    }

    // MARK: - Notifications

    private func notifyBatchFinished(_ summary: BatchSummary) {
        var parts = ["\(summary.withPR) 个已提 PR"]
        if summary.approved > 0 { parts.append("\(summary.approved) 个 review 通过") }
        if summary.needsInput > 0 { parts.append("\(summary.needsInput) 个等你回复") }
        if summary.failed > 0 { parts.append("\(summary.failed) 个失败") }
        let body = parts.joined(separator: "，")

        if summary.remaining == 0 {
            Notifier.post(title: "Issue 队列全部完成", body: "最后一批 \(summary.runs.count) 个：\(body)")
        } else if summary.awaitingConfirmation {
            Notifier.post(
                title: "本批 \(summary.runs.count) 个已完成，等你审查",
                body: "\(body)。还有 \(summary.remaining) 个排队，审查后点“开始下一批”。"
            )
        } else {
            Notifier.post(
                title: "本批 \(summary.runs.count) 个已完成",
                body: "\(body)。自动开始下一批，还剩 \(summary.remaining) 个。"
            )
        }
    }

    // MARK: - Auto mode

    /// Re-poll the table every few minutes while auto mode is on, so new issues get picked up
    /// without anyone pressing Refresh.
    private func scheduleAutoMode() {
        autoTimer?.invalidate()
        guard config.autoFix else { return }
        autoTimer = Timer.scheduledTimer(withTimeInterval: 180, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.reload() }
        }
    }

    /// Queue every issue whose status says "fix me" and that has never been touched.
    private func runAutoMode() {
        guard config.autoFix, !config.fixStatuses.isEmpty, AppState.shared.projectURL != nil else { return }
        let wanted = Set(config.fixStatuses)
        for issue in issues where runs[issue.id] == nil {
            guard let status = issue.status, wanted.contains(status) else { continue }
            fix(issue)
        }
    }

    // MARK: - Settings

    func updateConfig(_ mutate: (inout TeableConfig) -> Void) {
        let before = config
        mutate(&config)
        guard config != before else { return }
        SettingsStore.saveTeableConfig(config)
        if config.autoFix != before.autoFix { scheduleAutoMode() }
        let sourceChanged = config.baseURL != before.baseURL || config.tableId != before.tableId
            || config.viewId != before.viewId
            || config.onlyMine != before.onlyMine || config.assigneeField != before.assigneeField
        if sourceChanged, isLoggedIn { reload() }
        if config.autoFix, !before.autoFix || config.fixStatuses != before.fixStatuses { runAutoMode() }
        // Turning auto-next on while a batch is waiting for confirmation should not leave it waiting.
        if config.autoNextBatch, !before.autoNextBatch, queue.awaitingNextBatch { startNextBatch() }
    }

    func loadMagpieModels() {
        let url = config.magpieURL
        Background.run {
            do {
                let models = try AgentRunner.magpieModels(baseURL: url)
                onMain {
                    self.magpieModels = models
                    self.magpieError = nil
                }
            } catch {
                let message = error.localizedDescription
                onMain { self.magpieError = message }
            }
        }
    }
}
