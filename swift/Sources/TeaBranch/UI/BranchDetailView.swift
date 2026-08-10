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

    var branch: Branch

    @State private var detail = BranchDetailModel()
    @State private var confirmingDelete = false

    private var environment: BranchEnvironment? { branch.environment }
    private var isRunning: Bool { branch.status.isLive }
    private var hasWorktree: Bool { branch.effectiveWorktreePath != nil }
    private var isNgrokHere: Bool { model.ngrok?.branchName == branch.name }

    var body: some View {
        VStack(spacing: 0) {
            header
            infoRegion
            LogPaneView(branch: branch)
        }
        .onAppear { detail.bind(to: branch.name) }
        .onChange(of: branch.name) { _, name in
            detail.bind(to: name)
            confirmingDelete = false
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 8) {
            PillButton(title: "Back", systemImage: "chevron.left") {
                model.selectedBranch = nil
            }

            HStack(spacing: 6) {
                Text(branch.name)
                    .font(.system(size: 14, weight: .bold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if branch.managed {
                    Text("managed")
                        .font(.system(size: 9, weight: .medium))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .foregroundStyle(Palette.accent)
                        .background(Palette.accentDim, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            PillButton(
                title: model.isBusy(branch.name) ? "..." : (isRunning ? "Stop" : "Start"),
                tone: isRunning ? .danger : .dim,
                isDisabled: model.isBusy(branch.name),
                horizontalPadding: 12
            ) {
                model.toggle(branch: branch)
            }

            if hasWorktree {
                PillButton(title: "Terminal", tone: .dim, horizontalPadding: 10) {
                    model.openTerminal(for: branch)
                }
                PillButton(title: "VS Code", tone: .dim, horizontalPadding: 10) {
                    model.openEditor(for: branch)
                }
            }
            if branch.status == .running, environment?.port != nil {
                PillButton(title: "Preview", tone: .dim, horizontalPadding: 10) {
                    model.openPreview(for: branch)
                }
            }
            if hasWorktree {
                ngrokButton
                deleteControl
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Palette.toolbarBg)
        .bottomDivider()
    }

    private var ngrokButton: some View {
        let otherBranch = model.ngrok.map { !isNgrokHere ? $0.branchName : nil } ?? nil
        let title: String = {
            if detail.ngrokBusy { return "..." }
            if isNgrokHere { return "Stop Ngrok" }
            if let otherBranch { return "Ngrok (on \(otherBranch))" }
            return "Ngrok"
        }()

        return PillButton(
            title: title,
            tone: isNgrokHere ? .danger : .dim,
            isDisabled: detail.ngrokBusy,
            horizontalPadding: 10
        ) {
            detail.toggleNgrok(branch: branch.name, isActiveHere: isNgrokHere)
        }
        .help(isNgrokHere
              ? (model.ngrok?.publicURL ?? "")
              : "Start an ngrok tunnel for SERVER_PORT and write SANDBOX_TEABLE_ENDPOINT")
    }

    @ViewBuilder
    private var deleteControl: some View {
        if confirmingDelete {
            HStack(spacing: 4) {
                Text("Delete?")
                    .font(.system(size: 11))
                    .foregroundStyle(Palette.statusError)
                PillButton(title: "Yes", tone: .danger) {
                    confirmingDelete = false
                    model.delete(branch: branch)
                }
                PillButton(title: "No") { confirmingDelete = false }
            }
        } else {
            PillButton(title: "Delete", tone: .danger) { confirmingDelete = true }
        }
    }

    // MARK: - Info + env

    private var infoRegion: some View {
        ScrollView {
            VStack(spacing: 0) {
                infoGrid
                envSection
            }
        }
        .frame(maxHeight: 320)
        .bottomDivider()
    }

    private var infoGrid: some View {
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
            GridRow {
                infoCell("Status") { StatusBadgeView(status: branch.status) }
                infoCell("Category") {
                    CategoryPickerView(value: model.category(for: branch.name)) { category in
                        model.setCategory(category, for: branch.name)
                    }
                }
            }
            GridRow {
                infoCell("Database") {
                    Text(environment?.databaseName ?? "—")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(environment?.databaseName == nil
                                         ? Palette.textSecondary
                                         : Palette.color(for: model.category(for: branch.name)))
                        .textSelection(.enabled)
                }
                infoCell("Ports") { portsView }
            }
            GridRow {
                infoCell("Source") {
                    Text(branch.managed ? "TeaBranch" : "External")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(branch.managed ? Palette.accent : Palette.textSecondary)
                }
                Color.clear.frame(height: 1)
            }
            GridRow {
                infoCell("Worktree") {
                    Text(branch.effectiveWorktreePath ?? "—")
                        .font(.system(size: 11, design: .monospaced))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .gridCellColumns(2)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.bgCard)
        .bottomDivider()
    }

    private func infoCell<Content: View>(
        _ label: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.system(size: 10))
                .foregroundStyle(Palette.textSecondary)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var portsView: some View {
        if environment?.port == nil && environment?.backendPort == nil {
            Text("—").foregroundStyle(Palette.textSecondary).font(.system(size: 11))
        } else {
            HStack(spacing: 4) {
                if let backend = environment?.backendPort {
                    Text("Backend :\(String(backend))")
                }
                if environment?.backendPort != nil, environment?.socketPort != nil {
                    Text("/").foregroundStyle(Palette.textSecondary)
                }
                if let socket = environment?.socketPort {
                    Text("Socket :\(String(socket))")
                }
                if environment?.socketPort != nil, environment?.port != nil {
                    Text("/").foregroundStyle(Palette.textSecondary)
                }
                if let frontend = environment?.port {
                    Text("Frontend :\(String(frontend))").foregroundStyle(Palette.accent)
                }
            }
            .font(.system(size: 11, design: .monospaced))
        }
    }

    // MARK: - Environment overrides

    private var envSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeOut(duration: 0.15)) { detail.isExpanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9))
                        .rotationEffect(.degrees(detail.isExpanded ? 90 : 0))
                    Text("Environment Overrides")
                        .font(.system(size: 11, weight: .semibold))
                    if detail.isDirty {
                        Text("(unsaved)")
                            .font(.system(size: 9))
                            .foregroundStyle(Palette.statusBuilding)
                    }
                    Spacer()
                }
                .foregroundStyle(Palette.textSecondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if detail.isExpanded {
                if let draft = detail.draft {
                    envEditor(draft)
                } else if let error = detail.envError {
                    Text(error)
                        .font(.system(size: 11))
                        .foregroundStyle(Palette.statusError)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 10)
                } else {
                    Text("Loading...")
                        .font(.system(size: 11))
                        .foregroundStyle(Palette.textSecondary)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 10)
                }
            }
        }
    }

    private func envEditor(_ draft: WorktreeEnvOverrides) -> some View {
        VStack(alignment: .leading, spacing: 6) {
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
                Text(error)
                    .font(.system(size: 10))
                    .foregroundStyle(Palette.statusError)
            }

            HStack(spacing: 6) {
                Spacer()
                PillButton(title: "Reset", isDisabled: !detail.isDirty, horizontalPadding: 10) {
                    detail.reset()
                }
                PillButton(
                    title: detail.isSaving ? "Saving..." : "Save",
                    tone: detail.isDirty ? .accent : .plain,
                    isDisabled: !detail.isDirty || detail.isSaving,
                    horizontalPadding: 10
                ) {
                    detail.save()
                }
            }
            .padding(.top, 2)
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 10)
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
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Palette.textSecondary)

                if !options.isEmpty {
                    Menu("选择已有实例...") {
                        ForEach(options, id: \.value) { option in
                            Button(option.label) { onChange(option.value) }
                        }
                    }
                    .menuStyle(.borderlessButton)
                    .font(.system(size: 9))
                    .foregroundStyle(Palette.accent)
                    .fixedSize()
                }
            }

            TextField("", text: Binding(
                get: { value ?? "" },
                set: { onChange($0) }
            ))
            .textFieldStyle(.plain)
            .font(.system(size: 11, design: .monospaced))
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .background(Palette.bgCard, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(Palette.border, lineWidth: 1)
            }
        }
    }
}
