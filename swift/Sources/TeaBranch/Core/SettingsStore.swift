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
    private static var teableURL: URL { configDirectory.appendingPathComponent("teable.json") }
    private static var issueRunsURL: URL { configDirectory.appendingPathComponent("issue-runs.json") }
    /// One transcript file per issue, so appending a line rewrites one conversation, not all.
    private static var transcriptsDirectory: URL {
        configDirectory.appendingPathComponent("transcripts", isDirectory: true)
    }

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

    // MARK: - Issues

    static func loadTeableConfig() -> TeableConfig {
        load(TeableConfig.self, from: teableURL) ?? TeableConfig()
    }

    static func saveTeableConfig(_ config: TeableConfig) {
        save(config, to: teableURL)
    }

    static func loadIssueRuns() -> [String: IssueRun] {
        load([String: IssueRun].self, from: issueRunsURL) ?? [:]
    }

    static func saveIssueRuns(_ runs: [String: IssueRun]) {
        save(runs, to: issueRunsURL)
    }

    static func loadTranscript(recordId: String) -> [ConversationEntry] {
        load([ConversationEntry].self, from: transcriptsDirectory.appendingPathComponent("\(recordId).json")) ?? []
    }

    static func saveTranscript(_ entries: [ConversationEntry], recordId: String) {
        save(entries, to: transcriptsDirectory.appendingPathComponent("\(recordId).json"))
    }

    private static func load<T: Decodable>(_ type: T.Type, from url: URL) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        do {
            return try decoder.decode(type, from: data)
        } catch {
            Log.warn("failed to decode \(url.lastPathComponent): \(error.localizedDescription)")
            return nil
        }
    }

    private static func save<T: Encodable>(_ value: T, to url: URL) {
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            encoder.dateEncodingStrategy = .iso8601
            try encoder.encode(value).write(to: url, options: .atomic)
        } catch {
            Log.warn("failed to persist \(url.lastPathComponent): \(error.localizedDescription)")
        }
    }
}
