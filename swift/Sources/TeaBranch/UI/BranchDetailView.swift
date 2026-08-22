import Observation
import SwiftUI

/// Env-editor and ngrok state for the branch currently open in the detail pane.
@MainActor
@Observable
final class BranchDetailModel {
    /// Every assignment in the worktree's env file, editable.
    ///
    /// This used to be nine hard-coded fields — the keys TeaBranch generates. But the file is the
    /// worktree's whole environment, and the interesting ones are usually the *other* keys: a
    /// feature flag, an API base, a credential you are swapping for the afternoon. Editing those
    /// meant leaving the app.
    var entries: [EnvFile.Entry] = []
    private var saved: [EnvFile.Entry] = []

    var dbInfos: [WorktreeDbInfo] = []
    var isSaving = false
    var envError: String?
    /// Set after a save that restarted the branch, so the UI can say so.
    var restartNote: String?

    var ngrokBusy = false
    var ngrokError: String?

    var isDirty: Bool { entries != saved }

    /// Whether the env editor is open. Loads lazily the first time.
    var isExpanded = false {
        didSet { if isExpanded, entries.isEmpty { load() } }
    }

    private var branch: String = ""

    func bind(to branch: String) {
        guard branch != self.branch else { return }
        self.branch = branch
        entries = []
        saved = []
        envError = nil
        restartNote = nil
        if isExpanded { load() }
    }

    func load() {
        guard let repo = AppState.shared.projectURL else { return }
        let branch = self.branch

        Background.run {
            do {
                let worktree = try GitService.worktreePath(for: branch, in: repo)
                let entries = EnvFile.entries(in: worktree)
                let infos = GitService.worktreeDbInfo(in: repo)
                onMain {
                    self.entries = entries
                    self.saved = entries
                    self.dbInfos = infos
                    self.envError = nil
                }
            } catch {
                let message = error.localizedDescription
                onMain { self.envError = message }
            }
        }
    }

    func update(_ key: String, to value: String) {
        guard let index = entries.firstIndex(where: { $0.key == key }) else { return }
        entries[index].value = value
    }

    func remove(_ key: String) {
        entries.removeAll { $0.key == key }
    }

    /// Add a key, or focus the existing one. Returns false when the key is unusable.
    @discardableResult
    func add(key rawKey: String, value: String = "") -> Bool {
        let key = rawKey.trimmingCharacters(in: .whitespaces)
        guard !key.isEmpty, !key.contains("="), !key.contains(" ") else { return false }
        guard !entries.contains(where: { $0.key == key }) else { return false }
        entries.append(EnvFile.Entry(key: key, value: value))
        return true
    }

    func reset() {
        entries = saved
    }

    /// Save, then restart the branch if it is running.
    ///
    /// A dev server reads its environment once, at exec. Editing `PORT` or a feature flag and
    /// watching nothing happen is the kind of thing you debug for ten minutes before remembering
    /// why — so the save that changed it is also the thing that restarts it.
    func save(restartIfRunning isRunning: Bool) {
        guard let repo = AppState.shared.projectURL else { return }
        let branch = self.branch
        let entries = self.entries
        isSaving = true
        envError = nil
        restartNote = nil

        // The restart goes through ProcessManager's own queue, like every other start/stop —
        // `Background.io` is for short reads, and a restart is bounded by how long a dev server
        // takes to die and boot.
        ProcessManager.queue.async {
            do {
                let worktree = try GitService.worktreePath(for: branch, in: repo)
                try EnvFile.writeEntries(entries, in: worktree)
                onMain {
                    self.saved = entries
                    self.isSaving = false
                }

                guard isRunning else { return }
                onMain { self.restartNote = "Restarting to pick up the new environment…" }
                try ProcessManager.stop(branch: branch)
                try ProcessManager.start(branch: branch)
                onMain { self.restartNote = nil }
            } catch {
                let message = error.localizedDescription
                onMain {
                    self.envError = message
                    self.isSaving = false
                    self.restartNote = nil
                }
            }
        }
    }

    /// Start a tunnel for this branch, or stop the one that's running on it.
    func toggleNgrok(branch: String, isActiveHere: Bool) {
        ngrokBusy = true
        ngrokError = nil
        let shouldReloadEnv = isExpanded

        Background.run {
            var failure: String?
            if isActiveHere {
                NgrokService.stop()
            } else {
                do {
                    _ = try NgrokService.start(branch: branch)
                } catch {
                    failure = error.localizedDescription
                }
            }
            let message = failure
            onMain {
                self.ngrokBusy = false
                self.ngrokError = message
                // The tunnel writes SANDBOX_TEABLE_ENDPOINT, so refresh the open editor.
                if message == nil, shouldReloadEnv { self.load() }
            }
        }
    }
}

/// The detail pane: what this branch is, what you can do to it, and what it is saying.
///
/// Three bands, in the order you use them. Identity and the one destructive-ish control at the
/// top; the things you reach for constantly on a glass action bar under it; and then the logs,
/// which get every remaining pixel because they are the reason the window is open. Everything
/// referential — ports, database, env, worktree path — moved into the inspector, where it is one
/// click away instead of permanently occupying the top third of the pane.
struct BranchDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var branch: Branch

    @State private var detail = BranchDetailModel()
    @AppStorage("teabranch.inspector") private var showInspector = false

    private var environment: BranchEnvironment? { branch.environment }
    private var isRunning: Bool { branch.status.isLive }
    private var hasWorktree: Bool { branch.effectiveWorktreePath != nil }
    private var isNgrokHere: Bool { model.ngrok?.branchName == branch.name }
    private var isBusy: Bool { model.isBusy(branch.name) }

    var body: some View {
        VStack(spacing: 0) {
            header
            actionBar
            LogPaneView(branch: branch)
        }
        .inspector(isPresented: $showInspector) {
            BranchInspectorView(branch: branch, detail: detail)
                .inspectorColumnWidth(min: 280, ideal: 330, max: 460)
        }
        .onAppear {
            detail.bind(to: branch.name)
            model.refreshUsage()
        }
        .onChange(of: branch.name) { _, name in
            detail.bind(to: name)
            model.refreshUsage()
        }
        // Sampling costs a `ps`, so it only ticks while something is actually running — a window
        // full of stopped branches does no work at all.
        //
        // The refresh happens *before* the guard on purpose: when the last branch stops, this task
        // restarts with an empty id and would otherwise return without ever clearing the previous
        // sample, leaving a stopped branch showing 5.7 GB and a live uptime forever.
        .task(id: model.liveBranches.map(\.id)) {
            model.refreshUsage()
            guard !model.liveBranches.isEmpty else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                if Task.isCancelled { break }
                model.refreshUsage()
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 10) {
            StatusDotView(status: branch.status)

            VStack(alignment: .leading, spacing: 1) {
                Text(branch.name)
                    .font(.system(size: Typography.headline, weight: .semibold))
                    .opticalTracking(Typography.headline)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)

                HStack(spacing: 5) {
                    Text(branch.status.label)
                        .foregroundStyle(
                            branch.status == .stopped
                                ? Palette.textSecondary
                                : Palette.color(for: branch.status)
                        )
                    if let port = environment?.port {
                        separator
                        Text("localhost:\(String(port))")
                            .monospacedDigit()
                            .foregroundStyle(Palette.textSecondary)
                    }
                    // What this branch is actually costing, next to the fact that it is running.
                    // A dev server that has quietly grown to 4GB is the single most useful thing
                    // this header can tell you, and it was only discoverable in Activity Monitor.
                    if let usage = model.usage(for: branch), !usage.isEmpty {
                        separator
                        Text(String(format: "%.0f%% CPU", usage.cpuPercent))
                            .monospacedDigit()
                            .foregroundStyle(usage.cpuPercent >= 150 ? Palette.statusBuilding : Palette.textSecondary)
                        separator
                        Text(ProcessStats.formatBytes(usage.residentBytes))
                            .monospacedDigit()
                            .foregroundStyle(Palette.textSecondary)
                        separator
                        Text("up \(usage.uptime)")
                            .monospacedDigit()
                            .foregroundStyle(Palette.textSecondary)
                    }
                }
                .font(.system(size: Typography.caption))
                .lineLimit(1)
            }

            Spacer(minLength: 8)

            PillButton(
                title: isBusy ? "…" : (isRunning ? "Stop" : "Start"),
                systemImage: isBusy ? nil : (isRunning ? "stop.fill" : "play.fill"),
                tone: isRunning ? .danger : .accent,
                isDisabled: isBusy,
                horizontalPadding: 14,
                accessibilityLabel: isRunning ? "Stop \(branch.name)" : "Start \(branch.name)"
            ) {
                model.toggle(branch: branch)
            }
            .help(isRunning ? "Stop this branch's dev servers" : "Start this branch's dev servers")

            overflowMenu
        }
        .padding(.horizontal, Layout.gutter)
        .padding(.vertical, 9)
        .chromeBackground(reduceTransparency: reduceTransparency)
        .bottomDivider()
    }

    /// Only what is genuinely rare or destructive lives here.
    private var separator: some View {
        Text("·").foregroundStyle(Palette.textTertiary)
    }

    private var overflowMenu: some View {
        Menu {
            Picker("Move to", selection: Binding(
                get: { model.category(for: branch.name) },
                set: { model.setCategory($0, for: branch.name) }
            )) {
                ForEach(DevCategory.allCases, id: \.self) { category in
                    Text(category.label).tag(category)
                }
            }

            Divider()

            Button(showInspector ? "Hide Details" : "Show Details") { showInspector.toggle() }

            Divider()

            Button("Delete Worktree…", role: .destructive) {
                model.confirmDelete(branch: branch)
            }
            .disabled(!hasWorktree)
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: Typography.body, weight: .semibold))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .foregroundStyle(Palette.textSecondary)
        .accessibilityLabel("More actions")
    }

    // MARK: - Action bar

    /// The things you actually reach for, on one glass rail.
    ///
    /// They sit in a `GlassEffectContainer` so adjacent controls blend into a single piece of
    /// material instead of each carrying its own blur — stacked glass is what makes this style
    /// turn to mush.
    private var actionBar: some View {
        GlassEffectContainer(spacing: Layout.glassSpacing) {
            HStack(spacing: Layout.glassSpacing) {
                if branch.status == .running, environment?.port != nil {
                    PillButton(title: "Preview", systemImage: "safari", tone: .dim) {
                        model.openPreview(for: branch)
                    }
                    .help("Open http://<branch>.localhost:\(environment?.port.map(String.init) ?? "") — its own cookie jar")
                }

                if model.canRunAgent {
                    PillButton(
                        title: "Agent",
                        systemImage: "sparkles",
                        tone: .dim,
                        isDisabled: !hasWorktree
                    ) {
                        model.openAgent(for: branch)
                    }
                    .help("Open a terminal tab in this worktree running \(model.settings.agentCommand)")
                }

                PillButton(
                    title: "Terminal",
                    systemImage: model.hasTerminal(branch) ? "terminal.fill" : "terminal",
                    isDisabled: !hasWorktree
                ) {
                    model.openTerminal(for: branch)
                }
                .help(model.hasTerminal(branch)
                      ? "A tab is already open here — this adds another"
                      : "Open this worktree in a terminal tab")

                PillButton(
                    title: "Code",
                    systemImage: "chevron.left.forwardslash.chevron.right",
                    isDisabled: !hasWorktree
                ) {
                    model.openEditor(for: branch)
                }
                .help("Open this worktree in VS Code")

                ngrokButton

                Spacer(minLength: 0)

                PillButton(
                    title: "",
                    systemImage: "sidebar.trailing",
                    tone: showInspector ? .active : .plain,
                    horizontalPadding: 8,
                    accessibilityLabel: showInspector ? "Hide details" : "Show details"
                ) {
                    showInspector.toggle()
                }
                .help("Ports, database and environment overrides")
            }
        }
        .padding(.horizontal, Layout.gutter)
        .padding(.vertical, 8)
        .bottomDivider()
    }

    /// One tunnel exists app-wide, so this is a three-state control: off, on-here, on-elsewhere.
    /// The third state stays enabled — starting here is how you move the tunnel.
    private var ngrokButton: some View {
        let elsewhere = model.ngrok.flatMap { isNgrokHere ? nil : $0.branchName }
        let title: String = {
            if detail.ngrokBusy { return "…" }
            if isNgrokHere { return "Stop ngrok" }
            return "ngrok"
        }()

        return PillButton(
            title: title,
            systemImage: isNgrokHere ? "antenna.radiowaves.left.and.right" : nil,
            tone: isNgrokHere ? .active : .plain,
            isDisabled: detail.ngrokBusy
        ) {
            detail.toggleNgrok(branch: branch.name, isActiveHere: isNgrokHere)
        }
        .help(
            isNgrokHere
                ? (model.ngrok?.publicURL ?? "")
                : elsewhere.map { "ngrok is on \($0) — starting here moves it" }
                    ?? "Tunnel SERVER_PORT and write SANDBOX_TEABLE_ENDPOINT"
        )
    }
}
