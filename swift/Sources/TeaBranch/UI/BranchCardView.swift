import SwiftUI

/// A branch row. Compact mode is used inside the swim lanes.
///
/// One primary action is on the surface; everything else is a level deeper in the row menu and the
/// context menu. Showing Term/Code/Start/Preview/Delete on every row at once gave five equal-weight
/// targets and no hierarchy — and left no room for the branch name it was all about.
struct BranchCardView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var branch: Branch
    var compact: Bool = false

    @State private var isHovering = false

    private var isBusy: Bool { model.isBusy(branch.name) }
    private var isRunning: Bool { branch.status.isLive }
    private var hasWorktree: Bool { branch.effectiveWorktreePath != nil }
    private var category: DevCategory { model.category(for: branch.name) }

    var body: some View {
        HStack(spacing: 8) {
            StatusDotView(status: branch.status)
                .padding(.top, compact ? 0 : 1)

            identity

            Spacer(minLength: 4)

            actions
        }
        .padding(.horizontal, compact ? 8 : 10)
        .padding(.vertical, compact ? 6 : 8)
        .background {
            RoundedRectangle(cornerRadius: Palette.cornerRadius, style: .continuous)
                .fill(isHovering ? Palette.fillHover : .clear)
        }
        .overlay(alignment: .center) {
            if isBusy && !isRunning {
                ProgressView().controlSize(.small)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { model.selectedBranch = branch.name }
        .onHover { isHovering = $0 }
        .animation(Motion.snappy(reduceMotion), value: isHovering)
        .contextMenu { menuItems }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(branch.name), \(branch.status.label)")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { model.selectedBranch = branch.name }
    }

    // MARK: - Identity

    private var identity: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 5) {
                Text(branch.name)
                    .font(.system(size: compact ? 11 : 12, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)

                if branch.isCurrent {
                    chip("current", color: Palette.accent)
                }
                // The default lane carries no information, so it costs no pixels.
                if !compact, category != .todo {
                    chip(category.label, color: Palette.color(for: category))
                }
            }

            HStack(spacing: 5) {
                Text(branch.status.label)
                    .foregroundStyle(
                        branch.status == .stopped ? Palette.textSecondary : Palette.color(for: branch.status)
                    )

                if let port = branch.environment?.port {
                    Text("·").foregroundStyle(Palette.textTertiary)
                    Text(":\(String(port))")
                        .monospacedDigit()
                        .foregroundStyle(Palette.textSecondary)
                }
                if branch.managed {
                    Text("·").foregroundStyle(Palette.textTertiary)
                    Text("managed").foregroundStyle(Palette.textSecondary)
                }
            }
            .font(.system(size: 10))
            .lineLimit(1)
        }
    }

    private func chip(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .medium))
            // Small type needs a touch of positive tracking to stay legible.
            .opticalTracking(9)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .foregroundStyle(color)
            .background(color.opacity(0.15), in: Capsule())
            .fixedSize()
    }

    // MARK: - Actions

    private var actions: some View {
        HStack(spacing: 4) {
            PillButton(
                title: isBusy ? "…" : (isRunning ? "Stop" : "Start"),
                tone: isRunning ? .danger : .dim,
                isDisabled: isBusy,
                horizontalPadding: 10,
                accessibilityLabel: isRunning ? "Stop \(branch.name)" : "Start \(branch.name)"
            ) {
                model.toggle(branch: branch)
            }

            if !compact {
                // The slot is always laid out, so nothing under the cursor moves when it appears.
                Menu {
                    menuItems
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Palette.textSecondary)
                        .frame(width: 18, height: 18)
                        .background(Palette.fillSubtle, in: Circle())
                        .contentShape(Circle())
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .opacity(isHovering ? 1 : 0)
                .accessibilityLabel("Actions for \(branch.name)")
            }
        }
    }

    /// One definition, used by both the row menu and the right-click menu, so an action is never
    /// reachable one way and missing the other.
    @ViewBuilder
    private var menuItems: some View {
        Button(isRunning ? "Stop" : "Start") { model.toggle(branch: branch) }
            .disabled(isBusy)

        if branch.status == .running, branch.environment?.port != nil {
            Button("Open Preview") { model.openPreview(for: branch) }
        }

        Divider()

        Button("Open in Terminal") { model.openTerminal(for: branch) }
            .disabled(!hasWorktree)
        Button("Open in VS Code") { model.openEditor(for: branch) }
            .disabled(!hasWorktree)

        Divider()

        Picker("Move to", selection: categoryBinding) {
            ForEach(DevCategory.allCases, id: \.self) { category in
                Text(category.label).tag(category)
            }
        }

        Divider()

        Button("Delete Worktree…", role: .destructive) { model.confirmDelete(branch: branch) }
            .disabled(!hasWorktree)
    }

    private var categoryBinding: Binding<DevCategory> {
        Binding(
            get: { category },
            set: { model.setCategory($0, for: branch.name) }
        )
    }
}
