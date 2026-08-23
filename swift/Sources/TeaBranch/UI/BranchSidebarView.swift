import SwiftUI

/// The sidebar: every branch, all the time.
///
/// This replaces the old list *screen*. The app's whole premise is running several branches at
/// once, and the previous layout pushed the list off-screen the moment you opened one of them —
/// so the answer to "what else is running?" required navigating away from what you were reading.
/// A sidebar answers it continuously, which is also why the now-running bar could be deleted: it
/// existed only to smuggle that information back onto the detail screen.
///
/// Lanes are `Section`s rather than a separate board mode. Grouping is the project-management
/// view; a second full screen that showed the same three buckets was one more place for the same
/// state to disagree with itself.
struct BranchSidebarView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @FocusState private var searchFocused: Bool

    var body: some View {
        @Bindable var model = model

        VStack(spacing: 0) {
            topBar
            branchList
            bottomBar
        }
        .background {
            if reduceTransparency { Color(nsColor: .windowBackgroundColor) }
        }
    }

    // MARK: - Top bar

    private var topBar: some View {
        GlassEffectContainer(spacing: Layout.glassSpacing) {
            HStack(spacing: Layout.glassSpacing) {
                searchField

                PillButton(
                    title: "",
                    systemImage: "plus",
                    tone: .accent,
                    horizontalPadding: 8,
                    accessibilityLabel: "New branch"
                ) {
                    model.showCreateSheet = true
                }
                .help("New branch (⌘N)")
            }
        }
        .padding(.horizontal, 10)
        // The window draws under its titlebar so the sidebar material runs full height, which puts
        // the traffic lights on top of this row. They own the first ~28pt of the leading column.
        .padding(.top, 30)
        .padding(.bottom, 8)
    }

    private var searchField: some View {
        @Bindable var model = model

        return HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: Typography.small, weight: .medium))
                .foregroundStyle(Palette.textSecondary)

            TextField("Search", text: $model.searchText)
                .textFieldStyle(.plain)
                .font(.system(size: Typography.body))
                .focused($searchFocused)
                .onKeyPress(.escape) {
                    model.searchText = ""
                    searchFocused = false
                    return .handled
                }
                // Return opens the top hit, the way Spotlight does — the whole keyboard path from
                // anywhere to a branch is: ⌘F, type a fragment, ⏎.
                .onSubmit {
                    guard !model.searchText.isEmpty,
                          let first = model.visibleBranches.first else { return }
                    model.selectedBranch = first.name
                }

            if !model.searchText.isEmpty {
                Button {
                    model.searchText = ""
                    searchFocused = true
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: Typography.small))
                        .foregroundStyle(Palette.textSecondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
                .transition(.opacity)
            }
        }
        .animation(Motion.snappy(reduceMotion), value: model.searchText.isEmpty)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .frame(minHeight: 24)
        .glassSurface(
            searchFocused ? Surface.tinted(Palette.accent.opacity(0.3)) : Surface.chrome,
            in: Capsule(),
            reduceTransparency: reduceTransparency
        )
        .animation(Motion.snappy(reduceMotion), value: searchFocused)
        // ⌘F means Find everywhere on the platform. A menu item can't reach a SwiftUI FocusState
        // across the AppKit boundary, so an invisible button carries the shortcut instead.
        .background {
            Button("") { searchFocused = true }
                .keyboardShortcut("f", modifiers: .command)
                .buttonStyle(.plain)
                .opacity(0)
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
        }
    }

    // MARK: - List

    @ViewBuilder
    private var branchList: some View {
        @Bindable var model = model

        if model.branches.isEmpty {
            emptyState(
                title: model.errorMessage == nil ? "No branches yet" : "No repository",
                detail: model.errorMessage == nil
                    ? "Create a worktree to get started."
                    : "Choose a repository below.",
                symbol: "arrow.triangle.branch"
            )
        } else if model.visibleBranches.isEmpty {
            emptyState(
                title: "No matches",
                detail: "Try a different search.",
                symbol: "magnifyingglass"
            )
        } else {
            let grouped = model.branchesByLane
            List(selection: $model.selectedBranch) {
                ForEach(DevCategory.allCases, id: \.self) { lane in
                    let branches = grouped[lane] ?? []
                    if !branches.isEmpty {
                        // `isExpanded:` is what gives a sidebar Section the system's own
                        // disclosure triangle and fold animation — rolling our own button here
                        // would look like a control the platform didn't ship.
                        Section(isExpanded: model.laneExpansion(lane)) {
                            ForEach(branches) { branch in
                                BranchRowView(branch: branch)
                                    .tag(branch.name)
                            }
                        } header: {
                            laneHeader(lane, count: branches.count)
                        }
                    }
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .animation(Motion.standard(reduceMotion), value: model.visibleBranches.map(\.id))
        }
    }

    private func laneHeader(_ lane: DevCategory, count: Int) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(Palette.color(for: lane))
                .frame(width: 6, height: 6)
            Text(lane.label)
                .font(.system(size: Typography.caption, weight: .semibold))
            Text("\(count)")
                .font(.system(size: Typography.caption))
                .monospacedDigit()
                .foregroundStyle(Palette.textTertiary)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(lane.label), \(count) branches")
    }

    private func emptyState(title: String, detail: String, symbol: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.system(size: 26, weight: .light))
                .foregroundStyle(Palette.textTertiary)
                .accessibilityHidden(true)
            Text(title)
                .font(.system(size: Typography.body, weight: .medium))
            Text(detail)
                .font(.system(size: Typography.small))
                .foregroundStyle(Palette.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(20)
    }

    // MARK: - Bottom bar

    /// A count and the app-level menu, at the bottom where every macOS sidebar keeps them. These
    /// are set-rarely controls; they were costing a permanent row at the top next to search.
    private var bottomBar: some View {
        HStack(spacing: 8) {
            let live = model.liveBranches.count
            Group {
                if live > 0 {
                    HStack(spacing: 5) {
                        StatusDotView(status: .running)
                        Text("\(live) running")
                            .monospacedDigit()
                    }
                } else {
                    Text("\(model.branches.count) branches")
                        .monospacedDigit()
                }
            }
            .font(.system(size: Typography.caption))
            .foregroundStyle(Palette.textSecondary)

            Spacer(minLength: 0)

            appMenu
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .chromeBackground(reduceTransparency: reduceTransparency)
        .topDivider()
    }

    private var appMenu: some View {
        @Bindable var model = model

        return Menu {
            Picker("Sort By", selection: $model.sortKey) {
                ForEach(AppModel.SortKey.allCases, id: \.self) { key in
                    Text(key.label).tag(key)
                }
            }
            Button(model.sortAscending ? "Reverse Order (Z→A)" : "Reverse Order (A→Z)") {
                model.sortAscending.toggle()
            }

            Divider()

            Picker("Appearance", selection: $model.theme) {
                ForEach(ThemePreference.allCases, id: \.self) { theme in
                    Label(theme.label, systemImage: theme.symbolName).tag(theme)
                }
            }

            Divider()

            Button("Open Repository…") { model.chooseProject() }
            Button("Settings…") { model.showSettingsSheet = true }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.system(size: Typography.body))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .foregroundStyle(Palette.textSecondary)
        .accessibilityLabel("App menu")
        .help("Sort, appearance and settings")
    }
}

// MARK: - Row

/// One branch in the sidebar.
///
/// Two lines: identity, then the facts that change while you work — status, port, and whether a
/// terminal or agent is attached. Actions are on the right-click menu rather than on hover; a
/// sidebar row is a navigation target first, and hover-revealed buttons in a dense list are how
/// you mis-click Delete.
private struct BranchRowView: View {
    @Environment(AppModel.self) private var model

    var branch: Branch

    private var isBusy: Bool { model.isBusy(branch.name) }
    private var isRunning: Bool { branch.status.isLive }
    private var hasWorktree: Bool { branch.effectiveWorktreePath != nil }

    var body: some View {
        HStack(spacing: 8) {
            StatusDotView(status: branch.status)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(branch.name)
                        .font(.system(size: Typography.body, weight: .medium))
                        .lineLimit(1)
                        .truncationMode(.middle)

                    if branch.isCurrent {
                        Text("HEAD")
                            .font(.system(size: Typography.micro, weight: .bold))
                            .opticalTracking(Typography.micro)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Palette.fillSubtle, in: Capsule())
                            .foregroundStyle(Palette.textSecondary)
                    }
                }

                subtitle
            }

            Spacer(minLength: 0)

            if model.hasTerminal(branch) {
                Image(systemName: "terminal.fill")
                    .font(.system(size: Typography.caption))
                    .foregroundStyle(Palette.statusAgent)
                    .help("A terminal is open on this worktree")
                    .accessibilityLabel("Terminal open")
            }
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .contextMenu { menuItems }
    }

    @ViewBuilder
    private var subtitle: some View {
        HStack(spacing: 5) {
            if isBusy {
                Text("Working…")
                    .foregroundStyle(Palette.textSecondary)
            } else {
                Text(branch.status.label)
                    .foregroundStyle(
                        branch.status == .stopped ? Palette.textTertiary : Palette.color(for: branch.status)
                    )
                if let port = branch.environment?.port {
                    Text("·").foregroundStyle(Palette.textTertiary)
                    Text(":\(String(port))")
                        .monospacedDigit()
                        .foregroundStyle(Palette.textSecondary)
                }
            }
        }
        .font(.system(size: Typography.caption))
        .lineLimit(1)
    }

    /// One definition for the right-click menu, so an action is never reachable one way and
    /// missing the other.
    @ViewBuilder
    private var menuItems: some View {
        Button(isRunning ? "Stop" : "Start") { model.toggle(branch: branch) }
            .disabled(isBusy)

        if branch.status == .running, branch.environment?.port != nil {
            Button("Open Preview") { model.openPreview(for: branch) }
        }

        Divider()

        if model.canRunAgent {
            Button("Open Agent") { model.openAgent(for: branch) }
                .disabled(!hasWorktree)
        }
        Button("Open in Terminal") { model.openTerminal(for: branch) }
            .disabled(!hasWorktree)
        Button("Open in VS Code") { model.openEditor(for: branch) }
            .disabled(!hasWorktree)

        Divider()

        Picker("Move to", selection: Binding(
            get: { model.category(for: branch.name) },
            set: { model.setCategory($0, for: branch.name) }
        )) {
            ForEach(DevCategory.allCases, id: \.self) { category in
                Text(category.label).tag(category)
            }
        }

        Divider()

        Button("Delete Worktree…", role: .destructive) { model.confirmDelete(branch: branch) }
            .disabled(!hasWorktree)
    }
}
