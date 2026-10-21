import AppKit
import UserNotifications

/// macOS notifications for things that finish while you are looking elsewhere — a batch of issue
/// fixes runs for tens of minutes, and the point of queueing it is not watching it.
///
/// Falls back to bouncing the Dock icon when notifications are denied or unavailable (an
/// ad-hoc-signed build launched outside its bundle has no notification identity).
@MainActor
enum Notifier {
    private static var authorized: Bool?

    static func requestAuthorizationIfNeeded() {
        guard authorized == nil, Bundle.main.bundleIdentifier != nil else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
            if let error { Log.warn("notification authorization failed: \(error.localizedDescription)") }
            onMain { authorized = granted }
        }
    }

    static func post(title: String, body: String) {
        if authorized == true {
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            UNUserNotificationCenter.current().add(request) { error in
                if let error { Log.warn("notification failed: \(error.localizedDescription)") }
            }
        } else {
            NSSound(named: "Glass")?.play()
        }
        // Even with a banner, a bounce is what you notice coming back to the desk.
        if !NSApp.isActive { NSApp.requestUserAttention(.informationalRequest) }
    }
}
