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

    private var environment: BranchEnvironment? { branch.environment }
    private var isRunning: Bool { branch.status.isLive }
    private var hasWorktree: Bool { branch.effectiveWorktreePath != nil }
    private var isNgrokHere: Bool { model.ngrok?.branchName == branch.name }

    var body: some View {
        VStack(spacing: 0) {
            header
            summaryRegion
            envSection
                .padding(.horizontal, Layout.gutter)
                .padding(.bottom, 12)
                // The editor slides in and out from this region's top edge, so the region has to be
                // its own clip: without one the moving copy paints over the rows above it.
                .clipped()
                .bottomDivider()
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
                    .font(.system(size: Typography.headline, weight: .semibold))
                    .opticalTracking(Typography.headline)
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
        .padding(.horizontal, Layout.gutter)
        .padding(.vertical, 8)
        .chromeBackground(reduceTransparency: reduceTransparency)
        .bottomDivider()
    }

    /// Only what is genuinely rare or destructive lives here. Everything you reach for while working
    /// a branch is on the surface, next to the thing it acts on.
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

    // MARK: - Info

    /// Identity, ports and the worktree actions never scroll. They are what the screen is *for*;
    /// scrolling them away to make room for an env field you are editing trades the reference you
    /// need for the field you are already looking at.
    private var summaryRegion: some View {
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
        }
        .padding(.horizontal, Layout.gutter)
        .padding(.top, 12)
        .padding(.bottom, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
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
                    .font(.system(size: Typography.body))
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

    /// The path and the things you can do with it sit together — a control belongs next to what it
    /// acts on, not in a toolbar three regions away and not behind a menu.
    private var worktreeRow: some View {
        field(branch.managed ? "Worktree · managed by TeaBranch" : "Worktree · external") {
            VStack(alignment: .leading, spacing: 7) {
                Text(branch.effectiveWorktreePath ?? "No worktree for this branch")
                    .font(.system(size: Typography.body))
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
                        ngrokButton
                    }
                }
            }
        }
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
            tone: isNgrokHere ? .active : .plain,
            isDisabled: detail.ngrokBusy,
            horizontalPadding: 10
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

    private func tunnelRow(_ tunnel: NgrokTunnel) -> some View {
        field("Public tunnel") {
            HStack(spacing: 6) {
                Text(tunnel.publicURL)
                    .font(.system(size: Typography.body))
                    .monospaced()
                    .foregroundStyle(Palette.accent)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)

                Text("→ :\(String(tunnel.port))")
                    .font(.system(size: Typography.caption))
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
                .font(.system(size: Typography.caption, weight: .medium))
                .opticalTracking(Typography.caption)
                .foregroundStyle(Palette.textSecondary)
            content()
        }
    }

    private func inlineError(_ message: String) -> some View {
        Text(message)
            .font(.system(size: Typography.body))
            .foregroundStyle(Palette.statusError)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private var portsView: some View {
        if environment?.port == nil && environment?.backendPort == nil {
            Text("—").foregroundStyle(Palette.textTertiary).font(.system(size: Typography.body))
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
        .font(.system(size: Typography.caption))
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
                        .font(.system(size: Typography.micro, weight: .semibold))
                        .rotationEffect(.degrees(detail.isExpanded ? 90 : 0))
                    Text("Environment Overrides")
                        .font(.system(size: Typography.body, weight: .medium))
                    if detail.isDirty {
                        Text("unsaved")
                            .font(.system(size: Typography.micro, weight: .medium))
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
                // Only the editor scrolls. Collapsed there is no ScrollView at all, so nothing is
                // holding space open; expanded it takes at most 260pt and yields the rest — and
                // less than that on a short window, rather than squeezing the log pane out.
                ScrollView {
                    Group {
                        if let draft = detail.draft {
                            envEditor(draft)
                        } else if let error = detail.envError {
                            inlineError(error)
                        } else {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.small)
                                Text("Reading .env.development.local…")
                                    .font(.system(size: Typography.body))
                                    .foregroundStyle(Palette.textSecondary)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.trailing, 2)
                }
                .frame(maxHeight: 260)
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
                    .font(.system(size: Typography.caption, weight: .medium))
                    .monospaced()
                    .foregroundStyle(Palette.textSecondary)

                if !options.isEmpty {
                    Menu("Copy from…") {
                        ForEach(options, id: \.value) { option in
                            Button(option.label) { onChange(option.value) }
                        }
                    }
                    .menuStyle(.borderlessButton)
                    .font(.system(size: Typography.caption))
                    .foregroundStyle(Palette.accent)
                    .fixedSize()
                }
            }

            TextField("", text: Binding(
                get: { value ?? "" },
                set: { onChange($0) }
            ))
            .textFieldStyle(.plain)
            .font(.system(size: Typography.body))
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
