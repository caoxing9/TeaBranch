import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var model = AppModel()
    private var windowController: MainWindowController!
    private var statusItemController: StatusItemController!

    func applicationDidFinishLaunching(_ notification: Notification) {
        Spawn.raiseFileDescriptorLimit()
        // Warm the PATH lookup off the main thread; it shells out to the login shell.
        Task.detached(priority: .utility) { _ = Shell.userPath }

        buildMainMenu()

        windowController = MainWindowController(rootView: RootView().environment(model))
        statusItemController = StatusItemController(
            onToggleWindow: { [weak self] in self?.windowController.toggle(under: $0) },
            onShowWindow: { [weak self] in self?.windowController.show() },
            onQuit: { NSApp.terminate(nil) }
        )

        model.start()
        windowController.show()

        ProcessManager.startReconcileLoop()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        ProcessManager.cleanupAll()
        return .terminateNow
    }

    /// Clicking the dock icon brings the window back after it was hidden.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        windowController.show()
        return true
    }

    /// A minimal main menu. Without an Edit menu the standard ⌘C/⌘V/⌘A key equivalents never
    /// reach text fields.
    private func buildMainMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About TeaBranch", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        // ⌘, is where every Mac app keeps its settings; a sheet reachable only from an overflow
        // menu inside one screen isn't discoverable from the keyboard at all.
        let settingsItem = appMenu.addItem(withTitle: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide TeaBranch", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit TeaBranch", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        // The File menu owns ⌘N, so "new branch" works from the detail screen and the board too —
        // not just while the list toolbar's + button happens to be on screen.
        let fileMenuItem = NSMenuItem()
        let fileMenu = NSMenu(title: "File")
        let newBranchItem = fileMenu.addItem(withTitle: "New Branch…", action: #selector(newBranch), keyEquivalent: "n")
        newBranchItem.target = self
        fileMenuItem.submenu = fileMenu
        mainMenu.addItem(fileMenuItem)

        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        let windowMenuItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)

        NSApp.mainMenu = mainMenu
        NSApp.windowsMenu = windowMenu
    }

    @objc private func newBranch() {
        // No repository yet means nothing to branch from — onboarding is the only screen then.
        guard model.screen == .main else { return }
        windowController.show()
        model.showCreateSheet = true
    }

    @objc private func openSettings() {
        windowController.show()
        model.showSettingsSheet = true
    }
}
