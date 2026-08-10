import Observation
import SwiftUI

/// Env-editor and ngrok state for the branch currently open in the detail pane.
@MainActor
@Observable
final class BranchDetailModel {
    var draft: WorktreeEnvOverrides?
    var saved: WorktreeEnvOverrides?
    var dbInfos: [WorktreeDbInfo] = []
    var isDirty = false
    var isSaving = false
    var envError: String?

    var ngrokBusy = false
    var ngrokError: String?

    var isExpanded = false {
        didSet { if isExpanded, draft == nil { load() } }
    }

    private var branch: String = ""

    func bind(to branch: String) {
        guard branch != self.branch else { return }
        self.branch = branch
        draft = nil
        saved = nil
        isDirty = false
        envError = nil
        if isExpanded { load() }
    }

    func load() {
        guard let repo = AppState.shared.projectURL else { return }
        let branch = self.branch

        Background.run {
            do {
                let worktree = try GitService.worktreePath(for: branch, in: repo)
                let overrides = EnvFile.overrides(in: worktree)
                let infos = GitService.worktreeDbInfo(in: repo)
                onMain {
                    self.draft = overrides
                    self.saved = overrides
                    self.dbInfos = infos
                    self.isDirty = false
                    self.envError = nil
                }
            } catch {
                let message = error.localizedDescription
                onMain { self.envError = message }
            }
        }
    }

    func update(_ keyPath: WritableKeyPath<WorktreeEnvOverrides, String?>, to value: String) {
        guard draft != nil else { return }
        draft?[keyPath: keyPath] = value
        isDirty = true
    }

    func reset() {
        draft = saved
        isDirty = false
    }

    func save() {
        guard let draft, let repo = AppState.shared.projectURL else { return }
        let branch = self.branch
        isSaving = true
        envError = nil

        Background.run {
            do {
                let worktree = try GitService.worktreePath(for: branch, in: repo)
                try EnvFile.writeOverrides(draft, in: worktree)
                onMain {
                    self.saved = draft
                    self.isDirty = false
                    self.isSaving = false
                }
            } catch {
                let message = error.localizedDescription
                onMain {
                    self.envError = message
                    self.isSaving = false
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

struct BranchDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var branch: Branch

    @State private var detail = BranchDetailModel()
    @State private var isScrolled = false

    private static let scrollSpace = "branchDetail"

    private var environment: BranchEnvironment? { branch.environment }
    private var isRunning: Bool { branch.status.isLive }
    private var hasWorktree: Bool { branch.effectiveWorktreePath != nil }
    private var isNgrokHere: Bool { model.ngrok?.branchName == branch.name }

    var body: some View {
        VStack(spacing: 0) {
            infoRegion
                .safeAreaInset(edge: .top, spacing: 0) { header }
            LogPaneView(branch: branch)
        }
        .onAppear { detail.bind(to: branch.name) }
        .onChange(of: branch.name) { _, name in detail.bind(to: name) }
    }

    // MARK: - Header

    /// Back, identity, one primary action, and everything else a level deeper. The previous header
    /// put seven same-weight buttons on a 420pt row, which left the branch name — the thing the
    /// screen is about — with the least space of anything on it.
    private var header: some View {
        HStack(spacing: 8) {
            PillButton(
                title: "",
                systemImage: "chevron.left",
                horizontalPadding: 7,
                accessibilityLabel: "Back to branches"
            ) {
                model.selectedBranch = nil
            }
            .keyboardShortcut("[", modifiers: .command)
            .help("Back (⌘[)")

            HStack(spacing: 5) {
                StatusDotView(status: branch.status)
                Text(branch.name)
                    .font(.system(size: 13, weight: .semibold))
                    .opticalTracking(13)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            PillButton(
                title: model.isBusy(branch.name) ? "…" : (isRunning ? "Stop" : "Start"),
                tone: isRunning ? .danger : .dim,
                isDisabled: model.isBusy(branch.name),
                horizontalPadding: 12,
                accessibilityLabel: isRunning ? "Stop \(branch.name)" : "Start \(branch.name)"
            ) {
                model.toggle(branch: branch)
            }

            overflowMenu
        }
        .padding(.leading, Layout.trafficLightInset)
        .padding(.trailing, Layout.gutter)
        .padding(.vertical, 8)
        .chromeBackground(reduceTransparency: reduceTransparency)
        .scrollEdgeDivider(isVisible: isScrolled)
    }

    private var overflowMenu: some View {
        Menu {
            if hasWorktree {
                Button(isNgrokHere ? "Stop ngrok Tunnel" : "Start ngrok Tunnel") {
                    detail.toggleNgrok(branch: branch.name, isActiveHere: isNgrokHere)
                }
                .disabled(detail.ngrokBusy)

                if let tunnel = model.ngrok, !isNgrokHere {
                    Text("ngrok is on \(tunnel.branchName)")
                }

                Divider()
            }

            Picker("Move to", selection: Binding(
                get: { model.category(for: branch.name) },
                set: { model.setCategory($0, for: branch.name) }
            )) {
                ForEach(DevCategory.allCases, id: \.self) { category in
                    Text(category.label).tag(category)
                }
            }

            Divider()

            Button("Delete Worktree…", role: .destructive) {
                model.confirmDelete(branch: branch)
            }
            .disabled(!hasWorktree)
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 11, weight: .semibold))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .foregroundStyle(isNgrokHere ? Palette.accent : Palette.textSecondary)
        .accessibilityLabel("More actions")
    }

    // MARK: - Info

    private var infoRegion: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if isNgrokHere, let tunnel = model.ngrok {
                    tunnelRow(tunnel)
                }
                if let error = detail.ngrokError {
                    inlineError(error)
                }

                statusRow
                portsRow
                worktreeRow
                envSection
            }
            .padding(.horizontal, Layout.gutter)
            .padding(.top, 12)
            .padding(.bottom, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .reportsScrollEdge(in: Self.scrollSpace)
        }
        .coordinateSpace(name: Self.scrollSpace)
        .onPreferenceChange(ScrollEdgeKey.self) { offset in
            let scrolled = offset > 1
            guard scrolled != isScrolled else { return }
            isScrolled = scrolled
        }
        .frame(maxHeight: 300)
        .bottomDivider()
    }

    private var statusRow: some View {
        HStack(alignment: .top, spacing: 16) {
            field("Status") { StatusBadgeView(status: branch.status) }
            field("Lane") {
                CategoryPickerView(value: model.category(for: branch.name)) { category in
                    model.setCategory(category, for: branch.name)
                }
            }
            Spacer(minLength: 0)
        }
    }

    private var portsRow: some View {
        HStack(alignment: .top, spacing: 16) {
            field("Ports") { portsView }
            field("Database") {
                Text(environment?.databaseName ?? "—")
                    .font(.system(size: 11))
                    .monospaced()
                    .foregroundStyle(
                        environment?.databaseName == nil ? Palette.textTertiary : Palette.textPrimary
                    )
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }

    /// The path and the three things you can do with it sit together — a control belongs next to
    /// what it acts on, not in a toolbar three regions away.
    private var worktreeRow: some View {
        field(branch.managed ? "Worktree · managed by TeaBranch" : "Worktree · external") {
            VStack(alignment: .leading, spacing: 7) {
                Text(branch.effectiveWorktreePath ?? "No worktree for this branch")
                    .font(.system(size: 11))
                    .monospaced()
                    .foregroundStyle(hasWorktree ? Palette.textPrimary : Palette.textTertiary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)

                if hasWorktree {
                    HStack(spacing: 6) {
                        PillButton(title: "Terminal", horizontalPadding: 10) {
                            model.openTerminal(for: branch)
                        }
                        PillButton(title: "VS Code", horizontalPadding: 10) {
                            model.openEditor(for: branch)
                        }
                        if branch.status == .running, environment?.port != nil {
                            PillButton(title: "Preview", tone: .dim, horizontalPadding: 10) {
                                model.openPreview(for: branch)
                            }
                        }
                    }
                }
            }
        }
    }

    private func tunnelRow(_ tunnel: NgrokTunnel) -> some View {
        field("Public tunnel") {
            HStack(spacing: 6) {
                Text(tunnel.publicURL)
                    .font(.system(size: 11))
                    .monospaced()
                    .foregroundStyle(Palette.accent)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)

                Text("→ :\(String(tunnel.port))")
                    .font(.system(size: 10))
                    .monospacedDigit()
                    .foregroundStyle(Palette.textSecondary)
            }
        }
    }

    private func field<Content: View>(
        _ label: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 10, weight: .medium))
                .opticalTracking(10)
                .foregroundStyle(Palette.textSecondary)
            content()
        }
    }

    private func inlineError(_ message: String) -> some View {
        Text(message)
            .font(.system(size: 11))
            .foregroundStyle(Palette.statusError)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private var portsView: some View {
        if environment?.port == nil && environment?.backendPort == nil {
            Text("—").foregroundStyle(Palette.textTertiary).font(.system(size: 11))
        } else {
            HStack(spacing: 4) {
                if let backend = environment?.backendPort {
                    portChip("Backend", backend, tinted: false)
                }
                if let socket = environment?.socketPort {
                    portChip("Socket", socket, tinted: false)
                }
                if let frontend = environment?.port {
                    portChip("Frontend", frontend, tinted: true)
                }
            }
        }
    }

    private func portChip(_ label: String, _ port: UInt16, tinted: Bool) -> some View {
        HStack(spacing: 3) {
            Text(label).foregroundStyle(Palette.textSecondary)
            Text(":\(String(port))")
                .monospacedDigit()
                .foregroundStyle(tinted ? Palette.accent : Palette.textPrimary)
        }
        .font(.system(size: 10))
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Palette.fillSubtle, in: Capsule())
        .textSelection(.enabled)
    }

    // MARK: - Environment overrides

    private var envSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(Motion.standard(reduceMotion)) { detail.isExpanded.toggle() }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(detail.isExpanded ? 90 : 0))
                    Text("Environment Overrides")
                        .font(.system(size: 11, weight: .medium))
                    if detail.isDirty {
                        Text("unsaved")
                            .font(.system(size: 9, weight: .medium))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .foregroundStyle(Palette.statusBuilding)
                            .background(Palette.statusBuilding.opacity(0.15), in: Capsule())
                    }
                    Spacer()
                }
                .foregroundStyle(Palette.textSecondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if detail.isExpanded {
                Group {
                    if let draft = detail.draft {
                        envEditor(draft)
                    } else if let error = detail.envError {
                        inlineError(error)
                    } else {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.small)
                            Text("Reading .env.development.local…")
                                .font(.system(size: 11))
                                .foregroundStyle(Palette.textSecondary)
                        }
                    }
                }
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.top, 2)
    }

    private func envEditor(_ draft: WorktreeEnvOverrides) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            envField("PORT", value: draft.port) { detail.update(\.port, to: $0) }
            envField("SOCKET_PORT", value: draft.socketPort) { detail.update(\.socketPort, to: $0) }
            envField("SERVER_PORT", value: draft.serverPort) { detail.update(\.serverPort, to: $0) }
            envField("PUBLIC_ORIGIN", value: draft.publicOrigin) { detail.update(\.publicOrigin, to: $0) }
            envField("STORAGE_PREFIX", value: draft.storagePrefix) { detail.update(\.storagePrefix, to: $0) }

            envField(
                "PRISMA_DATABASE_URL",
                value: draft.prismaDatabaseURL,
                picker: detail.dbInfos.compactMap { info in
                    info.databaseURL.map { ("\(info.branchName) (\(info.databaseName ?? "?"))", $0) }
                }
            ) { detail.update(\.prismaDatabaseURL, to: $0) }

            envField("PUBLIC_DATABASE_PROXY", value: draft.publicDatabaseProxy) {
                detail.update(\.publicDatabaseProxy, to: $0)
            }

            envField(
                "BACKEND_CACHE_REDIS_URI",
                value: draft.backendCacheRedisURI,
                picker: detail.dbInfos.compactMap { info in
                    info.redisURI.map { ("\(info.branchName) (\($0))", $0) }
                }
            ) { detail.update(\.backendCacheRedisURI, to: $0) }

            envField("SANDBOX_TEABLE_ENDPOINT", value: draft.sandboxTeableEndpoint) {
                detail.update(\.sandboxTeableEndpoint, to: $0)
            }

            if let error = detail.envError {
                inlineError(error)
            }

            HStack(spacing: 6) {
                Spacer()
                PillButton(title: "Revert", isDisabled: !detail.isDirty, horizontalPadding: 12) {
                    detail.reset()
                }
                PillButton(
                    title: detail.isSaving ? "Saving…" : "Save",
                    tone: detail.isDirty ? .accent : .plain,
                    isDisabled: !detail.isDirty || detail.isSaving,
                    horizontalPadding: 12
                ) {
                    detail.save()
                }
            }
        }
    }

    private func envField(
        _ label: String,
        value: String?,
        picker options: [(label: String, value: String)] = [],
        onChange: @escaping (String) -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(label)
                    .font(.system(size: 10, weight: .medium))
                    .monospaced()
                    .foregroundStyle(Palette.textSecondary)

                if !options.isEmpty {
                    Menu("Copy from…") {
                        ForEach(options, id: \.value) { option in
                            Button(option.label) { onChange(option.value) }
                        }
                    }
                    .menuStyle(.borderlessButton)
                    .font(.system(size: 10))
                    .foregroundStyle(Palette.accent)
                    .fixedSize()
                }
            }

            TextField("", text: Binding(
                get: { value ?? "" },
                set: { onChange($0) }
            ))
            .textFieldStyle(.plain)
            .font(.system(size: 11))
            .monospaced()
            .padding(.horizontal, 7)
            .padding(.vertical, 5)
            .background(
                Palette.fillSubtle,
                in: RoundedRectangle(cornerRadius: Palette.controlRadius, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: Palette.controlRadius, style: .continuous)
                    .strokeBorder(Palette.border, lineWidth: 1)
            }
            .accessibilityLabel(label)
        }
    }
}
