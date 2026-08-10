import SwiftUI

struct BranchListView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    @State private var isScrolled = false
    @FocusState private var searchFocused: Bool

    private static let scrollSpace = "branchList"

    var body: some View {
        content
            // The bar floats; content passes underneath it rather than being pushed into a
            // shorter box by an opaque strip.
            .safeAreaInset(edge: .top, spacing: 0) { toolbar }
    }

    // MARK: - Toolbar

    private var toolbar: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text("TeaBranch")
                    .font(.system(size: Typography.headline, weight: .semibold))
                    .opticalTracking(Typography.headline)
                    .fixedSize()
                    .layoutPriority(1)

                searchField

                viewModePicker

                PillButton(
                    title: "",
                    systemImage: "plus",
                    tone: .accent,
                    horizontalPadding: 7,
                    accessibilityLabel: "New branch"
                ) {
                    model.showCreateSheet = true
                }
                .help("New branch (⌘N)")

                overflowMenu
            }
            .padding(.horizontal, Layout.gutter)
            .padding(.vertical, 8)

            // The filter row exists only while a filter does. Nothing is spent showing "All".
            if let filter = model.categoryFilter {
                activeFilterRow(filter)
                    .transition(
                        reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity)
                    )
            }
        }
        .animation(Motion.standard(reduceMotion), value: model.categoryFilter)
        .chromeBackground(reduceTransparency: reduceTransparency)
        // A separator only where content actually slides beneath the bar.
        .scrollEdgeDivider(isVisible: isScrolled)
    }

    private var searchField: some View {
        @Bindable var model = model

        return HStack(spacing: 5) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: Typography.caption, weight: .medium))
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

            if !model.searchText.isEmpty {
                Button {
                    model.searchText = ""
                    searchFocused = true
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: Typography.caption))
                        .foregroundStyle(Palette.textSecondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
                .transition(.opacity)
            }
        }
        .animation(Motion.snappy(reduceMotion), value: model.searchText.isEmpty)
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .frame(minWidth: 70)
        .background(Palette.fillSubtle, in: Capsule())
        .overlay {
            Capsule().strokeBorder(searchFocused ? Palette.accent : Palette.border, lineWidth: 1)
        }
        .animation(Motion.snappy(reduceMotion), value: searchFocused)
    }

    private var viewModePicker: some View {
        @Bindable var model = model

        return Picker("View", selection: $model.viewMode) {
            Image(systemName: "list.bullet").tag(AppModel.ViewMode.list)
                .accessibilityLabel("List")
            Image(systemName: "square.grid.2x2").tag(AppModel.ViewMode.board)
                .accessibilityLabel("Board")
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .controlSize(.small)
        .fixedSize()
        .help("Switch between list and board")
    }

    /// Sorting, filtering and app-level settings live one level deeper — they are set rarely and
    /// were costing two permanent rows of a 420pt-wide window.
    private var overflowMenu: some View {
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

            Picker("Show", selection: $model.categoryFilter) {
                Text("All Branches").tag(DevCategory?.none)
                ForEach(DevCategory.allCases, id: \.self) { category in
                    Text(category.label).tag(DevCategory?.some(category))
                }
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
            Image(systemName: "ellipsis")
                .font(.system(size: Typography.body, weight: .semibold))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        // Never let a filter hide silently: the control that owns it reads as active.
        .foregroundStyle(model.categoryFilter == nil ? Palette.textSecondary : Palette.accent)
        .accessibilityLabel("More options")
        .help("Sort, filter and settings")
    }

    private func activeFilterRow(_ filter: DevCategory) -> some View {
        HStack(spacing: 6) {
            Button {
                model.categoryFilter = nil
            } label: {
                HStack(spacing: 4) {
                    Circle()
                        .fill(Palette.color(for: filter))
                        .frame(width: 6, height: 6)
                    Text(filter.label)
                        .font(.system(size: Typography.caption, weight: .medium))
                    Image(systemName: "xmark")
                        .font(.system(size: Typography.micro, weight: .bold))
                }
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .foregroundStyle(Palette.textPrimary)
                .background(Palette.fillHover, in: Capsule())
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Clear \(filter.label) filter")

            Text("\(model.visibleBranches.count) of \(model.branches.count)")
                .font(.system(size: Typography.caption))
                .monospacedDigit()
                .foregroundStyle(Palette.textSecondary)

            Spacer()
        }
        .padding(.horizontal, Layout.gutter)
        .padding(.bottom, 7)
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if model.branches.isEmpty {
            emptyState(
                title: model.errorMessage == nil ? "No branches yet" : "No repository loaded",
                detail: model.errorMessage == nil
                    ? "Create a worktree to get started."
                    : "Choose a git repository from the ⋯ menu.",
                symbol: "arrow.triangle.branch"
            )
        } else if model.viewMode == .board {
            SwimLaneBoardView()
        } else if model.visibleBranches.isEmpty {
            emptyState(
                title: "No matching branches",
                detail: "Try a different search or clear the filter.",
                symbol: "magnifyingglass"
            )
        } else {
            branchList
        }
    }

    private var branchList: some View {
        ScrollView {
            LazyVStack(spacing: 2) {
                ForEach(model.visibleBranches) { branch in
                    BranchCardView(branch: branch)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .reportsScrollEdge(in: Self.scrollSpace)
        }
        .coordinateSpace(name: Self.scrollSpace)
        .onPreferenceChange(ScrollEdgeKey.self) { offset in
            // A hair of slack so a rubber-banded overscroll doesn't flicker the separator.
            let scrolled = offset > 1
            guard scrolled != isScrolled else { return }
            isScrolled = scrolled
        }
    }

    private func emptyState(title: String, detail: String, symbol: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.system(size: Typography.hero * 0.7, weight: .light))
                .foregroundStyle(Palette.textTertiary)
                .padding(.bottom, 2)
                .accessibilityHidden(true)
            Text(title)
                .font(.system(size: Typography.callout, weight: .medium))
            Text(detail)
                .font(.system(size: Typography.body))
                .foregroundStyle(Palette.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
    }
}
