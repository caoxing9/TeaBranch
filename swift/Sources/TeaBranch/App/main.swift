import AppKit

// Plain AppKit entry point rather than the SwiftUI `App` lifecycle: the app needs precise
// control over its window (position it under the status item, hide instead of close, keep a
// vibrancy layer behind the content), which the SwiftUI scene types don't expose.
//
// Top-level code isn't main-actor isolated, but it does run on the main thread before the run
// loop starts, so the hop below is sound. The delegate is a global because `NSApplication`
// holds it weakly.
let application = NSApplication.shared
let appDelegate = MainActor.assumeIsolated { AppDelegate() }
application.delegate = appDelegate
application.setActivationPolicy(.regular)
application.run()
