import SwiftUI

struct IssueSettingsSheet: View {
    @Environment(IssuesModel.self) private var issues
    @Environment(\.dismiss) private var dismiss

    @State private var tableURL = ""
    @State private var tableURLError: String?
    @State private var magpieKey = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Issue 自动修复").font(.system(size: Typography.title, weight: .bold))
                Spacer()
                Button("完成") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(20)

            Form {
                Section("Teable 表") {
                    TextField("表格链接", text: $tableURL, prompt: Text("粘贴 Teable 视图链接"))
                        .onSubmit(applyTableURL)
                    if let tableURLError {
                        Text(tableURLError).foregroundStyle(Palette.statusError).font(.system(size: Typography.small))
                    }
                    LabeledContent("当前", value: "\(issues.config.baseId) / \(issues.config.tableId) / \(issues.config.viewId ?? "—")")
                        .font(.system(size: Typography.small))
                }

                Section("字段映射") {
                    fieldPicker("标题", current: issues.config.titleField, guess: issues.titleField) { v in issues.updateConfig { $0.titleField = v } }
                    fieldPicker("描述", current: issues.config.bodyField, guess: issues.bodyField) { v in issues.updateConfig { $0.bodyField = v } }
                    fieldPicker("状态", current: issues.config.statusField, guess: issues.statusField) { v in issues.updateConfig { $0.statusField = v } }
                    fieldPicker("Issue ID", current: issues.config.idField, guess: issues.idField) { v in issues.updateConfig { $0.idField = v } }
                    Picker("负责人（只看我的）", selection: Binding(
                        get: { issues.config.assigneeField },
                        set: { v in issues.updateConfig { $0.assigneeField = v } }
                    )) {
                        Text(issues.assigneeField.map { "自动（\($0)）" } ?? "自动").tag(String?.none)
                        ForEach(issues.userFields) { field in
                            Text(field.name).tag(String?.some(field.name))
                        }
                    }
                    Toggle("只加载分配给我的 issue", isOn: binding(\.onlyMine))
                    fieldPicker("回写 PR 链接到", current: issues.config.prField, guess: nil, noneLabel: "不回写") { v in issues.updateConfig { $0.prField = v } }
                    if !issues.statusChoices.isEmpty {
                        Picker("提 PR 后状态改为", selection: binding(\.doneStatus)) {
                            Text("不修改").tag(String?.none)
                            ForEach(issues.statusChoices, id: \.self) { Text($0).tag(String?.some($0)) }
                        }
                    }
                }

                Section {
                    Toggle("自动模式：新 issue 自动修复", isOn: binding(\.autoFix))
                    if !issues.statusChoices.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("自动修复这些状态的 issue").font(.system(size: Typography.small)).foregroundStyle(Palette.textSecondary)
                            ForEach(issues.statusChoices, id: \.self) { choice in
                                Toggle(choice, isOn: Binding(
                                    get: { issues.config.fixStatuses.contains(choice) },
                                    set: { on in
                                        issues.updateConfig { config in
                                            config.fixStatuses.removeAll { $0 == choice }
                                            if on { config.fixStatuses.append(choice) }
                                        }
                                    }
                                ))
                                .toggleStyle(.checkbox)
                            }
                        }
                    } else {
                        Text("映射“状态”字段后可选择自动修复哪些状态").font(.system(size: Typography.small)).foregroundStyle(Palette.textSecondary)
                    }
                    TextField("分支前缀", text: binding(\.branchPrefix))
                } header: {
                    Text("修复")
                } footer: {
                    Text("Agent 用 设置 → Agent 命令 运行（默认 --dangerously-skip-permissions）。Issue 内容来自共享表格，开启自动模式意味着任何能编辑这张表的人都能驱动本机 agent。")
                        .font(.system(size: Typography.caption))
                        .foregroundStyle(Palette.textSecondary)
                }

                Section {
                    Stepper("每批最多 \(issues.config.batchSize) 个", value: binding(\.batchSize), in: 1...10)
                    Toggle("一批全部完成后自动开始下一批", isOn: binding(\.autoNextBatch))
                } header: {
                    Text("限流")
                } footer: {
                    Text("所有待修复的 issue 进同一个队列，每次取一批同时跑。整批都走完（修复 → PR → review → 回改，或失败/停止/agent 等你回复）才切下一批；不开自动的话，会停下来等你审查后点“开始下一批”。")
                        .font(.system(size: Typography.caption))
                        .foregroundStyle(Palette.textSecondary)
                }

                Section("模型") {
                    modelPicker("修复用", selection: binding(\.fixModel))
                    Picker("Review 引擎", selection: binding(\.reviewEngine)) {
                        ForEach(ReviewEngine.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    if issues.config.reviewEngine == .codex {
                        Picker("Codex 模型", selection: binding(\.codexModel)) {
                            Text("默认（~/.codex/config.toml）").tag("")
                            ForEach(issues.magpieModels.filter { $0.hasPrefix("codex/") || $0.contains("gpt") }, id: \.self) { model in
                                Text(model).tag(model)
                            }
                            if !issues.config.codexModel.isEmpty, !issues.magpieModels.contains(issues.config.codexModel) {
                                Text(issues.config.codexModel).tag(issues.config.codexModel)
                            }
                        }
                    } else {
                        modelPicker("Review 用", selection: binding(\.reviewModel))
                    }
                    TextField("Magpie 地址", text: binding(\.magpieURL))
                    HStack {
                        SecureField("Magpie key（可选）", text: $magpieKey)
                            .onSubmit { Keychain.write(magpieKey, for: Keychain.magpieKey); issues.loadMagpieModels() }
                        Button("刷新模型") {
                            if !magpieKey.isEmpty { Keychain.write(magpieKey, for: Keychain.magpieKey) }
                            issues.loadMagpieModels()
                        }
                    }
                    if let error = issues.magpieError {
                        Text(error).font(.system(size: Typography.small)).foregroundStyle(Palette.statusError)
                    } else if !issues.magpieModels.isEmpty {
                        Text("Magpie 提供 \(issues.magpieModels.count) 个模型").font(.system(size: Typography.small)).foregroundStyle(Palette.textSecondary)
                    }
                }

                Section("Review") {
                    Toggle("提 PR 后自动 review", isOn: binding(\.autoReview))
                    Toggle("把 review 结果发给该 issue 的 agent 继续修改", isOn: binding(\.sendReviewToAgent))
                    Stepper("最多 \(issues.config.maxReviewRounds) 轮 review → 修改", value: binding(\.maxReviewRounds), in: 1...5)
                }
            }
            .formStyle(.grouped)
        }
        .frame(width: 560, height: 680)
        .onAppear {
            tableURL = issues.config.recordURL("")?.absoluteString.replacingOccurrences(of: "?recordId=", with: "") ?? ""
            magpieKey = Keychain.read(Keychain.magpieKey) ?? ""
            issues.loadMagpieModels()
        }
    }

    private func applyTableURL() {
        var config = issues.config
        if config.apply(tableURL: tableURL) {
            tableURLError = nil
            issues.updateConfig { $0 = config }
        } else {
            tableURLError = "需要形如 …/base/bse…/table/tbl…/viw… 的链接"
        }
    }

    private func binding<T>(_ keyPath: WritableKeyPath<TeableConfig, T>) -> Binding<T> {
        Binding(
            get: { issues.config[keyPath: keyPath] },
            set: { value in issues.updateConfig { $0[keyPath: keyPath] = value } }
        )
    }

    private func fieldPicker(
        _ label: String,
        current: String?,
        guess: String?,
        noneLabel: String = "自动",
        set: @escaping (String?) -> Void
    ) -> some View {
        Picker(label, selection: Binding(get: { current }, set: set)) {
            Text(guess.map { "\(noneLabel)（\($0)）" } ?? noneLabel).tag(String?.none)
            ForEach(issues.fields) { field in
                Text(field.name).tag(String?.some(field.name))
            }
        }
    }

    private func modelPicker(_ label: String, selection: Binding<AgentModel>) -> some View {
        Picker(label, selection: selection) {
            Text("Claude（默认）").tag(AgentModel())
            ForEach(["opus", "sonnet", "haiku"], id: \.self) { alias in
                Text("Claude · \(alias)").tag(AgentModel(provider: .claude, model: alias))
            }
            if !issues.magpieModels.isEmpty {
                Divider()
                ForEach(issues.magpieModels, id: \.self) { model in
                    Text("Magpie · \(model)").tag(AgentModel(provider: .magpie, model: model))
                }
            }
            let current = selection.wrappedValue
            if current.provider == .magpie, let model = current.model, !issues.magpieModels.contains(model) {
                Text(current.label).tag(current)
            }
        }
    }
}
