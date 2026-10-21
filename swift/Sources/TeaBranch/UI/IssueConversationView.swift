import SwiftUI

/// One issue's whole story as a single conversation, the way agent apps read: your messages on
/// the right, the agent's prose full width, its tool calls folded into one line per stretch of
/// work, and the reviewer's verdict as a card in the flow — not three tabs that split one
/// timeline into pieces you have to put back together.
struct IssueConversationView: View {
    var issue: Issue
    var entries: [ConversationEntry]
    var run: IssueRun?
    var isRunning: Bool
    var fields: [TeableField]
    var onFix: () -> Void
    var onSendReview: () -> Void
    var onPostReview: () -> Void

    var body: some View {
        let items = TranscriptItem.build(from: entries, live: isRunning)

        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    IssueCard(issue: issue, fields: fields, startExpanded: run == nil)

                    if run == nil {
                        startPrompt
                    }

                    ForEach(items) { item in
                        TranscriptItemView(
                            item: item,
                            hasPR: run?.prURL != nil,
                            isRunning: isRunning,
                            onSendReview: onSendReview,
                            onPostReview: onPostReview
                        )
                        .id(item.id)
                    }

                    Color.clear.frame(height: 1).id(Self.bottom)
                }
                .frame(maxWidth: 860)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, Layout.gutter)
                .padding(.vertical, 12)
            }
            .onAppear { proxy.scrollTo(Self.bottom, anchor: .bottom) }
            .onChange(of: entries.count) { _, _ in
                withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(Self.bottom, anchor: .bottom) }
            }
        }
    }

    private static let bottom = "conversation-bottom"

    private var startPrompt: some View {
        VStack(spacing: 10) {
            Image(systemName: "wand.and.stars")
                .font(.system(size: 26, weight: .light))
                .foregroundStyle(Palette.accent)
            Text("让 agent 来修这个 issue")
                .font(.system(size: Typography.headline, weight: .semibold))
            Text("建 worktree → 定位根因并修复 → 提 PR（带 \(issue.key)）→ 自动 review。整个过程会显示在这里，随时可以插话。")
                .font(.system(size: Typography.body))
                .foregroundStyle(Palette.textSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            Button(action: onFix) {
                Label("自动修复", systemImage: "wand.and.stars").frame(minWidth: 110)
            }
            .buttonStyle(.glassProminent)
            .controlSize(.large)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 36)
    }
}

// MARK: - Items

/// A conversation entry, or a run of work entries folded into one line.
enum TranscriptItem: Identifiable {
    case user(ConversationEntry)
    case assistant(ConversationEntry)
    case review(ConversationEntry)
    case error(ConversationEntry)
    case result(ConversationEntry)
    case work(id: UUID, steps: [ConversationEntry], live: Bool, channel: ConversationEntry.Channel)

    var id: UUID {
        switch self {
        case .user(let e), .assistant(let e), .review(let e), .error(let e), .result(let e): return e.id
        case .work(let id, _, _, _): return id
        }
    }

    /// Fold every run of tool calls, tool output and progress lines into one `work` item. The
    /// last run is live while the agent is still going — it is where the eye should be.
    static func build(from entries: [ConversationEntry], live: Bool) -> [TranscriptItem] {
        var items: [TranscriptItem] = []
        var pending: [ConversationEntry] = []

        func flush() {
            guard let first = pending.first else { return }
            items.append(.work(id: first.id, steps: pending, live: false, channel: first.channel))
            pending = []
        }

        for entry in entries {
            switch entry.kind {
            case .tool, .toolResult, .system:
                // A channel change starts a new fold: the fixer's work and the reviewer's are
                // different stories even when they are adjacent.
                if let last = pending.last, last.channel != entry.channel { flush() }
                pending.append(entry)
            case .user: flush(); items.append(.user(entry))
            case .assistant: flush(); items.append(.assistant(entry))
            case .review: flush(); items.append(.review(entry))
            case .error: flush(); items.append(.error(entry))
            case .result: flush(); items.append(.result(entry))
            }
        }
        flush()

        if live, case .work(let id, let steps, _, let channel)? = items.last {
            items[items.count - 1] = .work(id: id, steps: steps, live: true, channel: channel)
        }
        return items
    }
}

/// What a stretch of work was for, at a glance: look, change, run, delegate.
enum WorkKind: CaseIterable {
    case read, edit, run, agent, setup, other

    init(tool entry: ConversationEntry) {
        guard entry.kind == .tool else {
            self = .setup
            return
        }
        let name = entry.text.split(separator: " ", maxSplits: 1).first.map(String.init) ?? ""
        switch name {
        case "Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "NotebookRead": self = .read
        case "Edit", "MultiEdit", "Write", "NotebookEdit": self = .edit
        case "Bash", "BashOutput", "KillShell": self = .run
        case "Task", "Agent": self = .agent
        default: self = .other
        }
    }

    var symbol: String {
        switch self {
        case .read: return "magnifyingglass"
        case .edit: return "pencil"
        case .run: return "terminal"
        case .agent: return "person.2"
        case .setup: return "gearshape"
        case .other: return "wrench.and.screwdriver"
        }
    }

    var label: String {
        switch self {
        case .read: return "查看"
        case .edit: return "编辑"
        case .run: return "运行"
        case .agent: return "子 agent"
        case .setup: return "步骤"
        case .other: return "工具"
        }
    }
}

// MARK: - Views

private struct TranscriptItemView: View {
    var item: TranscriptItem
    var hasPR: Bool
    var isRunning: Bool
    var onSendReview: () -> Void
    var onPostReview: () -> Void

    var body: some View {
        switch item {
        case .user(let entry):
            HStack {
                Spacer(minLength: 80)
                MarkdownText(entry.text)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Palette.accentDim, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        case .assistant(let entry):
            MarkdownText(entry.text)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .review(let entry):
            ReviewCard(entry: entry, hasPR: hasPR, isRunning: isRunning, onSend: onSendReview, onPost: onPostReview)
        case .error(let entry):
            Label {
                Text(entry.text).textSelection(.enabled)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
            }
            .font(.system(size: Typography.small))
            .foregroundStyle(Palette.statusError)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.statusErrorDim, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        case .result(let entry):
            HStack(spacing: 6) {
                Image(systemName: entry.isError ? "xmark.circle" : "checkmark.circle")
                Text(entry.text)
            }
            .font(.system(size: Typography.caption).monospacedDigit())
            .foregroundStyle(entry.isError ? Palette.statusError : Palette.textTertiary)
        case .work(_, let steps, let live, let channel):
            WorkFold(steps: steps, live: live, isReview: channel == .review)
        }
    }
}

/// One line for a stretch of tool calls — "查看 5 · 编辑 2 · 运行 3" — that opens into the steps.
private struct WorkFold: View {
    var steps: [ConversationEntry]
    var live: Bool
    var isReview: Bool

    @State private var open = false

    private var tools: [ConversationEntry] { steps.filter { $0.kind == .tool } }

    /// The kind most of this stretch was spent on picks the icon.
    private var dominant: WorkKind {
        let kinds = steps.filter { $0.kind != .toolResult }.map(WorkKind.init(tool:))
        return WorkKind.allCases.max { a, b in
            kinds.filter { $0 == a }.count < kinds.filter { $0 == b }.count
        } ?? .other
    }

    private var summary: String {
        let kinds = tools.map(WorkKind.init(tool:))
        let counts = WorkKind.allCases.compactMap { kind -> String? in
            let n = kinds.filter { $0 == kind }.count
            return n > 0 ? "\(kind.label) \(n)" : nil
        }
        if counts.isEmpty {
            // A stretch of pipeline progress: its newest line says where it got to.
            return steps.last.map { AgentRunner.truncate($0.text, 80) } ?? ""
        }
        return counts.joined(separator: " · ")
    }

    private var hasFailure: Bool { steps.contains { $0.isError } }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.easeOut(duration: 0.15)) { open.toggle() }
            } label: {
                HStack(spacing: 7) {
                    Group {
                        if open {
                            Image(systemName: "chevron.down")
                        } else if live {
                            ProgressView().controlSize(.mini)
                        } else {
                            Image(systemName: isReview ? "checkmark.seal" : dominant.symbol)
                        }
                    }
                    .frame(width: 14)

                    Text(isReview ? "Reviewer · \(summary)" : summary)
                        .lineLimit(1)
                    if live, let last = steps.last(where: { $0.kind != .toolResult }) {
                        Text(AgentRunner.truncate(last.text, 90))
                            .lineLimit(1)
                            .foregroundStyle(Palette.textTertiary)
                    }
                    if hasFailure, !live {
                        Image(systemName: "exclamationmark.circle")
                            .foregroundStyle(Palette.statusError)
                    }
                    Spacer(minLength: 0)
                }
                .font(.system(size: Typography.small))
                .foregroundStyle(Palette.textSecondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if open {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(steps) { step in
                        StepRow(entry: step)
                    }
                }
                .padding(.leading, 21)
                .padding(.vertical, 4)
                .overlay(alignment: .leading) {
                    Rectangle().fill(Palette.border).frame(width: 1).padding(.leading, 6)
                }
            }
        }
    }
}

private struct StepRow: View {
    var entry: ConversationEntry

    var body: some View {
        switch entry.kind {
        case .tool:
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: WorkKind(tool: entry).symbol)
                    .font(.system(size: Typography.micro))
                    .frame(width: 12)
                Text(entry.text)
                    .font(.system(size: Typography.small, design: .monospaced))
                    .lineLimit(2)
                    .textSelection(.enabled)
            }
            .foregroundStyle(Palette.textSecondary)
        case .toolResult:
            Text(entry.text)
                .font(.system(size: Typography.caption, design: .monospaced))
                .foregroundStyle(entry.isError ? Palette.logError : Palette.textTertiary)
                .lineLimit(4)
                .textSelection(.enabled)
                .padding(.leading, 18)
        default:
            Text(entry.text)
                .font(.system(size: Typography.small))
                .foregroundStyle(entry.isError ? Palette.logError : Palette.textTertiary)
                .lineLimit(3)
                .textSelection(.enabled)
        }
    }
}

private struct ReviewCard: View {
    var entry: ConversationEntry
    var hasPR: Bool
    var isRunning: Bool
    var onSend: () -> Void
    var onPost: () -> Void

    private var approved: Bool { IssueAgentService.isApproved(entry.text) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.seal.fill").foregroundStyle(Palette.statusAgent)
                Text("Code review").font(.system(size: Typography.body, weight: .semibold))
                Text(approved ? "通过" : "需要修改")
                    .font(.system(size: Typography.caption, weight: .semibold))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .foregroundStyle(approved ? Palette.statusRunning : Palette.statusBuilding)
                    .background((approved ? Palette.statusRunning : Palette.statusBuilding).opacity(0.14), in: Capsule())
                Spacer()
            }
            MarkdownText(entry.text)
            if !approved || hasPR {
                HStack(spacing: Layout.glassSpacing) {
                    if !approved {
                        PillButton(title: "发给 agent 修改", systemImage: "arrowshape.turn.up.left", isDisabled: isRunning, action: onSend)
                    }
                    if hasPR {
                        PillButton(title: "发布到 PR", systemImage: "text.bubble", action: onPost)
                    }
                }
            }
        }
        .padding(14)
        .background(Palette.statusAgent.opacity(0.06), in: RoundedRectangle(cornerRadius: Palette.cornerRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Palette.cornerRadius, style: .continuous)
                .strokeBorder(Palette.statusAgent.opacity(0.25), lineWidth: 1)
        }
    }
}

/// The issue itself, at the head of its conversation. Folded once work has started — by then
/// it is reference, not the thing you are reading.
private struct IssueCard: View {
    var issue: Issue
    var fields: [TeableField]
    var startExpanded: Bool

    @State private var expanded: Bool?

    private var isOpen: Bool { expanded ?? startExpanded }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(.easeOut(duration: 0.15)) { expanded = !isOpen }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: isOpen ? "chevron.down" : "chevron.right")
                        .frame(width: 12)
                    Image(systemName: "doc.text")
                    Text("Issue 描述")
                        .font(.system(size: Typography.small, weight: .semibold))
                    if !isOpen, !issue.body.isEmpty {
                        Text(issue.body.replacingOccurrences(of: "\n", with: " "))
                            .lineLimit(1)
                            .foregroundStyle(Palette.textTertiary)
                    }
                    Spacer(minLength: 0)
                }
                .font(.system(size: Typography.small))
                .foregroundStyle(Palette.textSecondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isOpen {
                if !issue.body.isEmpty {
                    MarkdownText(issue.body)
                }
                // Everything else the table knows, compactly.
                let extra = fields.filter { field in
                    !(issue.record.fields[field.name] ?? "").isEmpty && issue.record.fields[field.name] != issue.body
                        && issue.record.fields[field.name] != issue.title
                }
                if !extra.isEmpty {
                    Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 5) {
                        ForEach(extra) { field in
                            GridRow {
                                Text(field.name)
                                    .foregroundStyle(Palette.textTertiary)
                                Text(issue.record.fields[field.name] ?? "")
                                    .lineLimit(3)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                    .font(.system(size: Typography.small))
                }
            }
        }
        .padding(12)
        .background(Palette.fillSubtle, in: RoundedRectangle(cornerRadius: Palette.cornerRadius, style: .continuous))
    }
}

/// Markdown prose: inline styling and links, line breaks kept.
struct MarkdownText: View {
    var text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(
            (try? AttributedString(
                markdown: text,
                options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
            )) ?? AttributedString(text)
        )
        .font(.system(size: Typography.body))
        .lineSpacing(3)
        .textSelection(.enabled)
    }
}
