import SwiftUI

/// A branch row. Compact mode is used inside the swim lanes.
struct BranchCardView: View {
    @Environment(AppModel.self) private var model

    var branch: Branch
    var compact: Bool = false

    @State private var isHovering = false
    @State private var confirmingDelete = false

    private var isBusy: Bool { model.isBusy(branch.name) }
    private var isRunning: Bool { branch.status.isLive }
    private var hasWorktree: Bool { branch.effectiveWorktreePath != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                identity
                Spacer(minLength: 4)
                actions
            }

            if !compact {
                CategoryPickerView(value: model.category(for: branch.name)) { category in
                    model.setCategory(category, for: branch.name)
                }
            }
        }
        .padding(.horizontal, compact ? 8 : 12)
        .padding(.vertical, compact ? 6 : 10)
        .background(
            isHovering ? Palette.bgCardHover : Palette.bgCard,
            in: RoundedRectangle(cornerRadius: Palette.cornerRadius, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: Palette.cornerRadius, style: .continuous)
                .strokeBorder(Palette.border, lineWidth: 1)
        }
        .overlay(alignment: .center) {
            if isBusy && !isRunning {
                ProgressView().controlSize(.small)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { model.selectedBranch = branch.name }
        .onHover { hovering in
            isHovering = hovering
            if !hovering { confirmingDelete = false }
        }
        .contextMenu {
            Button("Open in Terminal") { model.openTerminal(for: branch) }
                .disabled(!hasWorktree)
            Button("Open in VS Code") { model.openEditor(for: branch) }
                .disabled(!hasWorktree)
            Divider()
            Button(isRunning ? "Stop" : "Start") { model.toggle(branch: branch) }
            Divider()
            Button("Delete Worktree", role: .destructive) { model.delete(branch: branch) }
                .disabled(!hasWorktree)
        }
    }

    private var identity: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(branch.name)
                    .font(.system(size: compact ? 11 : 13, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)

                if branch.managed {
                    Text("managed")
                        .font(.system(size: 9, weight: .medium))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .foregroundStyle(Palette.accent)
                        .background(Palette.accentDim, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                }
                if branch.isCurrent {
                    Text("current")
                        .font(.system(size: 10))
                        .foregroundStyle(Palette.accent)
                }
            }

            HStack(spacing: 8) {
                StatusBadgeView(status: branch.status)
                if let port = branch.environment?.port {
                    Text(":\(String(port))")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Palette.textSecondary)
                }
            }
        }
    }

    private var actions: some View {
        HStack(spacing: 4) {
            if hasWorktree {
                PillButton(title: "Term", tone: .dim) { model.openTerminal(for: branch) }
                PillButton(title: "Code", tone: .dim) { model.openEditor(for: branch) }
            }
            if branch.status == .running, branch.environment?.port != nil {
                PillButton(title: "Preview", tone: .dim) { model.openPreview(for: branch) }
            }
            PillButton(
                title: isBusy ? "..." : (isRunning ? "Stop" : "Start"),
                tone: isRunning ? .danger : .dim,
                isDisabled: isBusy
            ) {
                model.toggle(branch: branch)
            }
            if hasWorktree, isHovering || confirmingDelete {
                deleteButton
            }
        }
    }

    /// Hover-revealed delete with an inline confirm — the macOS-native stand-in for the web
    /// build's swipe-to-delete gesture.
    @ViewBuilder
    private var deleteButton: some View {
        if confirmingDelete {
            PillButton(title: "Confirm", tone: .danger) {
                confirmingDelete = false
                model.delete(branch: branch)
            }
        } else {
            PillButton(title: "", systemImage: "trash", tone: .danger, horizontalPadding: 6) {
                confirmingDelete = true
            }
            .help("Delete worktree")
        }
    }
}
