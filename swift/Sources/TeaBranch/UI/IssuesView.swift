import SwiftUI

/// Switches the window between the branch list and the issue table. Lives at the top of each
/// sidebar so it stays in the same place whichever side is showing.
struct SectionSwitcher: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Picker("", selection: $model.section) {
            Text("分支").tag(AppModel.Section.branches)
            Text("Issues").tag(AppModel.Section.issues)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .controlSize(.small)
    }
}

// MARK: - Sidebar

struct IssueSidebarView: View {
    @Environment(IssuesModel.self) private var issues
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        @Bindable var issues = issues

        VStack(spacing: 0) {
            VStack(spacing: Layout.glassSpacing) {
                SectionSwitcher()
                HStack(spacing: Layout.glassSpacing) {
                    HStack(spacing: 6) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: Typography.small, weight: .medium))
                            .foregroundStyle(Palette.textSecondary)
                        TextField("搜索 issue", text: $issues.searchText)
                            .textFieldStyle(.plain)
                            .font(.system(size: Typography.body))
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .glassSurface(Surface.chrome, in: Capsule(), reduceTransparency: reduceTransparency)

                    fieldFilterMenu
                }

                Picker("", selection: $issues.filter) {
                    ForEach(IssuesModel.Filter.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .controlSize(.small)

                HStack(spacing: 6) {
                    Toggle(isOn: Binding(
                        get: { issues.config.onlyMine },
                        set: { on in issues.updateConfig { $0.onlyMine = on } }
                    )) {
                        Text("只看我的")
                    }
                    .toggleStyle(.checkbox)
                    if issues.config.onlyMine, let field = issues.assigneeField {
                        Text("（\(field) = 我）")
                            .foregroundStyle(Palette.textSecondary)
                    }
                    Spacer(minLength: 0)
                    if issues.isLoggedIn {
                        Text("\(issues.visibleIssues.count) 个")
                            .monospacedDigit()
                            .foregroundStyle(Palette.textSecondary)
                        Button("全选") { issues.selectAllVisible() }
                            .buttonStyle(.link)
                            .disabled(issues.visibleIssues.isEmpty)
                            .help("选中列表里的全部 issue（⌘A），再到右边“全部修复”")
                    }
                }
                .font(.system(size: Typography.caption))
                .padding(.horizontal, 2)
            }
            .padding(.horizontal, 10)
            .padding(.top, 30)
            .padding(.bottom, 8)

            if !issues.isLoggedIn {
                placeholder("未登录 Teable", symbol: "person.crop.circle.badge.questionmark")
            } else if issues.visibleIssues.isEmpty {
                placeholder(issues.isLoading ? "加载中…" : "没有 issue", symbol: "tray")
            } else {
                List(selection: $issues.selection) {
                    ForEach(issues.visibleIssues) { issue in
                        IssueRow(issue: issue, run: issues.run(for: issue), queuePosition: issues.queuePosition(issue))
                            .tag(issue.id)
                    }
                }
                .listStyle(.sidebar)
                .scrollContentBackground(.hidden)
            }

            if issues.isLoggedIn { QueueBar() }
            bottomBar
        }
    }

    /// Filter by any select column — 状态, Type, 优先级 — with the active count on the button.
    private var fieldFilterMenu: some View {
        Menu {
            if issues.filterableFields.isEmpty {
                Text("没有可筛选的单选/多选字段")
            }
            ForEach(issues.filterableFields) { field in
                Menu(field.name) {
                    ForEach(field.choices, id: \.self) { choice in
                        Toggle(choice, isOn: Binding(
                            get: { issues.fieldFilters[field.name]?.contains(choice) == true },
                            set: { _ in issues.toggleFieldFilter(field.name, value: choice) }
                        ))
                    }
                }
            }
            if issues.activeFieldFilterCount > 0 {
                Divider()
                Button("清除筛选") { issues.clearFieldFilters() }
            }
        } label: {
            Image(systemName: issues.activeFieldFilterCount > 0
                  ? "line.3.horizontal.decrease.circle.fill"
                  : "line.3.horizontal.decrease.circle")
                .foregroundStyle(issues.activeFieldFilterCount > 0 ? Palette.accent : Palette.textSecondary)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(issues.activeFieldFilterCount > 0
              ? issues.fieldFilters.map { "\($0.key): \($0.value.sorted().joined(separator: "/"))" }.sorted().joined(separator: "；")
              : "按字段筛选")
    }

    private func placeholder(_ title: String, symbol: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: 26, weight: .light))
                .foregroundStyle(Palette.textTertiary)
            Text(title)
                .font(.system(size: Typography.body))
                .foregroundStyle(Palette.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var bottomBar: some View {
        HStack(spacing: 8) {
            if let user = issues.user {
                Text(user.name)
                    .lineLimit(1)
                    .font(.system(size: Typography.caption))
                    .foregroundStyle(Palette.textSecondary)
            }
            let active = issues.runs.values.filter { $0.phase.isActive }.count
            if active > 0 {
                Text("· \(active) 进行中")
                    .font(.system(size: Typography.caption))
                    .foregroundStyle(Palette.statusAgent)
            }
            Spacer(minLength: 0)

            Button {
                issues.reload()
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.plain)
            .disabled(!issues.isLoggedIn || issues.isLoading)
            .help("刷新")

            Menu {
                let queueable = issues.queueableIssues
                Button("把列表里 \(queueable.count) 个未处理的加入队列") { issues.enqueueAll(queueable) }
                    .disabled(queueable.isEmpty)
                Divider()
                Button("Issue 设置…") { issues.showSettings = true }
                if issues.isLoggedIn {
                    Button("退出 Teable") { issues.signOut() }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
        }
        .font(.system(size: Typography.body))
        .foregroundStyle(Palette.textSecondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .chromeBackground(reduceTransparency: reduceTransparency)
    }
}

/// The batch in progress and what is queued behind it, with the go-ahead for the next batch.
struct QueueBar: View {
    @Environment(IssuesModel.self) private var issues

    var body: some View {
        let queue = issues.queue
        if !queue.batch.isEmpty || !queue.waiting.isEmpty {
            HStack(spacing: 8) {
                if queue.awaitingNextBatch {
                    Image(systemName: "pause.circle.fill").foregroundStyle(Palette.statusBuilding)
                    Text("本批已完成，等你审查")
                    Spacer(minLength: 0)
                    PillButton(title: "开始下一批", systemImage: "play.fill", tone: .accent, horizontalPadding: 8) {
                        issues.startNextBatch()
                    }
                    .help("从排队的 \(queue.waiting.count) 个里取下一批 \(min(queue.waiting.count, issues.config.batchSize)) 个")
                } else if !queue.batch.isEmpty {
                    ProgressView(value: Double(queue.settled), total: Double(queue.batch.count))
                        .frame(width: 44)
                    Text("本批 \(queue.settled)/\(queue.batch.count) 完成")
                    Spacer(minLength: 0)
                }
                if !queue.waiting.isEmpty, !queue.awaitingNextBatch {
                    Text("排队 \(queue.waiting.count)")
                }
            }
            .font(.system(size: Typography.caption, weight: .medium))
            .foregroundStyle(Palette.textSecondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(Palette.fillSubtle)
        }
    }
}

struct IssueRow: View {
    var issue: Issue
    var run: IssueRun?
    var queuePosition: Int? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(issue.key)
                    .font(.system(size: Typography.caption, weight: .medium).monospacedDigit())
                    .foregroundStyle(Palette.textSecondary)
                if let status = issue.status, !status.isEmpty {
                    Text(status)
                        .font(.system(size: Typography.micro, weight: .medium))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Palette.fillSubtle, in: Capsule())
                }
                Spacer(minLength: 0)
                if let queuePosition {
                    Text("排队第 \(queuePosition)")
                        .font(.system(size: Typography.micro, weight: .medium))
                        .foregroundStyle(Palette.textSecondary)
                } else if let run {
                    PhaseBadge(phase: run.phase)
                }
            }
            Text(issue.title)
                .font(.system(size: Typography.body))
                .lineLimit(2)
        }
        .padding(.vertical, 3)
    }
}

struct PhaseBadge: View {
    var phase: IssuePhase

    var body: some View {
        HStack(spacing: 4) {
            if phase.isActive {
                ProgressView().controlSize(.mini)
            } else {
                Circle().fill(color).frame(width: 6, height: 6)
            }
            Text(phase.label)
        }
        .font(.system(size: Typography.micro, weight: .medium))
        .foregroundStyle(color)
    }

    private var color: Color {
        switch phase {
        case .queued, .preparing, .fixing, .reviewing: return Palette.statusAgent
        case .prOpen: return Palette.statusRunning
        case .finished, .cancelled: return Palette.textSecondary
        case .failed: return Palette.statusError
        }
    }
}

// MARK: - Detail

struct IssuesDetailView: View {
    @Environment(IssuesModel.self) private var issues

    var body: some View {
        if !issues.isLoggedIn {
            TeableLoginView()
        } else if issues.selection.count > 1 {
            BatchSelectionView()
        } else if let issue = issues.selectedIssue {
            IssueDetailView(issue: issue)
                .id(issue.id)
        } else {
            VStack(spacing: 8) {
                Image(systemName: "ladybug")
                    .font(.system(size: 34, weight: .light))
                    .foregroundStyle(Palette.textTertiary)
                Text("选择一个 issue")
                    .font(.system(size: Typography.headline, weight: .medium))
                Text("点“自动修复”：建 worktree → agent 修复 → 提 PR → 自动 review，你只负责审查。")
                    .font(.system(size: Typography.body))
                    .foregroundStyle(Palette.textSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 380)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// Several issues selected: queue them all, with the batch window right here.
struct BatchSelectionView: View {
    @Environment(IssuesModel.self) private var issues

    var body: some View {
        let selected = issues.selectedIssues
        let fixable = issues.fixableSelection
        let batchSize = max(1, issues.config.batchSize)
        let batches = Int((Double(fixable.count) / Double(batchSize)).rounded(.up))

        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("已选 \(selected.count) 个 issue")
                    .font(.system(size: Typography.title, weight: .bold))
                Text(fixable.count == selected.count
                     ? "全部可以加入修复队列。"
                     : "\(fixable.count) 个可以修复，另外 \(selected.count - fixable.count) 个已经在处理或已有结果。")
                    .font(.system(size: Typography.body))
                    .foregroundStyle(Palette.textSecondary)
            }

            VStack(alignment: .leading, spacing: 10) {
                Stepper(value: Binding(
                    get: { issues.config.batchSize },
                    set: { value in issues.updateConfig { $0.batchSize = value } }
                ), in: 1...10) {
                    Text("每批同时修复 **\(batchSize)** 个")
                }
                Toggle("一批全部完成后自动开始下一批", isOn: Binding(
                    get: { issues.config.autoNextBatch },
                    set: { value in issues.updateConfig { $0.autoNextBatch = value } }
                ))
                Text(issues.config.autoNextBatch
                     ? "共 \(batches) 批，一直跑到队列清空。每批结束和全部结束都会发系统通知。"
                     : "共 \(batches) 批。每批结束发系统通知并暂停，你审查完点“开始下一批”。")
                    .font(.system(size: Typography.small))
                    .foregroundStyle(Palette.textSecondary)
            }
            .font(.system(size: Typography.body))
            .padding(14)
            .background(Palette.fillSubtle, in: RoundedRectangle(cornerRadius: Palette.cornerRadius, style: .continuous))

            HStack {
                PillButton(
                    title: "全部修复（\(fixable.count)）",
                    systemImage: "wand.and.stars",
                    tone: .accent,
                    isDisabled: fixable.isEmpty
                ) {
                    issues.enqueueAll(fixable)
                    issues.selection = []
                }
                PillButton(title: "取消选择", systemImage: "xmark") { issues.selection = [] }
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(selected) { issue in
                        HStack(spacing: 8) {
                            Text(issue.key)
                                .font(.system(size: Typography.small, weight: .medium).monospacedDigit())
                                .foregroundStyle(Palette.textSecondary)
                                .frame(width: 60, alignment: .leading)
                            Text(issue.title)
                                .font(.system(size: Typography.body))
                                .lineLimit(1)
                            Spacer(minLength: 0)
                            if let run = issues.run(for: issue) { PhaseBadge(phase: run.phase) }
                        }
                    }
                }
            }
        }
        .padding(24)
        .frame(maxWidth: 640, maxHeight: .infinity, alignment: .topLeading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct IssueDetailView: View {
    var issue: Issue

    @Environment(IssuesModel.self) private var issues
    @Environment(AppModel.self) private var model

    @State private var draft = ""

    private var run: IssueRun? { issues.run(for: issue) }
    private var running: Bool { issues.isAgentRunning(issue) }
    private var busy: Bool { running || run?.phase == .queued || run?.phase == .preparing }

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, Layout.gutter)
                .padding(.top, 12)
                .padding(.bottom, 10)

            Divider().opacity(0.5)

            IssueConversationView(
                issue: issue,
                entries: issues.transcript(for: issue),
                run: run,
                isRunning: busy,
                fields: issues.fields,
                onFix: { issues.fix(issue) },
                onSendReview: { issues.sendReviewToAgent(issue) },
                onPostReview: { issues.postReviewToPR(issue) }
            )

            if run != nil { composer }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    // MARK: Header

    /// Two compact lines: what this is, then where it stands — with the actions at the right,
    /// as icons, so the conversation gets the height.
    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(issue.key)
                        .font(.system(size: Typography.small, weight: .semibold).monospacedDigit())
                        .foregroundStyle(Palette.textSecondary)
                    Text(issue.title)
                        .font(.system(size: Typography.headline, weight: .semibold))
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .help(issue.title)
                }
                HStack(spacing: 10) {
                    if let run {
                        PhaseBadge(phase: run.phase)
                        chip(run.branch, symbol: "arrow.triangle.branch") {
                            model.section = .branches
                            model.selectedBranch = run.branch
                        }
                        .help("在分支页打开：dev server、预览")
                        if let prURL = run.prURL {
                            chip(Self.prLabel(prURL), symbol: "arrow.triangle.pull") { issues.openPR(issue) }
                                .help(prURL)
                        }
                        if run.costUSD > 0 {
                            Text(String(format: "$%.2f", run.costUSD))
                                .monospacedDigit()
                                .foregroundStyle(Palette.textTertiary)
                                .help("Claude 报告的累计花费")
                        }
                    } else if let status = issue.status, !status.isEmpty {
                        Text(status).foregroundStyle(Palette.textSecondary)
                    }
                }
                .font(.system(size: Typography.caption))
            }

            Spacer(minLength: 8)

            actions
        }
    }

    private func chip(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .lineLimit(1)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Palette.fillSubtle, in: Capsule())
        }
        .buttonStyle(.plain)
        .foregroundStyle(Palette.textSecondary)
    }

    private static func prLabel(_ url: String) -> String {
        url.split(separator: "/").last.map { "PR #\($0)" } ?? "PR"
    }

    private var actions: some View {
        HStack(spacing: Layout.glassSpacing) {
            if busy {
                PillButton(title: "停止", systemImage: "stop.fill", tone: .danger) { issues.cancel(issue) }
            } else if run?.phase == .failed || run?.phase == .cancelled {
                PillButton(title: "重试", systemImage: "arrow.clockwise", tone: .accent) { issues.fix(issue) }
            }

            if run != nil {
                PillButton(title: "", systemImage: "checkmark.seal", isDisabled: running, horizontalPadding: 8, accessibilityLabel: "Review") {
                    issues.review(issue)
                }
                .help("用 \(issues.config.reviewEngine.label) review 当前分支")

                PillButton(title: "", systemImage: "terminal", isDisabled: running, horizontalPadding: 8, accessibilityLabel: "在终端继续") {
                    issues.openInTerminal(issue, terminalApp: model.settings.terminalApp, agentCommand: model.settings.agentCommand)
                }
                .help("在终端里 claude --resume 这个 issue 的会话")
            }

            PillButton(title: "", systemImage: "safari", horizontalPadding: 8, accessibilityLabel: "在 Teable 打开") {
                issues.openRecord(issue)
            }
            .help("在 Teable 打开")

            if run != nil {
                Menu {
                    Button("重置会话记录", role: .destructive) { issues.reset(issue) }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .disabled(running)
                .help("更多")
            }
        }
    }

    // MARK: Composer

    private var composer: some View {
        ComposerView(
            text: $draft,
            placeholder: "给 \(issue.key) 的 agent 发消息",
            isEnabled: true,
            isRunning: busy,
            onSend: send,
            onStop: { issues.cancel(issue) }
        ) {
            if let run {
                Label(issues.config.fixModel.label, systemImage: "cpu")
                    .foregroundStyle(Palette.textSecondary)
                Text("会话 \(run.sessionId.prefix(8))")
                    .foregroundStyle(Palette.textTertiary)
                    .textSelection(.enabled)
                    .help("claude --resume \(run.sessionId)")
            }
        }
    }

    private func send() {
        guard run != nil, !running else { return }
        issues.send(draft, to: issue)
        draft = ""
    }
}

// MARK: - Login

struct TeableLoginView: View {
    @Environment(IssuesModel.self) private var issues

    @State private var token = ""
    @State private var baseURL = ""

    var body: some View {
        VStack(spacing: 22) {
            VStack(spacing: 8) {
                Image(systemName: "tablecells.badge.ellipsis")
                    .font(.system(size: 40, weight: .regular))
                    .foregroundStyle(Palette.accent)
                Text("登录 Teable")
                    .font(.system(size: Typography.title, weight: .bold))
                Text("用个人访问令牌登录，读取 issue 表并回写 PR 链接。\n令牌需要 table / field / record 读取和 record 更新权限，保存在钥匙串里。")
                    .font(.system(size: Typography.body))
                    .foregroundStyle(Palette.textSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 420)
            }

            VStack(alignment: .leading, spacing: 8) {
                TextField("https://app.teable.ai", text: $baseURL)
                    .textFieldStyle(.roundedBorder)
                SecureField("Personal access token", text: $token)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(signIn)
                Button("创建令牌…") { issues.openTokenPage() }
                    .buttonStyle(.link)
                    .font(.system(size: Typography.small))
            }
            .frame(width: 360)

            Button {
                signIn()
            } label: {
                if issues.isSigningIn {
                    ProgressView().controlSize(.small).frame(minWidth: 120)
                } else {
                    Text("登录").frame(minWidth: 120)
                }
            }
            .buttonStyle(.glassProminent)
            .controlSize(.large)
            .disabled(token.isEmpty || issues.isSigningIn)
            .keyboardShortcut(.defaultAction)

            if let error = issues.errorMessage {
                Text(error)
                    .font(.system(size: Typography.body))
                    .foregroundStyle(Palette.statusError)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 420)
                    .textSelection(.enabled)
            }
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { baseURL = issues.config.baseURL }
    }

    private func signIn() {
        issues.signIn(token: token, baseURL: baseURL)
    }
}
