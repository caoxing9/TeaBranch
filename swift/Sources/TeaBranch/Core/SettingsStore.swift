import Foundation

/// On-disk persistence.
///
/// The paths deliberately match what the Tauri build used
/// (`~/Library/Application Support/com.teabranch.dev/settings.json`), so the native app picks
/// up an existing project path instead of re-running onboarding.
enum SettingsStore {
    private static let bundleIdentifier = "com.teabranch.dev"

    static var configDirectory: URL {
        let base = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent(bundleIdentifier, isDirectory: true)
    }

    private static var settingsURL: URL { configDirectory.appendingPathComponent("settings.json") }
    private static var categoriesURL: URL { configDirectory.appendingPathComponent("categories.json") }

    static func loadSettings() -> AppSettings {
        guard let data = try? Data(contentsOf: settingsURL),
              let settings = try? JSONDecoder().decode(AppSettings.self, from: data)
        else {
            return AppSettings()
        }
        return settings
    }

    static func saveSettings(_ settings: AppSettings) throws {
        try FileManager.default.createDirectory(at: configDirectory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(settings).write(to: settingsURL, options: .atomic)
    }

    /// Branch → swim-lane category. Lived in `localStorage` before; now a sibling JSON file.
    static func loadCategories() -> [String: DevCategory] {
        guard let data = try? Data(contentsOf: categoriesURL),
              let categories = try? JSONDecoder().decode([String: DevCategory].self, from: data)
        else {
            return [:]
        }
        return categories
    }

    static func saveCategories(_ categories: [String: DevCategory]) {
        do {
            try FileManager.default.createDirectory(at: configDirectory, withIntermediateDirectories: true)
            try JSONEncoder().encode(categories).write(to: categoriesURL, options: .atomic)
        } catch {
            Log.warn("failed to persist categories: \(error.localizedDescription)")
        }
    }
}
