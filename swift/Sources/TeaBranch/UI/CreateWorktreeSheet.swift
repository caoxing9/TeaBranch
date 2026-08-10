import Observation
import SwiftUI

@MainActor
@Observable
final class CreateWorktreeModel {
    enum Mode: String, CaseIterable, Identifiable {
        case new, clone, reuse

        var id: String { rawValue }

        var label: String {
            switch self {
            case .new: return "新建数据库"
            case .clone: return "克隆已有数据库"
            case .reuse: return "复用已有数据库"
            }
        }

        var detail: String {
            switch self {
            case .new: return "基于基础模板创建，命名与 worktree 一致"
            case .clone: return "基于已有 worktree 的数据库克隆，命名与新 worktree 一致"
            case .reuse: return "直接使用已有 worktree 的数据库和 Redis"
            }
        }
    }

    static let steps: [(key: String, label: String)] = [
        ("fetch", "Fetch origin/develop"),
        ("branch", "Create branch & worktree"),
        ("env", "Setup environment"),
        ("install", "Install dependencies"),
        ("database", "Setup database"),
        ("migrate", "Run migration"),
        ("done", "Done"),
    ]

    var branchName = ""
    var mode: Mode = .new
    var sourceBranch = ""
    var dbInfos: [WorktreeDbInfo] = []

    var isCreating = false
    var isDone = false
    var currentStep: String?
    var error: String?

    var availableSources: [WorktreeDbInfo] {
        dbInfos.filter { $0.databaseName != nil }
    }

    var canCreate: Bool {
        !branchName.trimmingCharacters(in: .whitespaces).isEmpty
            && (mode == .new || !sourceBranch.isEmpty)
    }

    /// What the database will end up being called, mirroring the backend's naming.
    var previewDatabaseName: String? {
        let name = branchName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return nil }
        if mode == .reuse, !sourceBranch.isEmpty {
            return dbInfos.first { $0.branchName == sourceBranch }?.databaseName
        }
        return DatabaseURL.name(forBranch: name)
    }

    func loadSources() {
        guard let repo = AppState.shared.projectURL else { return }
        Background.run {
            let infos = GitService.worktreeDbInfo(in: repo)
            onMain { self.dbInfos = infos }
        }
    }

    func create(onFinished: @escaping () -> Void) {
        guard let repo = AppState.shared.projectURL, canCreate else { return }
        let name = branchName.trimmingCharacters(in: .whitespaces)
        let dbMode: DbMode = switch mode {
        case .new: .new
        case .clone: .clone(sourceBranch: sourceBranch)
        case .reuse: .reuse(sourceBranch: sourceBranch)
        }

        isCreating = true
        isDone = false
        currentStep = nil
        error = nil

        Background.run {
            do {
                try WorktreeService.create(branch: name, repo: repo, dbMode: dbMode) { progress in
                    onMain {
                        self.currentStep = progress.step
                        if progress.done {
                            self.isDone = true
                            self.isCreating = false
                        }
                    }
                }
                onMain {
                    self.isDone = true
                    self.isCreating = false
                    onFinished()
                }
            } catch {
                let message = error.localizedDescription
                onMain {
                    self.error = message
                    self.isCreating = false
                }
            }
        }
    }
}

struct CreateWorktreeSheet: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss

    @State private var model = CreateWorktreeModel()
    @FocusState private var nameFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("New Worktree")
                .font(.system(size: 15, weight: .bold))
                .padding(.bottom, 16)

            if model.isCreating || model.isDone {
                progressList
            } else {
                form
            }

            if let error = model.error {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(Palette.statusError)
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Palette.statusErrorDim, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .padding(.top, 12)
            }
        }
        .padding(24)
        .frame(width: 440)
        .background(Palette.bgPrimary)
        .foregroundStyle(Palette.textPrimary)
        .onAppear {
            model.loadSources()
            nameFocused = true
        }
        .onChange(of: model.isDone) { _, done in
            guard done else { return }
            Task {
                try? await Task.sleep(for: .milliseconds(800))
                appModel.refresh()
                dismiss()
            }
        }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Branch name (from origin/develop):")
                .font(.system(size: 12))
                .foregroundStyle(Palette.textSecondary)
                .padding(.bottom, 8)

            TextField("feat/my-feature", text: $model.branchName)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .focused($nameFocused)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(Palette.bgCard, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(Palette.border, lineWidth: 1)
                }
                .onSubmit { if model.canCreate { create() } }

            Text("数据库模式:")
                .font(.system(size: 12))
                .foregroundStyle(Palette.textSecondary)
                .padding(.top, 16)
                .padding(.bottom, 8)

            VStack(spacing: 6) {
                ForEach(CreateWorktreeModel.Mode.allCases) { mode in
                    modeOption(mode)
                }
            }

            if model.mode != .new {
                Text(model.mode == .clone ? "克隆来源:" : "复用来源:")
                    .font(.system(size: 12))
                    .foregroundStyle(Palette.textSecondary)
                    .padding(.top, 12)
                    .padding(.bottom, 6)

                if model.availableSources.isEmpty {
                    Text("没有找到已配置数据库的 worktree")
                        .font(.system(size: 11))
                        .foregroundStyle(Palette.statusError)
                } else {
                    Picker("", selection: $model.sourceBranch) {
                        Text("-- 选择 worktree --").tag("")
                        ForEach(model.availableSources) { info in
                            Text("\(info.branchName) (\(info.databaseName ?? "?"))").tag(info.branchName)
                        }
                    }
                    .labelsHidden()
                    .font(.system(size: 12))
                }
            }

            if let dbName = model.previewDatabaseName {
                HStack(spacing: 6) {
                    Text("DB:").font(.system(size: 11)).opacity(0.6)
                    Text(dbName)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Palette.accent)
                    if model.mode == .reuse {
                        Spacer()
                        Text("shared")
                            .font(.system(size: 10))
                            .foregroundStyle(Palette.statusBuilding)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Palette.bgCard, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(Palette.border, lineWidth: 1)
                }
                .padding(.top, 12)
            }

            HStack(spacing: 8) {
                Spacer()
                PillButton(title: "Cancel", horizontalPadding: 14, verticalPadding: 6) { dismiss() }
                PillButton(
                    title: "Create",
                    tone: .accent,
                    isDisabled: !model.canCreate,
                    horizontalPadding: 14,
                    verticalPadding: 6
                ) {
                    create()
                }
            }
            .padding(.top, 16)
        }
    }

    private func modeOption(_ mode: CreateWorktreeModel.Mode) -> some View {
        let isSelected = model.mode == mode
        return Button {
            model.mode = mode
            if mode == .new { model.sourceBranch = "" }
        } label: {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 12))
                    .foregroundStyle(isSelected ? Palette.accent : Palette.textSecondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(mode.label).font(.system(size: 12, weight: .semibold))
                    Text(mode.detail)
                        .font(.system(size: 11))
                        .foregroundStyle(Palette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(
                isSelected ? Palette.accentDim : .clear,
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(isSelected ? Palette.accent : .clear, lineWidth: 1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var progressList: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(CreateWorktreeModel.steps, id: \.key) { step in
                let currentIndex = CreateWorktreeModel.steps.firstIndex { $0.key == model.currentStep }
                let stepIndex = CreateWorktreeModel.steps.firstIndex { $0.key == step.key } ?? 0
                let isActive = model.currentStep == step.key
                let isPast = (currentIndex ?? -1) > stepIndex
                let isDone = step.key == "done" && model.isDone

                HStack(spacing: 8) {
                    Group {
                        if isActive {
                            ProgressView().controlSize(.small).scaleEffect(0.6)
                        } else if isPast || isDone {
                            Image(systemName: "checkmark").font(.system(size: 10, weight: .bold))
                        } else {
                            Text("·")
                        }
                    }
                    .frame(width: 14, height: 14)

                    Text(step.label).font(.system(size: 12))
                }
                .foregroundStyle(
                    isPast || isDone ? Palette.accent : (isActive ? Palette.statusBuilding : Palette.textSecondary)
                )
                .opacity(!isPast && !isActive && !isDone ? 0.5 : 1)
            }

            if model.isDone {
                Text("Closing...")
                    .font(.system(size: 11))
                    .foregroundStyle(Palette.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.top, 8)
            }
        }
    }

    private func create() {
        model.create { appModel.refresh() }
    }
}
