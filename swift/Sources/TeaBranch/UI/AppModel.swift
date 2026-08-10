import AppKit
import Observation
import SwiftUI

/// The main-actor view model. Owns the UI's copy of the branch list plus all list/filter state,
/// and funnels every blocking service call onto a background queue.
@MainActor
@Observable
final class AppModel {
    enum Screen {
        case loading, onboarding, main
    }

    enum ViewMode: String, CaseIterable {
        case list, board
    }

    enum SortKey: String, CaseIterable {
        case name, status, category

        var label: String {
            switch self {
            case .name: return "Name"
            case .status: return "Status"
            case .category: return "Category"
            }
        }
    }

    // Screen / data
    private(set) var screen: Screen = .loading
    private(set) var branches: [Branch] = []
    private(set) var settings = AppSettings()
    var errorMessage: String?

    // Per-branch bookkeeping the UI owns
    private(set) var categories: [String: DevCategory] = [:]
    var ngrok: NgrokTunnel?

    // List controls
    var searchText = ""
    var viewMode: ViewMode = .list
    var categoryFilter: DevCategory?
    var sortKey: SortKey = .name
    var sortAscending = true
    var selectedBranch: String?

    // Sheets
    var showCreateSheet = false
    var showSettingsSheet = false
    /// Set while a delete is awaiting confirmation. Removing a worktree is irreversible, which is
    /// the one case that earns a modal — the old hover-revealed inline "Confirm" pill sat one
    /// mis-aimed click away from destroying work.
    var pendingDelete: Branch?

    // Per-branch in-flight flags, so a card can show "..." without blocking the rest
    private(set) var busyBranches: Set<String> = []

    var theme: ThemePreference {
        didSet {
            UserDefaults.standard.set(theme.rawValue, forKey: Self.themeKey)
            applyTheme()
        }
    }

    private static let themeKey = "teabranch.theme"

    init() {
        theme = UserDefaults.standard.string(forKey: Self.themeKey)
            .flatMap(ThemePreference.init(rawValue:)) ?? .dark
        settings = AppState.shared.settings
        categories = SettingsStore.loadCategories()
        ngrok = AppState.shared.ngrokTunnel

        NotificationCenter.default.addObserver(
            forName: .environmentsChanged,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
        NotificationCenter.default.addObserver(
            forName: .ngrokChanged,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.ngrok = AppState.shared.ngrokTunnel }
        }
    }

    func start() {
        applyTheme()
        screen = settings.projectPath == nil ? .onboarding : .main
        if screen == .main { refresh() }
    }

    func applyTheme() {
        NSApp.appearance = theme.appearance
    }

    // MARK: - Loading

    func refresh() {
        guard let repo = AppState.shared.projectURL else {
            branches = []
            return
        }
        let environments = AppState.shared.environmentsByBranch

        Background.run {
            do {
                let branches = try GitService.branches(in: repo, environments: environments)
                onMain {
                    self.branches = branches
                    self.errorMessage = nil
                }
            } catch {
                let message = error.localizedDescription
                onMain {
                    self.branches = []
                    self.errorMessage = message
                }
            }
        }
    }

    var selectedBranchValue: Branch? {
        selectedBranch.flatMap { name in branches.first { $0.name == name } }
    }

    /// Search + category filter + sort, in that order.
    var visibleBranches: [Branch] {
        var list = branches

        let query = searchText.trimmingCharacters(in: .whitespaces).lowercased()
        if !query.isEmpty {
            list = list.filter { $0.name.lowercased().contains(query) }
        }
        if let categoryFilter {
            list = list.filter { category(for: $0.name) == categoryFilter }
        }

        let direction = sortAscending ? 1 : -1
        return list.sorted { left, right in
            let byName = left.name.localizedStandardCompare(right.name) == .orderedAscending
            switch sortKey {
            case .name:
                return direction == 1 ? byName : !byName
            case .status:
                let delta = left.status.sortRank - right.status.sortRank
                if delta != 0 { return direction * delta < 0 }
                return byName
            case .category:
                let delta = category(for: left.name).sortRank - category(for: right.name).sortRank
                if delta != 0 { return direction * delta < 0 }
                return byName
            }
        }
    }

    func toggleSort(_ key: SortKey) {
        if sortKey == key {
            sortAscending.toggle()
        } else {
            sortKey = key
            sortAscending = true
        }
    }

    // MARK: - Categories

    func category(for branch: String) -> DevCategory {
        categories[branch] ?? .todo
    }

    func setCategory(_ category: DevCategory, for branch: String) {
        categories[branch] = category
        SettingsStore.saveCategories(categories)
    }

    // MARK: - Project selection

    func chooseProject() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Select"
        panel.message = "Choose the git repository to manage"

        guard panel.runModal() == .OK, let url = panel.url else { return }
        setProject(path: url.path)
    }

    func setProject(path: String) {
        let gitPath = URL(fileURLWithPath: path).appendingPathComponent(".git")
        guard FileManager.default.fileExists(atPath: gitPath.path) else {
            errorMessage = "Not a git repository"
            return
        }

        do {
            try AppState.shared.updateSettings { $0.projectPath = path }
            AppState.shared.clearEnvironments()
            settings = AppState.shared.settings
            errorMessage = nil
            selectedBranch = nil
            screen = .main
            refresh()
        } catch {
            errorMessage = "Settings saved in memory but failed to persist: \(error.localizedDescription)"
        }
    }

    func updateTerminalApp(_ app: String?) {
        do {
            try AppState.shared.updateSettings { $0.terminalApp = app?.isEmpty == true ? nil : app }
            settings = AppState.shared.settings
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Branch actions

    func isBusy(_ branch: String) -> Bool { busyBranches.contains(branch) }

    func toggle(branch: Branch) {
        let name = branch.name
        let shouldStop = branch.status.isLive
        busyBranches.insert(name)

        // Serial queue: two rapid clicks must not interleave port allocation.
        ProcessManager.queue.async {
            var failure: String?
            if shouldStop {
                ProcessManager.stop(branch: name)
            } else {
                do {
                    try ProcessManager.start(branch: name)
                } catch {
                    failure = error.localizedDescription
                }
            }
            let message = failure
            onMain {
                self.busyBranches.remove(name)
                if let message { self.errorMessage = message }
                self.refresh()
            }
        }
    }

    func confirmDelete(branch: Branch) {
        pendingDelete = branch
    }

    func delete(branch: Branch) {
        guard let repo = AppState.shared.projectURL else { return }
        let name = branch.name
        busyBranches.insert(name)

        ProcessManager.queue.async {
            var failure: String?
            ProcessManager.stop(branch: name)
            do {
                try WorktreeService.remove(branch: name, repo: repo)
                AppState.shared.removeEnvironment(name)
                AppState.shared.logs.remove(branch: name)
            } catch {
                failure = error.localizedDescription
            }
            let message = failure
            onMain {
                self.busyBranches.remove(name)
                if let message {
                    self.errorMessage = message
                } else if self.selectedBranch == name {
                    self.selectedBranch = nil
                }
                self.refresh()
            }
        }
    }

    func openTerminal(for branch: Branch) {
        guard let path = branch.effectiveWorktreePath else { return }
        let app = settings.terminalApp
        Background.run {
            do {
                try TerminalService.openTerminal(at: path, using: app)
            } catch {
                let message = error.localizedDescription
                onMain { self.errorMessage = message }
            }
        }
    }

    func openEditor(for branch: Branch) {
        guard let path = branch.effectiveWorktreePath else { return }
        Background.run {
            do {
                try TerminalService.openInVSCode(path: path)
            } catch {
                let message = error.localizedDescription
                onMain { self.errorMessage = message }
            }
        }
    }

    func openPreview(for branch: Branch) {
        guard let port = branch.environment?.port,
              let url = URL(string: Self.previewURL(branch: branch.name, port: port))
        else { return }
        NSWorkspace.shared.open(url)
    }

    /// `*.localhost` subdomain so each branch gets its own cookie jar.
    static func previewURL(branch: String, port: UInt16) -> String {
        var slug = branch.lowercased().map { character -> Character in
            character.isLetter || character.isNumber || character == "-" ? character : "-"
        }
        // Collapse runs of dashes, then trim them.
        var collapsed: [Character] = []
        for character in slug where !(character == "-" && collapsed.last == "-") {
            collapsed.append(character)
        }
        slug = collapsed
        while slug.first == "-" { slug.removeFirst() }
        while slug.last == "-" { slug.removeLast() }
        return "http://\(String(slug)).localhost:\(port)"
    }
}
