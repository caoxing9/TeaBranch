import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

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
        .background(Palette.bgPrimary)
        .foregroundStyle(Palette.textPrimary)
        .font(.system(size: 13))
        .tint(Palette.accent)
        .sheet(isPresented: $model.showCreateSheet) {
            CreateWorktreeSheet()
                .environment(model)
        }
        .sheet(isPresented: $model.showSettingsSheet) {
            SettingsSheet()
                .environment(model)
        }
    }

    private var mainShell: some View {
        VStack(spacing: 0) {
            titleBar
            if let errorMessage = model.errorMessage {
                errorBanner(errorMessage)
            }
            BranchListView()
        }
    }

    private var titleBar: some View {
        HStack(spacing: 3) {
            Text("TeaBranch")
                .font(.system(size: 14, weight: .bold))
                .kerning(-0.3)
                .frame(maxWidth: .infinity, alignment: .leading)

            PillButton(title: "New Branch", tone: .accent, horizontalPadding: 10) {
                model.showCreateSheet = true
            }
            PillButton(title: "Open", horizontalPadding: 10) {
                model.chooseProject()
            }

            Rectangle()
                .fill(Palette.borderStrong)
                .frame(width: 1, height: 14)
                .padding(.horizontal, 2)

            PillButton(title: "", systemImage: model.theme.symbolName, horizontalPadding: 6) {
                model.theme = model.theme.next
            }
            .help("Theme: \(model.theme.rawValue)")

            PillButton(title: "", systemImage: "gearshape", horizontalPadding: 6) {
                model.showSettingsSheet = true
            }
            .help("Settings")
        }
        // Leading inset clears the traffic lights, which float over the full-size content view.
        .padding(EdgeInsets(top: 8, leading: 78, bottom: 6, trailing: 10))
        .background(Palette.toolbarBg)
        .bottomDivider()
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text(message)
                .font(.system(size: 11))
                .foregroundStyle(Palette.statusError)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

            Button {
                model.errorMessage = nil
            } label: {
                Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(Palette.statusError)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Palette.statusErrorDim)
        .bottomDivider()
    }
}

struct OnboardingView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 32) {
            VStack(spacing: 8) {
                Text("TeaBranch")
                    .font(.system(size: 40, weight: .heavy))
                    .kerning(-1.5)
                Text("Manage multiple worktrees with isolated environments")
                    .font(.system(size: 13))
                    .foregroundStyle(Palette.textSecondary)
                    .multilineTextAlignment(.center)
            }

            VStack(spacing: 12) {
                Button {
                    model.chooseProject()
                } label: {
                    Text("Select Project Directory")
                        .font(.system(size: 13, weight: .semibold))
                        .padding(.horizontal, 24)
                        .padding(.vertical, 10)
                        .foregroundStyle(Palette.accentOn)
                        .background(Palette.accent, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
                .buttonStyle(.plain)

                Text("Choose a git repository (e.g. teable-ee)")
                    .font(.system(size: 11))
                    .foregroundStyle(Palette.textSecondary)
            }

            if let errorMessage = model.errorMessage {
                Text(errorMessage)
                    .font(.system(size: 12))
                    .foregroundStyle(Palette.statusError)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .frame(maxWidth: 320)
                    .background(Palette.statusErrorDim, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
