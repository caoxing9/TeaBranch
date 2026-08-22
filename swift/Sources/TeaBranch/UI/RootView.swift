import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    @State private var columnVisibility = NavigationSplitViewVisibility.all

    var body: some View {
        @Bindable var model = model

        Group {
            switch model.screen {
            case .loading:
                Color.clear
            case .onboarding:
                OnboardingView()
            case .main:
                mainShell
            }
        }
        .frame(minWidth: 720, minHeight: 460)
        .foregroundStyle(Palette.textPrimary)
        .tint(Palette.accent)
        .sheet(isPresented: $model.showCreateSheet) {
            CreateWorktreeSheet().environment(model)
        }
        .sheet(isPresented: $model.showSettingsSheet) {
            SettingsSheet().environment(model)
        }
        // Deleting a worktree throws away uncommitted work and a database, and nothing undoes it.
        // That is the bar a confirmation has to clear — everything else here commits on the click.
        .alert(
            "Delete worktree for “\(model.pendingDelete?.name ?? "")”?",
            isPresented: Binding(
                get: { model.pendingDelete != nil },
                set: { if !$0 { model.pendingDelete = nil } }
            ),
            presenting: model.pendingDelete
        ) { branch in
            Button("Delete", role: .destructive) {
                model.pendingDelete = nil
                model.delete(branch: branch)
            }
            Button("Cancel", role: .cancel) { model.pendingDelete = nil }
        } message: { _ in
            Text("The worktree directory and its database are removed. This can't be undone.")
        }
    }

    /// Sidebar and detail, side by side.
    ///
    /// The app used to push between a list screen and a detail screen on one column, which is an
    /// iOS navigation stack wearing a Mac window: opening a branch hid every other branch, on a
    /// window wide enough to show thirty of them. `NavigationSplitView` is the shape this content
    /// always wanted — the list is a persistent index, and selecting is not navigating away.
    private var mainShell: some View {
        @Bindable var model = model

        return NavigationSplitView(columnVisibility: $columnVisibility) {
            BranchSidebarView()
                .navigationSplitViewColumnWidth(
                    min: Layout.sidebarMin,
                    ideal: Layout.sidebarIdeal,
                    max: Layout.sidebarMax
                )
        } detail: {
            Group {
                if let branch = model.selectedBranchValue {
                    BranchDetailView(branch: branch)
                } else {
                    noSelection
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .navigationSplitViewStyle(.balanced)
        // The error banner floats over the detail pane rather than reshaping the layout: a
        // transient problem should not permanently move the content underneath it.
        .overlay(alignment: .bottom) {
            if let errorMessage = model.errorMessage {
                errorBanner(errorMessage)
                    .padding(Layout.gutter)
                    .transition(
                        reduceMotion
                            ? .opacity
                            : .move(edge: .bottom).combined(with: .opacity)
                    )
            }
        }
        .animation(Motion.standard(reduceMotion), value: model.errorMessage)
    }

    private var noSelection: some View {
        VStack(spacing: 8) {
            Image(systemName: "sidebar.left")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(Palette.textTertiary)
                .accessibilityHidden(true)
            Text("Select a branch")
                .font(.system(size: Typography.headline, weight: .medium))
            Text("Pick one from the sidebar, or press ⌘N to create a worktree.")
                .font(.system(size: Typography.body))
                .foregroundStyle(Palette.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Errors surface as a dismissible card over the content rather than a bar wedged into the
    /// chrome — a transient problem should not permanently reshape the layout.
    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: Typography.body))
                .foregroundStyle(Palette.statusError)

            Text(message)
                .font(.system(size: Typography.body))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

            PillButton(
                title: "",
                systemImage: "xmark",
                horizontalPadding: 7,
                accessibilityLabel: "Dismiss error"
            ) {
                model.errorMessage = nil
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: 560)
        .glassSurface(
            Surface.tinted(Palette.statusError.opacity(0.25)),
            in: RoundedRectangle(cornerRadius: Palette.cornerRadius, style: .continuous),
            reduceTransparency: reduceTransparency
        )
        .shadow(color: .black.opacity(0.2), radius: 16, y: 6)
    }
}

struct OnboardingView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 28) {
            VStack(spacing: 10) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: Typography.hero, weight: .regular))
                    .foregroundStyle(Palette.accent)
                    .padding(.bottom, 4)
                    .accessibilityHidden(true)

                Text("TeaBranch")
                    // Large type reads too loose at its default tracking, so it tightens as it grows.
                    .font(.system(size: Typography.hero, weight: .bold))
                    .opticalTracking(Typography.hero)

                Text("Run every branch in parallel — each with its own worktree, ports and database.")
                    .font(.system(size: Typography.callout))
                    .foregroundStyle(Palette.textSecondary)
                    .multilineTextAlignment(.center)
                    .lineSpacing(2)
                    .frame(maxWidth: 340)
            }

            VStack(spacing: 10) {
                Button {
                    model.chooseProject()
                } label: {
                    Text("Choose Repository…")
                        .frame(minWidth: 160)
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
                .keyboardShortcut(.defaultAction)

                Text("Pick the git repository you want to manage.")
                    .font(.system(size: Typography.body))
                    .foregroundStyle(Palette.textSecondary)
            }

            if let errorMessage = model.errorMessage {
                Text(errorMessage)
                    .font(.system(size: Typography.body))
                    .foregroundStyle(Palette.statusError)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .frame(maxWidth: 360)
                    .background(
                        Palette.statusErrorDim,
                        in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                    )
            }
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
