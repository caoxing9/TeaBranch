import SwiftUI

struct BranchListView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let branch = model.selectedBranchValue {
            BranchDetailView(branch: branch)
        } else {
            listShell
        }
    }

    private var listShell: some View {
        VStack(spacing: 0) {
            searchToolbar
            filterToolbar
            content
        }
    }

    // MARK: - Toolbars

    private var searchToolbar: some View {
        @Bindable var model = model

        return HStack(spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 10))
                    .foregroundStyle(Palette.textSecondary)
                TextField("Search branches...", text: $model.searchText)
                    .textFieldStyle(.plain)
                    .font(.system(size: 11))
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(Palette.bgCard, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(Palette.border, lineWidth: 1)
            }

            HStack(spacing: 2) {
                ForEach(AppModel.ViewMode.allCases, id: \.self) { mode in
                    let isSelected = model.viewMode == mode
                    Button {
                        model.viewMode = mode
                    } label: {
                        Text(mode.rawValue.capitalized)
                            .font(.system(size: 11))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 3)
                            .foregroundStyle(isSelected ? Palette.accent : Palette.textSecondary)
                            .background(
                                isSelected ? Palette.accentDim : .clear,
                                in: RoundedRectangle(cornerRadius: 4, style: .continuous)
                            )
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(2)
            .background(Palette.bgCard, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(Palette.border, lineWidth: 1)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Palette.toolbarBg)
        .bottomDivider()
    }

    private var filterToolbar: some View {
        HStack {
            HStack(spacing: 4) {
                filterChip(title: "All", isSelected: model.categoryFilter == nil, color: Palette.accent) {
                    model.categoryFilter = nil
                }
                ForEach(DevCategory.allCases, id: \.self) { category in
                    filterChip(
                        title: category.label,
                        isSelected: model.categoryFilter == category,
                        color: Palette.color(for: category)
                    ) {
                        model.categoryFilter = model.categoryFilter == category ? nil : category
                    }
                }
            }

            Spacer(minLength: 8)

            HStack(spacing: 2) {
                Text("Sort:")
                    .font(.system(size: 10))
                    .foregroundStyle(Palette.textSecondary)
                    .opacity(0.7)
                    .padding(.trailing, 2)

                ForEach(AppModel.SortKey.allCases, id: \.self) { key in
                    let isSelected = model.sortKey == key
                    Button {
                        model.toggleSort(key)
                    } label: {
                        Text(key.label + (isSelected ? (model.sortAscending ? " ↑" : " ↓") : ""))
                            .font(.system(size: 10))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .foregroundStyle(isSelected ? Palette.accent : Palette.textSecondary)
                            .background(
                                isSelected ? Palette.accentDim : .clear,
                                in: RoundedRectangle(cornerRadius: 4, style: .continuous)
                            )
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(Palette.toolbarBg)
        .bottomDivider()
    }

    private func filterChip(
        title: String,
        isSelected: Bool,
        color: Color,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 11))
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .foregroundStyle(isSelected ? color : Palette.textSecondary)
                .background(
                    isSelected ? color.opacity(0.13) : .clear,
                    in: RoundedRectangle(cornerRadius: 5, style: .continuous)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if model.branches.isEmpty {
            emptyState(
                model.errorMessage == nil ? "No branches found" : "No project loaded",
                detail: model.errorMessage == nil ? nil : "Select a git project to get started"
            )
        } else if model.viewMode == .board {
            SwimLaneBoardView()
        } else if model.visibleBranches.isEmpty {
            emptyState("No matching branches", detail: nil)
        } else {
            ScrollView {
                LazyVStack(spacing: 6) {
                    ForEach(model.visibleBranches) { branch in
                        BranchCardView(branch: branch)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
            }
        }
    }

    private func emptyState(_ title: String, detail: String?) -> some View {
        VStack(spacing: 8) {
            Text(title)
                .font(.system(size: 12))
                .foregroundStyle(Palette.textSecondary)
            if let detail {
                Text(detail)
                    .font(.system(size: 11))
                    .foregroundStyle(Palette.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(20)
    }
}
