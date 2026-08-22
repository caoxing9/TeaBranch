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

    /// Most-recently-started first. Only an ordering hint for the now-running bar — "the thing you
    /// just launched" should be the thing the bar shows. Branches recovered as orphans at startup
    /// aren't in it and fall back to name order.
    private var startRecency: [String] = []

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
        loadCollapsedLanes()

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
        adoptOttyIfUnset()
        screen = settings.projectPath == nil ? .onboarding : .main
        // The first load has nothing to coalesce with and the window is empty until it lands.
        if screen == .main { refreshNow() }
    }

    /// Default to Otty when it is installed and nothing has been chosen.
    ///
    /// It is the only terminal here that can be driven without Accessibility permission, told to
    /// run a command, and asked what it already has open — so on a machine that has it, every
    /// other choice is strictly worse. An explicit choice is never overridden.
    private func adoptOttyIfUnset() {
        guard settings.terminalApp == nil, OttyService.isInstalled else { return }
        updateTerminalApp("Otty")
    }

    func applyTheme() {
        NSApp.appearance = theme.appearance
    }

    // MARK: - Loading

    /// Pending coalesced refresh, if one is scheduled.
    private var refreshWorkItem: DispatchWorkItem?
    /// When the terminal-presence probe last ran. It spawns a process, so it is throttled
    /// separately from the refresh that asks for it.
    private var lastTerminalProbe = Date.distantPast

    /// Reload the branch list, coalescing bursts.
    ///
    /// A single start posts `environmentsChanged` three or four times in quick succession — once
    /// when the environment is claimed, once when it goes running, once from the watchdog — and
    /// each one used to trigger a full reload: two `git` subprocesses, an `otty-cli` probe, and a
    /// managed-ness check across every worktree. Collapsing a burst into one reload is invisible
    /// to the user and removes most of the work.
    func refresh() {
        refreshWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.performRefresh() }
        }
        refreshWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: item)
    }

    /// Reload immediately, skipping the coalescing window — for the paths where the user is
    /// waiting on the result of their own click.
    func refreshNow() {
        refreshWorkItem?.cancel()
        refreshWorkItem = nil
        performRefresh()
    }

    private func performRefresh() {
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
                    self.refreshTerminalPresence()
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

    /// Branches with a live dev server, most recently started first. Unfiltered on purpose: a
    /// search or lane filter narrows the list, not the fact that something is running.
    var liveBranches: [Branch] {
        branches.filter { $0.status.isLive }.sorted { left, right in
            let leftRank = startRecency.firstIndex(of: left.name) ?? Int.max
            let rightRank = startRecency.firstIndex(of: right.name) ?? Int.max
            if leftRank != rightRank { return leftRank < rightRank }
            return left.name.localizedStandardCompare(right.name) == .orderedAscending
        }
    }

    /// Every lane's branches, in sidebar order, from a single pass.
    ///
    /// The sidebar asks for three lanes, and the per-lane accessor used to re-filter *and re-sort*
    /// the whole list each time — three sorts to render one list.
    var branchesByLane: [DevCategory: [Branch]] {
        var grouped: [DevCategory: [Branch]] = [:]
        for branch in visibleBranches {
            grouped[category(for: branch.name), default: []].append(branch)
        }
        return grouped
    }

    /// Search + sort.
    var visibleBranches: [Branch] {
        var list = branches

        let query = searchText.trimmingCharacters(in: .whitespaces).lowercased()
        if !query.isEmpty {
            list = list.filter { $0.name.lowercased().contains(query) }
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

    /// Lanes the user has folded away, persisted across launches.
    ///
    /// With ten branches parked in "待开发" the lane you are actually working in gets pushed off
    /// screen, so collapsing has to survive a relaunch — otherwise you refold it every morning.
    private(set) var collapsedLanes: Set<DevCategory> = []

    private static let collapsedLanesKey = "teabranch.collapsedLanes"

    private func loadCollapsedLanes() {
        let raw = UserDefaults.standard.stringArray(forKey: Self.collapsedLanesKey) ?? []
        collapsedLanes = Set(raw.compactMap(DevCategory.init(rawValue:)))
    }

    func laneExpansion(_ lane: DevCategory) -> Binding<Bool> {
        Binding(
            get: { !self.collapsedLanes.contains(lane) },
            set: { expanded in
                if expanded {
                    self.collapsedLanes.remove(lane)
                } else {
                    self.collapsedLanes.insert(lane)
                }
                UserDefaults.standard.set(
                    self.collapsedLanes.map(\.rawValue),
                    forKey: Self.collapsedLanesKey
                )
            }
        )
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
            // Only Otty can report which worktrees have tabs open, so switching terminals changes
            // whether that indicator means anything.
            refreshTerminalPresence()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func updateAgentCommand(_ command: String) {
        let trimmed = command.trimmingCharacters(in: .whitespaces)
        do {
            try AppState.shared.updateSettings { $0.agentCommand = trimmed }
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
        if !shouldStop {
            startRecency.removeAll { $0 == name }
            startRecency.insert(name, at: 0)
        }

        // Serial queue: two rapid clicks must not interleave port allocation.
        ProcessManager.queue.async {
            var failure: String?
            do {
                if shouldStop {
                    try ProcessManager.stop(branch: name)
                } else {
                    try ProcessManager.start(branch: name)
                }
            } catch {
                failure = error.localizedDescription
            }
            let message = failure
            onMain {
                self.busyBranches.remove(name)
                if let message { self.errorMessage = message }
                self.refresh()
                // Stop leaves a stale sample behind otherwise: the polling task only re-runs when
                // the set of live branches changes, and it would report the numbers it last saw.
                self.refreshUsage()
            }
        }
    }

    /// Stop and start a branch, keeping it marked busy throughout.
    ///
    /// Used after an environment change. Going through here rather than calling ProcessManager
    /// directly is what disables Start/Stop for the duration — otherwise the header button stays
    /// live and a click races the restart over the same PID table and ports.
    func restart(branch: Branch) {
        let name = branch.name
        guard !busyBranches.contains(name) else { return }
        busyBranches.insert(name)

        ProcessManager.queue.async {
            var failure: String?
            do {
                try ProcessManager.withBranchLock(name) {
                    try ProcessManager.stop(branch: name)
                    try ProcessManager.start(branch: name)
                }
            } catch {
                failure = error.localizedDescription
            }
            let message = failure
            onMain {
                self.busyBranches.remove(name)
                if let message { self.errorMessage = message }
                self.refresh()
                self.refreshUsage()
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
            do {
                // Held across the whole delete: on a concurrent queue this would otherwise run
                // `git worktree remove --force` alongside an in-flight Start still writing into
                // that directory.
                try ProcessManager.withBranchLock(name) {
                    // A worktree whose server won't die can't be removed either — git refuses
                    // while files are open, so surface the stop failure rather than a confusing
                    // git error.
                    try ProcessManager.stop(branch: name)
                    try WorktreeService.remove(branch: name, repo: repo)
                    AppState.shared.removeEnvironment(name)
                    AppState.shared.logs.remove(branch: name)
                }
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
        let name = branch.name
        Background.run {
            do {
                try TerminalService.openTerminal(at: path, using: app, title: name)
            } catch {
                let message = error.localizedDescription
                onMain { self.errorMessage = message }
            }
        }
    }

    /// Whether the configured terminal can start the agent for us.
    var canRunAgent: Bool { TerminalService.canRunCommands(in: settings.terminalApp) }

    /// Open the worktree in a terminal tab with the coding agent already running.
    func openAgent(for branch: Branch) {
        guard let path = branch.effectiveWorktreePath else { return }
        let app = settings.terminalApp
        let name = branch.name
        let command = settings.agentCommand
        Background.run {
            do {
                try TerminalService.openAgent(at: path, using: app, title: name, command: command)
                onMain { self.refreshTerminalPresence(force: true) }
            } catch {
                let message = error.localizedDescription
                onMain { self.errorMessage = message }
            }
        }
    }

    // MARK: - Resource usage

    /// What each running branch is costing, keyed by branch name.
    ///
    /// Sampled on demand rather than continuously: it costs a `ps` invocation, and nobody needs
    /// it while the inspector that shows it is closed.
    private(set) var usageByBranch: [String: BranchUsage] = [:]

    func usage(for branch: Branch) -> BranchUsage? { usageByBranch[branch.name] }

    func refreshUsage() {
        // Ports as well as PIDs: a branch recovered as an orphan after a restart has no PIDs of
        // ours, and its ports are the only thing tying it to a running process.
        let targets = branches.filter { $0.status.isLive }.map { branch in
            ProcessStats.Target(
                branch: branch.name,
                pgids: AppState.shared.pidsByLabel(branch: branch.name),
                ports: [
                    branch.environment?.port,
                    branch.environment?.backendPort,
                    branch.environment?.socketPort,
                ].compactMap { $0 }
            )
        }

        guard !targets.isEmpty else {
            if !usageByBranch.isEmpty { usageByBranch = [:] }
            return
        }

        Background.run {
            let sampled = ProcessStats.sample(targets: targets)
            onMain {
                if self.usageByBranch != sampled { self.usageByBranch = sampled }
            }
        }
    }

    /// Worktrees that currently have a terminal tab open on them. Only Otty can report this.
    private(set) var branchesWithTerminal: Set<String> = []

    func hasTerminal(_ branch: Branch) -> Bool {
        branch.effectiveWorktreePath.map(branchesWithTerminal.contains) ?? false
    }

    /// Ask Otty which worktrees it has tabs open on. Cheap, but it spawns a process, so it runs on
    /// the io queue and only when something actually changed.
    func refreshTerminalPresence(force: Bool = false) {
        guard TerminalService.isOtty(settings.terminalApp) else {
            if !branchesWithTerminal.isEmpty { branchesWithTerminal = [] }
            return
        }
        // Throttled: this spawns `otty-cli`, and tabs do not open and close fast enough to justify
        // probing on every reload.
        if !force, Date().timeIntervalSince(lastTerminalProbe) < 3 { return }
        lastTerminalProbe = Date()

        let paths = branches.compactMap(\.effectiveWorktreePath)
        guard !paths.isEmpty else { return }

        Background.run {
            let open = OttyService.openWorktreePaths(among: paths)
            onMain {
                if self.branchesWithTerminal != open { self.branchesWithTerminal = open }
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
