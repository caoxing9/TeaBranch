import AppKit

/// The menu bar item: left click toggles the window under the icon, right click opens a menu.
@MainActor
final class StatusItemController: NSObject {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let onToggleWindow: (NSRect) -> Void
    private let onShowWindow: () -> Void
    private let onQuit: () -> Void
    private let menu = NSMenu()

    init(
        onToggleWindow: @escaping (NSRect) -> Void,
        onShowWindow: @escaping () -> Void,
        onQuit: @escaping () -> Void
    ) {
        self.onToggleWindow = onToggleWindow
        self.onShowWindow = onShowWindow
        self.onQuit = onQuit
        super.init()

        if let button = statusItem.button {
            button.image = Self.trayImage()
            button.toolTip = "TeaBranch"
            button.target = self
            button.action = #selector(handleClick)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        menu.addItem(withTitle: "Show", action: #selector(handleShow), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit", action: #selector(handleQuit), keyEquivalent: "q")
        menu.items.forEach { $0.target = self }
    }

    @objc private func handleClick() {
        if NSApp.currentEvent?.type == .rightMouseUp {
            statusItem.menu = menu
            statusItem.button?.performClick(nil)
            // Detach again so the next left click reaches our action instead of the menu.
            statusItem.menu = nil
            return
        }
        onToggleWindow(statusItemFrame)
    }

    @objc private func handleShow() {
        onShowWindow()
    }

    @objc private func handleQuit() {
        onQuit()
    }

    /// Screen-space frame of the status item's button.
    private var statusItemFrame: NSRect {
        guard let button = statusItem.button, let window = button.window else { return .zero }
        return window.convertToScreen(button.convert(button.bounds, to: nil))
    }

    private static func trayImage() -> NSImage {
        let image: NSImage
        if let url = Bundle.main.url(forResource: "TrayIcon", withExtension: "png"),
           let bundled = NSImage(contentsOf: url) {
            image = bundled
        } else {
            image = NSImage(
                systemSymbolName: "arrow.triangle.branch",
                accessibilityDescription: "TeaBranch"
            ) ?? NSImage()
        }
        image.size = NSSize(width: 18, height: 18)
        image.isTemplate = true
        return image
    }
}
