import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

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
        .frame(minWidth: 360, minHeight: 400)
        // No tint of its own: the window's single `NSVisualEffectView` *is* the background. Painting
        // another translucent layer over it is what makes stacked-glass UI illegible.
        .background {
            if reduceTransparency { Color(nsColor: .windowBackgroundColor) }
        }
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

    /// List and detail are two positions on one rail: the detail arrives from the trailing edge and
    /// leaves the same way, so the path back is the path in.
    private var mainShell: some View {
        ZStack {
            if let branch = model.selectedBranchValue {
                BranchDetailView(branch: branch)
                    .transition(.push(from: .trailing, reduceMotion: reduceMotion))
                    .zIndex(1)
            } else {
                BranchListView()
                    .transition(.push(from: .leading, reduceMotion: reduceMotion))
            }
        }
        .animation(Motion.standard(reduceMotion), value: model.selectedBranch)
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

    /// Errors surface as a dismissible card over the content rather than a bar wedged into the
    /// chrome — a transient problem should not permanently reshape the layout.
    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11))
                .foregroundStyle(Palette.statusError)

            Text(message)
                .font(.system(size: 11))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

            PillButton(
                title: "",
                systemImage: "xmark",
                horizontalPadding: 6,
                accessibilityLabel: "Dismiss error"
            ) {
                model.errorMessage = nil
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background {
            let shape = RoundedRectangle(cornerRadius: Palette.cornerRadius, style: .continuous)
            shape.fill(.regularMaterial)
                .overlay { shape.fill(Palette.statusErrorDim) }
                .overlay { shape.strokeBorder(Palette.statusError.opacity(0.35), lineWidth: 1) }
                .shadow(color: .black.opacity(0.18), radius: 12, y: 4)
        }
    }
}

struct OnboardingView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 28) {
            VStack(spacing: 10) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 34, weight: .regular))
                    .foregroundStyle(Palette.accent)
                    .padding(.bottom, 4)
                    .accessibilityHidden(true)

                Text("TeaBranch")
                    // Large type reads too loose at its default tracking, so it tightens as it grows.
                    .font(.system(size: 34, weight: .bold))
                    .opticalTracking(34)

                Text("Run every branch in parallel — each with its own worktree, ports and database.")
                    .font(.system(size: 12))
                    .foregroundStyle(Palette.textSecondary)
                    .multilineTextAlignment(.center)
                    .lineSpacing(2)
                    .frame(maxWidth: 300)
            }

            VStack(spacing: 10) {
                Button {
                    model.chooseProject()
                } label: {
                    Text("Choose Repository…")
                        .frame(minWidth: 150)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .keyboardShortcut(.defaultAction)

                Text("Pick the git repository you want to manage.")
                    .font(.system(size: 11))
                    .foregroundStyle(Palette.textSecondary)
            }

            if let errorMessage = model.errorMessage {
                Text(errorMessage)
                    .font(.system(size: 11))
                    .foregroundStyle(Palette.statusError)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .frame(maxWidth: 320)
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
