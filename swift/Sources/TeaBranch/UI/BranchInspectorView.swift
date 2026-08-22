import AppKit
import SwiftUI

/// The trailing column: everything about a branch that you *consult* rather than *act on*.
///
/// Two tabs, not one long scroll. Reference data and the environment editor were competing for
/// the same column — the editor is a working surface with a dozen text fields, and putting it
/// under five other sections meant scrolling past all of them to reach the thing you opened the
/// panel for. Separating them lets each have the whole height.
///
/// Within a tab there is one row shape and one section shape, deliberately. The first version grew
/// a different layout per section — chips here, a two-line stack there, nine undifferentiated
/// process rows below that — and read as a data dump. Uniform rows make the *values* the thing
/// that varies, which is the only thing that should.
struct BranchInspectorView: View {
    @Environment(AppModel.self) private var model

    var branch: Branch
    @Bindable var detail: BranchDetailModel

    private enum Tab: String, CaseIterable, Identifiable {
        case info, environment

        var id: String { rawValue }
        var label: String {
            switch self {
            case .info: return "Info"
            case .environment: return "Env"
            }
        }
    }

    @AppStorage("teabranch.inspectorTab") private var tab: Tab = .info
    @State private var showProcesses = false
    @State private var envFilter = ""
    @State private var newKey = ""
    @FocusState private var newKeyFocused: Bool

    private var environment: BranchEnvironment? { branch.environment }
    private var hasWorktree: Bool { branch.effectiveWorktreePath != nil }
    private var isNgrokHere: Bool { model.ngrok?.branchName == branch.name }
    private var isRunning: Bool { branch.status.isLive }

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $tab) {
                ForEach(Tab.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, Layout.gutter)
            .padding(.top, 10)
            .padding(.bottom, 8)

            Divider().opacity(0.5)

            switch tab {
            case .info: infoTab
            case .environment: environmentTab
            }
        }
        .onChange(of: tab) { _, new in
            // The editor loads lazily; opening the tab is the request to load it.
            if new == .environment { detail.isExpanded = true }
        }
        .onAppear { if tab == .environment { detail.isExpanded = true } }
    }

    // MARK: - Info

    private var infoTab: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if isNgrokHere, let tunnel = model.ngrok {
                    section("Public tunnel") { tunnelRows(tunnel) }
                }
                if let usage = model.usage(for: branch), !usage.isEmpty {
                    section("Resources") { resourceRows(usage) }
                }
                section("Ports") { portRows }
                section("Worktree") { worktreeRows }
            }
            .padding(.vertical, 4)
        }
        .scrollContentBackground(.hidden)
    }

    /// One heading, one block of rows, one divider. Every section, no exceptions.
    @ViewBuilder
    private func section<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title.uppercased())
                .font(.system(size: Typography.micro, weight: .semibold))
                .opticalTracking(Typography.micro)
                .foregroundStyle(Palette.textTertiary)
            content()
        }
        .padding(.horizontal, Layout.gutter)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)

        Divider().opacity(0.5)
    }

    /// The one row shape: a fixed-width label, then the value.
    private func row<Content: View>(
        _ label: String,
        @ViewBuilder value: () -> Content
    ) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label)
                .font(.system(size: Typography.caption))
                .foregroundStyle(Palette.textSecondary)
                .frame(width: 96, alignment: .leading)
            value()
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func valueText(_ text: String, mono: Bool = false, tinted: Bool = false) -> some View {
        Text(text)
            .font(.system(size: Typography.small, design: mono ? .monospaced : .default))
            .foregroundStyle(tinted ? Palette.accent : Palette.textPrimary)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func resourceRows(_ usage: BranchUsage) -> some View {
        HStack(spacing: 18) {
            metric(String(format: "%.0f%%", usage.cpuPercent), "CPU")
            metric(ProcessStats.formatBytes(usage.residentBytes), "Memory")
            metric(usage.uptime, "Uptime")
        }

        // Collapsed by default. Nine rows of process detail is the raw material behind the three
        // numbers above, not something you need in your eyeline while reading logs.
        DisclosureGroup(isExpanded: $showProcesses) {
            VStack(alignment: .leading, spacing: 3) {
                ForEach(usage.processes) { process in
                    HStack(spacing: 6) {
                        Text(process.group)
                            .font(.system(size: Typography.micro))
                            .foregroundStyle(Palette.textTertiary)
                            .frame(width: 50, alignment: .leading)
                        Text(process.name)
                            .font(.system(size: Typography.caption, design: .monospaced))
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text(String(format: "%.0f%%", process.cpuPercent))
                            .font(.system(size: Typography.caption))
                            .monospacedDigit()
                            .foregroundStyle(Palette.textSecondary)
                            .frame(width: 32, alignment: .trailing)
                        Text(ProcessStats.formatBytes(process.residentBytes))
                            .font(.system(size: Typography.caption))
                            .monospacedDigit()
                            .foregroundStyle(Palette.textSecondary)
                            .frame(width: 56, alignment: .trailing)
                    }
                    .help("pid \(process.pid) · up \(process.uptime)")
                }
            }
            .padding(.top, 5)
        } label: {
            Text("\(usage.processes.count) processes")
                .font(.system(size: Typography.caption))
                .foregroundStyle(Palette.textSecondary)
        }
        .padding(.top, 3)
    }

    private func metric(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(value)
                .font(.system(size: Typography.callout, weight: .medium))
                .monospacedDigit()
            Text(label)
                .font(.system(size: Typography.micro))
                .foregroundStyle(Palette.textTertiary)
        }
    }

    @ViewBuilder
    private var portRows: some View {
        if let backend = environment?.backendPort {
            // Generated env files deliberately give SOCKET_PORT the same value as SERVER_PORT —
            // socket.io rides the backend's HTTP server. Two rows showing one number reads as a bug.
            let socketShares = environment?.socketPort == backend
            row(socketShares ? "Backend + socket" : "Backend") {
                valueText(":\(String(backend))", mono: true)
            }
            if !socketShares, let socket = environment?.socketPort {
                row("Socket") { valueText(":\(String(socket))", mono: true) }
            }
        }
        if let frontend = environment?.port {
            row("Frontend") { valueText(":\(String(frontend))", mono: true, tinted: true) }
        }
        if environment?.port == nil, environment?.backendPort == nil {
            row("Ports") { valueText("Not running") }
        }
        row("Database") { valueText(environment?.databaseName ?? "—", mono: true) }
    }

    @ViewBuilder
    private func tunnelRows(_ tunnel: NgrokTunnel) -> some View {
        row("Public URL") { valueText(tunnel.publicURL, mono: true, tinted: true) }
        row("Forwards to") { valueText(":\(String(tunnel.port))", mono: true) }
        if let error = detail.ngrokError { inlineError(error) }
    }

    @ViewBuilder
    private var worktreeRows: some View {
        if let path = branch.effectiveWorktreePath {
            row(branch.managed ? "Managed" : "External") { valueText(path, mono: true) }
            HStack(spacing: 14) {
                Button { NSWorkspace.shared.selectFile(path, inFileViewerRootedAtPath: "") } label: {
                    Label("Finder", systemImage: "folder").font(.system(size: Typography.caption))
                }
                .buttonStyle(.link)

                // Only offered when the agent has actually written something here — a button that
                // opens an empty directory is worse than no button.
                if AgentScratchService.exists(for: path) {
                    Button { AgentScratchService.reveal(for: path) } label: {
                        Label("Agent Files", systemImage: "sparkles.rectangle.stack")
                            .font(.system(size: Typography.caption))
                    }
                    .buttonStyle(.link)
                    .help("Open what Claude Code generated for this worktree")
                }
            }
            .padding(.leading, 104)
        } else {
            row("Worktree") { valueText("None for this branch") }
        }
    }

    // MARK: - Environment

    private var filteredEntries: [EnvFile.Entry] {
        let needle = envFilter.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return detail.entries }
        return detail.entries.filter {
            $0.key.lowercased().contains(needle) || $0.value.lowercased().contains(needle)
        }
    }

    @ViewBuilder
    private var environmentTab: some View {
        if !hasWorktree {
            emptyState("No worktree", "This branch has no worktree to configure.")
        } else if detail.entries.isEmpty, detail.envError == nil {
            VStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Reading .env.development.local…")
                    .font(.system(size: Typography.caption))
                    .foregroundStyle(Palette.textSecondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(spacing: 0) {
                filterField
                    .padding(.horizontal, Layout.gutter)
                    .padding(.vertical, 8)

                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 9) {
                        ForEach(filteredEntries) { entry in
                            envField(entry)
                        }
                        addKeyField
                    }
                    .padding(.horizontal, Layout.gutter)
                    .padding(.bottom, 12)
                }
                .scrollContentBackground(.hidden)

                envFooter
            }
        }
    }

    private var filterField: some View {
        HStack(spacing: 5) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: Typography.micro))
                .foregroundStyle(Palette.textTertiary)
            TextField("Filter \(detail.entries.count) variables", text: $envFilter)
                .textFieldStyle(.plain)
                .font(.system(size: Typography.caption))
            if !envFilter.isEmpty {
                Button { envFilter = "" } label: {
                    Image(systemName: "xmark.circle.fill").font(.system(size: Typography.micro))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Palette.textTertiary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Palette.fillSubtle, in: Capsule())
    }

    private func envField(_ entry: EnvFile.Entry) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                Text(entry.key)
                    .font(.system(size: Typography.micro, weight: .medium, design: .monospaced))
                    .foregroundStyle(entry.isManaged ? Palette.accent : Palette.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                if entry.isManaged {
                    Image(systemName: "lock.fill")
                        .font(.system(size: Typography.micro - 2))
                        .foregroundStyle(Palette.accent.opacity(0.7))
                        .help("TeaBranch generated this key — it defines this worktree's isolation")
                }

                Spacer(minLength: 0)

                if let options = pickerOptions(for: entry.key), !options.isEmpty {
                    Menu("Copy from…") {
                        ForEach(options, id: \.value) { option in
                            Button(option.label) { detail.update(entry.key, to: option.value) }
                        }
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .font(.system(size: Typography.micro))
                    .foregroundStyle(Palette.accent)
                    .fixedSize()
                }

                // Managed keys have no remove button: deleting PORT or PRISMA_DATABASE_URL breaks
                // the isolation the worktree was created for, and the app would just regenerate it.
                if !entry.isManaged {
                    Button { detail.remove(entry.key) } label: {
                        Image(systemName: "minus.circle").font(.system(size: Typography.micro))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Palette.textTertiary)
                    .help("Remove \(entry.key)")
                }
            }

            TextField("", text: Binding(
                get: { entry.value },
                set: { detail.update(entry.key, to: $0) }
            ))
            .textFieldStyle(.plain)
            .font(.system(size: Typography.caption, design: .monospaced))
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
            .accessibilityLabel(entry.key)
        }
    }

    /// The two keys where copying another worktree's value is the usual reason you opened this.
    private func pickerOptions(for key: String) -> [(label: String, value: String)]? {
        switch key {
        case "PRISMA_DATABASE_URL":
            return detail.dbInfos.compactMap { info in
                info.databaseURL.map { ("\(info.branchName) (\(info.databaseName ?? "?"))", $0) }
            }
        case "BACKEND_CACHE_REDIS_URI":
            return detail.dbInfos.compactMap { info in
                info.redisURI.map { ("\(info.branchName) (\($0))", $0) }
            }
        default:
            return nil
        }
    }

    private var addKeyField: some View {
        HStack(spacing: 6) {
            Image(systemName: "plus")
                .font(.system(size: Typography.micro, weight: .semibold))
                .foregroundStyle(Palette.textTertiary)
            TextField("NEW_VARIABLE", text: $newKey)
                .textFieldStyle(.plain)
                .font(.system(size: Typography.caption, design: .monospaced))
                .focused($newKeyFocused)
                .onSubmit(addKey)
            if !newKey.isEmpty {
                Button("Add", action: addKey)
                    .buttonStyle(.link)
                    .font(.system(size: Typography.caption))
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .overlay {
            RoundedRectangle(cornerRadius: Palette.controlRadius, style: .continuous)
                .strokeBorder(Palette.border, style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
        }
        .padding(.top, 4)
    }

    private func addKey() {
        guard detail.add(key: newKey) else { return }
        newKey = ""
        newKeyFocused = true
    }

    /// Pinned to the bottom, so Save is reachable without scrolling past forty variables.
    private var envFooter: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let error = detail.envError { inlineError(error) }
            if let note = detail.restartNote {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(note)
                        .font(.system(size: Typography.caption))
                        .foregroundStyle(Palette.statusBuilding)
                }
            }

            HStack(spacing: 6) {
                Spacer()
                PillButton(
                    title: "Revert",
                    isDisabled: !detail.isDirty || detail.isSaving,
                    horizontalPadding: 11
                ) {
                    detail.reset()
                }
                PillButton(
                    title: detail.isSaving ? "Saving…" : (isRunning ? "Save & Restart" : "Save"),
                    tone: detail.isDirty ? .accent : .plain,
                    isDisabled: !detail.isDirty || detail.isSaving,
                    horizontalPadding: 11
                ) {
                    // A dev server reads its environment once, at exec. Saving without restarting
                    // leaves the file and the running process disagreeing — which is a bug you
                    // debug for ten minutes before remembering why.
                    detail.save(restartIfRunning: isRunning)
                }
            }
            .help(isRunning
                  ? "Writes the file and restarts this branch so the change takes effect"
                  : "Writes the file")
        }
        .padding(.horizontal, Layout.gutter)
        .padding(.vertical, 9)
        .topDivider()
    }

    // MARK: - Building blocks

    private func emptyState(_ title: String, _ detail: String) -> some View {
        VStack(spacing: 5) {
            Text(title)
                .font(.system(size: Typography.body, weight: .medium))
            Text(detail)
                .font(.system(size: Typography.caption))
                .foregroundStyle(Palette.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(20)
    }

    private func inlineError(_ message: String) -> some View {
        Text(message)
            .font(.system(size: Typography.caption))
            .foregroundStyle(Palette.statusError)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }
}
