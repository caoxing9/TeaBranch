import AppKit
import SwiftUI

/// The message box under a conversation, in the shape agent apps have settled on: one rounded
/// field that grows with its text, the send button inside it at the bottom right, quiet details on
/// a line underneath.
///
/// Return sends and Shift-Return breaks the line. The field is an `NSTextView` rather than a
/// SwiftUI `TextField` because of Chinese input: Return is also how an input method commits its
/// candidate, and only the text view can tell (`hasMarkedText`) that a Return belongs to the IME.
/// A SwiftUI key handler sees the same Return either way and would send half-typed pinyin.
struct ComposerView<Footer: View>: View {
    @Binding var text: String
    var placeholder: String
    var isEnabled = true
    /// The agent is working: the send button becomes a stop button.
    var isRunning = false
    var onSend: () -> Void
    var onStop: () -> Void = {}
    @ViewBuilder var footer: () -> Footer

    @State private var height = ComposerTextView.minHeight
    @State private var focused = false

    private var canSend: Bool {
        isEnabled && !isRunning && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(spacing: 4) {
            HStack(alignment: .bottom, spacing: 6) {
                ComposerTextView(
                    text: $text,
                    height: $height,
                    focused: $focused,
                    placeholder: placeholder,
                    isEnabled: isEnabled,
                    onSubmit: { if canSend { onSend() } }
                )
                .frame(height: height)

                actionButton
            }
            .padding(5)
            .background(Palette.fillSubtle, in: RoundedRectangle(cornerRadius: Palette.cornerRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Palette.cornerRadius, style: .continuous)
                    .strokeBorder(focused ? Palette.borderStrong : Palette.border, lineWidth: 1)
            }

            HStack(spacing: 8) {
                footer()
                Spacer(minLength: 0)
                Text(isRunning ? "Agent 运行中" : "⏎ 发送 · ⇧⏎ 换行")
                    .foregroundStyle(Palette.textTertiary)
            }
            .font(.system(size: Typography.caption))
            .padding(.horizontal, 4)
        }
        .frame(maxWidth: 860)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Layout.gutter)
        .padding(.bottom, 10)
        .opacity(isEnabled ? 1 : 0.6)
    }

    @ViewBuilder
    private var actionButton: some View {
        if isRunning {
            Button(action: onStop) {
                Image(systemName: "stop.fill")
                    .font(.system(size: 10, weight: .bold))
                    .frame(width: 26, height: 26)
                    .foregroundStyle(Palette.accentOn)
                    .background(Palette.statusError, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
            .buttonStyle(.plain)
            .help("停止 agent")
            .accessibilityLabel("Stop")
        } else {
            Button {
                if canSend { onSend() }
            } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 12, weight: .bold))
                    .frame(width: 26, height: 26)
                    .foregroundStyle(canSend ? Palette.accentOn : Palette.textTertiary)
                    .background(
                        canSend ? Palette.accent : Palette.fillHover,
                        in: RoundedRectangle(cornerRadius: 6, style: .continuous)
                    )
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .help("发送")
            .accessibilityLabel("Send")
        }
    }
}

extension ComposerView where Footer == EmptyView {
    init(
        text: Binding<String>,
        placeholder: String,
        isEnabled: Bool = true,
        isRunning: Bool = false,
        onSend: @escaping () -> Void,
        onStop: @escaping () -> Void = {}
    ) {
        self.init(
            text: text,
            placeholder: placeholder,
            isEnabled: isEnabled,
            isRunning: isRunning,
            onSend: onSend,
            onStop: onStop,
            footer: { EmptyView() }
        )
    }
}

/// A plain, self-sizing `NSTextView`: grows from one line to `maxHeight`, then scrolls.
struct ComposerTextView: NSViewRepresentable {
    static let minHeight: CGFloat = 26
    static let maxHeight: CGFloat = 160

    @Binding var text: String
    @Binding var height: CGFloat
    @Binding var focused: Bool
    var placeholder: String
    var isEnabled: Bool
    var onSubmit: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder

        let textView = SubmitTextView()
        textView.delegate = context.coordinator
        textView.coordinator = context.coordinator
        textView.isRichText = false
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.font = .systemFont(ofSize: Typography.body)
        textView.textColor = .labelColor
        textView.textContainerInset = NSSize(width: 4, height: 5)
        textView.textContainer?.lineFragmentPadding = 2
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.placeholder = placeholder
        scroll.documentView = textView
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let textView = scroll.documentView as? SubmitTextView else { return }
        // Only push text in when it changed from outside (sent, cleared) — rewriting it while the
        // user types would reset the selection and break an in-progress IME composition.
        if textView.string != text, !textView.hasMarkedText() {
            textView.string = text
            context.coordinator.recalculateHeight(textView)
        }
        textView.isEditable = isEnabled
        textView.isSelectable = true
        if textView.placeholder != placeholder {
            textView.placeholder = placeholder
            textView.needsDisplay = true
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerTextView

        init(_ parent: ComposerTextView) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            parent.text = textView.string
            recalculateHeight(textView)
        }

        func textDidBeginEditing(_ notification: Notification) { parent.focused = true }
        func textDidEndEditing(_ notification: Notification) { parent.focused = false }

        func recalculateHeight(_ textView: NSTextView) {
            guard let container = textView.textContainer, let layout = textView.layoutManager else { return }
            layout.ensureLayout(for: container)
            let content = layout.usedRect(for: container).height + textView.textContainerInset.height * 2
            let clamped = min(max(content, ComposerTextView.minHeight), ComposerTextView.maxHeight)
            if abs(clamped - parent.height) > 0.5 {
                DispatchQueue.main.async { self.parent.height = clamped }
            }
        }

        /// Return sends unless Shift/Option is held or an input method is still composing.
        func handleReturn(in textView: NSTextView) -> Bool {
            if textView.hasMarkedText() { return false }
            let modifiers = NSApp.currentEvent?.modifierFlags ?? []
            if modifiers.contains(.shift) || modifiers.contains(.option) { return false }
            parent.onSubmit()
            return true
        }
    }

    final class SubmitTextView: NSTextView {
        weak var coordinator: Coordinator?
        var placeholder = ""

        override func insertNewline(_ sender: Any?) {
            if coordinator?.handleReturn(in: self) == true { return }
            super.insertNewline(sender)
        }

        override func draw(_ dirtyRect: NSRect) {
            super.draw(dirtyRect)
            guard string.isEmpty, !hasMarkedText(), !placeholder.isEmpty else { return }
            let attributes: [NSAttributedString.Key: Any] = [
                .font: font ?? .systemFont(ofSize: Typography.body),
                .foregroundColor: NSColor.placeholderTextColor,
            ]
            let origin = NSPoint(
                x: textContainerInset.width + (textContainer?.lineFragmentPadding ?? 0),
                y: textContainerInset.height
            )
            (placeholder as NSString).draw(at: origin, withAttributes: attributes)
        }

        override func didChangeText() {
            super.didChangeText()
            needsDisplay = true
        }
    }
}
