import SwiftUI

struct SettingsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var selection: String = ""
    @State private var customName: String = ""
    @State private var isCustom = false
    @State private var agentCommand = ""

    private static let customTag = "__custom__"

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Settings").font(.system(size: Typography.title, weight: .bold))
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark").font(.system(size: Typography.body, weight: .medium))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Palette.textSecondary)
                .keyboardShortcut(.cancelAction)
                .accessibilityLabel("Close settings")
            }
            .padding(.bottom, 16)

            Text("Terminal App")
                .font(.system(size: Typography.callout))
                .foregroundStyle(Palette.textSecondary)
                .padding(.bottom, 6)

            Picker("", selection: $selection) {
                ForEach(TerminalService.presets) { preset in
                    Text(preset.label).tag(preset.value ?? "")
                }
                Text("Custom...").tag(Self.customTag)
            }
            .labelsHidden()
            .font(.system(size: Typography.callout))
            .onChange(of: selection) { _, value in
                if value == Self.customTag {
                    isCustom = true
                } else {
                    isCustom = false
                    model.updateTerminalApp(value.isEmpty ? nil : value)
                }
            }

            if isCustom {
                HStack(spacing: 6) {
                    TextField("App name, e.g. WezTerm", text: $customName)
                        .textFieldStyle(.plain)
                        .font(.system(size: Typography.callout))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 6)
                        .background(Palette.fillSubtle, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .strokeBorder(Palette.border, lineWidth: 1)
                        }
                        .onSubmit(saveCustom)

                    PillButton(
                        title: "Save",
                        tone: .accent,
                        isDisabled: customName.trimmingCharacters(in: .whitespaces).isEmpty,
                        horizontalPadding: 12,
                        verticalPadding: 6
                    ) {
                        saveCustom()
                    }
                }
                .padding(.top, 8)
            }

            Text(tabSupportNote)
                .font(.system(size: Typography.caption))
                .foregroundStyle(Palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 10)

            Divider().padding(.vertical, 16)

            agentSection
        }
        .padding(20)
        .frame(width: 420)
        .background(Color(nsColor: .windowBackgroundColor))
        .foregroundStyle(Palette.textPrimary)
        .onAppear(perform: load)
    }

    /// What the Agent button runs.
    ///
    /// Spelled out rather than named: `cc` is a shell alias, and the terminal starts this in a
    /// context where `.zshrc` aliases do not exist. Showing the expanded command is also the only
    /// way the user can tell what the button is about to do on their machine.
    private var agentSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Agent Command")
                .font(.system(size: Typography.callout))
                .foregroundStyle(Palette.textSecondary)

            TextField("claude --dangerously-skip-permissions", text: $agentCommand)
                .textFieldStyle(.plain)
                .font(.system(size: Typography.body))
                .monospaced()
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(Palette.fillSubtle, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .strokeBorder(Palette.border, lineWidth: 1)
                }
                .onSubmit { model.updateAgentCommand(agentCommand) }

            Text(agentNote)
                .font(.system(size: Typography.caption))
                .foregroundStyle(Palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var agentNote: String {
        model.canRunAgent
            ? "Runs in a new tab in the worktree. Your `cc` alias expands to this."
            : "The Agent button is hidden: the selected terminal can't be told to run a command from outside. Otty and iTerm can."
    }

    /// Tell the user what "open in terminal" will actually do for the app they picked.
    private var tabSupportNote: String {
        let value = isCustom ? customName : selection
        let preset = TerminalService.presets.first {
            ($0.value ?? "").caseInsensitiveCompare(value) == .orderedSame
        }

        guard let preset, preset.supportsTabs else {
            return "Opens a new window — this app exposes no way to open a tab from outside."
        }
        switch preset.value {
        case "Otty":
            return "Opens a new tab through Otty's control CLI — no Accessibility permission needed, and it can start the agent for you."
        case "Warp":
            return "Opens a new tab via the warp:// URL scheme."
        case "iTerm":
            return "Opens a new tab via AppleScript."
        case "Ghostty", "Kero":
            return "Opens a new tab by sending ⌘T — needs Accessibility permission for TeaBranch (System Settings → Privacy & Security)."
        default:
            return "Opens a new tab by sending ⌘T — needs Accessibility permission for TeaBranch (System Settings → Privacy & Security)."
        }
    }

    private func load() {
        agentCommand = model.settings.agentCommand
        let stored = model.settings.terminalApp ?? ""
        // Match presets case-insensitively: a hand-edited settings.json may well say "kero".
        let preset = TerminalService.presets.first {
            ($0.value ?? "").caseInsensitiveCompare(stored) == .orderedSame
        }

        if stored.isEmpty || preset != nil {
            selection = preset?.value ?? ""
            isCustom = false
        } else {
            selection = Self.customTag
            customName = stored
            isCustom = true
        }
    }

    private func saveCustom() {
        let name = customName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        model.updateTerminalApp(name)
    }
}
