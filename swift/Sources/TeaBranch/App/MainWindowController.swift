import AppKit
import SwiftUI

/// The single app window: frosted, title-bar-less, and hidden (not closed) on ⌘W.
@MainActor
final class MainWindowController: NSObject, NSWindowDelegate {
    private let window: NSWindow

    init(rootView: some View) {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 600),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        super.init()

        window.title = "TeaBranch"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.minSize = NSSize(width: 360, height: 400)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.setFrameAutosaveName("TeaBranchMainWindow")

        // The surface the palette's fills layer onto.
        //
        // It used to be `.underWindowBackground` blended *behind* the window, which samples the
        // desktop. The app also forces its own appearance, so whenever the two disagreed — dark app
        // over a light wallpaper, or light app over a dark one — the window resolved to a muddy grey
        // with a mismatched toolbar pasted on it. Appearance you choose, wallpaper you don't; a
        // window's legibility should not depend on the second one. `.withinWindow` keeps the
        // material's depth without letting the desktop decide the value of every surface above it.
        let vibrancy = NSVisualEffectView()
        vibrancy.material = .windowBackground
        vibrancy.blendingMode = .withinWindow
        vibrancy.state = .active
        vibrancy.autoresizingMask = [.width, .height]

        let host = NSHostingView(rootView: rootView)
        host.frame = vibrancy.bounds
        host.autoresizingMask = [.width, .height]
        vibrancy.addSubview(host)

        window.contentView = vibrancy
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

    /// Toggle the window, anchoring it under the status item when showing.
    func toggle(under statusItemFrame: NSRect) {
        if window.isVisible {
            hide()
            return
        }
        position(under: statusItemFrame)
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
