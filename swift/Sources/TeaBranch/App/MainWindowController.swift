import AppKit
import SwiftUI

/// The single app window: frosted, title-bar-less, and hidden (not closed) on ⌘W.
@MainActor
final class MainWindowController: NSObject, NSWindowDelegate {
    private let window: NSWindow
    /// Whether the window has been positioned once this launch. The autosaved frame wins after that.
    private var hasPlacedWindow = false

    init(rootView: some View) {
        // Sized for the split view it now contains. The old 420×600 was a popover that happened to
        // be resizable; two columns and a log console need a window.
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1120, height: 700),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        super.init()

        window.title = "TeaBranch"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.minSize = NSSize(width: 720, height: 460)
        window.isReleasedWhenClosed = false
        window.delegate = self
        // Deliberately a new key. The old one holds a frame sized for the single-column popover
        // this app used to be — restoring it would open the split view at ~420pt of usable width
        // and make the new layout look like a mistake. One reset, then it persists as normal.
        window.setFrameAutosaveName("TeaBranchMainWindow.split")

        // No `NSVisualEffectView` wrapper any more.
        //
        // It existed to give the old hand-rolled palette a material to layer opacity fills onto.
        // `NavigationSplitView` brings its own sidebar material on macOS 26, and the chrome is
        // Liquid Glass, which samples what is *behind* it — so an extra window-wide blur underneath
        // meant every glass surface was sampling another blur rather than the content, which is
        // exactly the stacked-translucency mush the style is supposed to avoid.
        let host = NSHostingView(rootView: rootView)
        host.autoresizingMask = [.width, .height]
        window.contentView = host
        window.center()
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func hide() {
        window.orderOut(nil)
    }

    var isVisible: Bool { window.isVisible }

    /// Toggle the window from the menu bar.
    ///
    /// It only anchors under the status item the *first* time, when there is no remembered frame.
    /// It used to re-anchor on every toggle, which threw away the position on every single show:
    /// you would size and place the window where you wanted it, close it, click the menu bar icon,
    /// and it would teleport back under the icon. A window the user has placed is a window the
    /// user has placed — `setFrameAutosaveName` already remembers where.
    func toggle(under statusItemFrame: NSRect) {
        if window.isVisible {
            hide()
            return
        }
        if !hasPlacedWindow {
            position(under: statusItemFrame)
            hasPlacedWindow = true
        }
        show()
    }

    private func position(under statusItemFrame: NSRect) {
        guard statusItemFrame != .zero else { return }
        let size = window.frame.size
        var x = statusItemFrame.midX - size.width / 2
        let y = statusItemFrame.minY - 6

        // Keep the whole window on the screen that owns the status item.
        let screen = NSScreen.screens.first { $0.frame.intersects(statusItemFrame) } ?? NSScreen.main
        if let visible = screen?.visibleFrame {
            x = min(max(x, visible.minX + 8), visible.maxX - size.width - 8)
        }
        window.setFrameTopLeftPoint(NSPoint(x: x, y: y))
    }

    // Closing hides the window; the app keeps running in the menu bar. Quit via ⌘Q or the
    // status item menu.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        hide()
        return false
    }
}
