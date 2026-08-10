import SwiftUI

struct SettingsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var selection: String = ""
    @State private var customName: String = ""
    @State private var isCustom = false

    private static let customTag = "__custom__"

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Settings").font(.system(size: 14, weight: .bold))
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark").font(.system(size: 11, weight: .medium))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Palette.textSecondary)
                .keyboardShortcut(.cancelAction)
                .accessibilityLabel("Close settings")
            }
            .padding(.bottom, 16)

            Text("Terminal App")
                .font(.system(size: 12))
                .foregroundStyle(Palette.textSecondary)
                .padding(.bottom, 6)

            Picker("", selection: $selection) {
                ForEach(TerminalService.presets) { preset in
                    Text(preset.label).tag(preset.value ?? "")
                }
                Text("Custom...").tag(Self.customTag)
            }
            .labelsHidden()
            .font(.system(size: 12))
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
                        .font(.system(size: 12))
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
                .font(.system(size: 10))
                .foregroundStyle(Palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 10)
        }
        .padding(20)
        .frame(width: 380)
        .background(Color(nsColor: .windowBackgroundColor))
        .foregroundStyle(Palette.textPrimary)
        .onAppear(perform: load)
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
