import Darwin
import Foundation

/// Notifications the services raise and the UI listens to. Replaces Tauri's `app.emit`.
extension Notification.Name {
    static let environmentsChanged = Notification.Name("teabranch.environmentsChanged")
    static let ngrokChanged = Notification.Name("teabranch.ngrokChanged")
}

enum AppEvents {
    static func post(_ name: Notification.Name) {
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: name, object: nil)
        }
    }
}

/// The process-wide mutable state shared between the UI and the background service threads.
///
/// Every accessor takes a lock; nothing here is `@MainActor` because the log readers, the
/// health watchdog and the reconcile loop all live on their own threads.
final class AppState: @unchecked Sendable {
    static let shared = AppState()

    let logs = LogStore()
    /// Single-key store for the ngrok agent's output.
    let ngrokLogs = LogStore()
    static let ngrokLogKey = "ngrok"

    private let lock = NSRecursiveLock()
    private var storedSettings: AppSettings
    private var storedEnvironments: [String: BranchEnvironment] = [:]
    /// "branch:label" → pid of the process group leader.
    private var storedPIDs: [String: pid_t] = [:]
    /// Monotonic per branch. Bumped on every start/stop; a watchdog exits as soon as the
    /// stored generation no longer matches the one it was started with.
    private var storedWatchdogGenerations: [String: UInt64] = [:]
    /// Branches whose stop is still in flight. The reconcile loop reads ground truth from each
    /// worktree's env file, so between "user clicked Stop" and "the port is actually free" it
    /// would see the dying server still listening and mark the branch Running again — which is
    /// what made Stop look like it did nothing. Membership here means "we are deliberately
    /// tearing this down; do not resurrect it".
    private var storedStopping: Set<String> = []
    private var storedNgrokPID: pid_t?
    private var storedNgrokTunnel: NgrokTunnel?

    private init() {
        storedSettings = SettingsStore.loadSettings()
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    // MARK: - Settings

    var settings: AppSettings {
        withLock { storedSettings }
    }

    var projectURL: URL? {
        withLock { storedSettings.projectURL }
    }

    /// Mutate settings and persist them in one step.
    func updateSettings(_ mutate: (inout AppSettings) -> Void) throws {
        let updated: AppSettings = withLock {
            mutate(&storedSettings)
            return storedSettings
        }
        try SettingsStore.saveSettings(updated)
    }

    // MARK: - Environments

    var environments: [BranchEnvironment] {
        withLock { Array(storedEnvironments.values) }
    }

    var environmentsByBranch: [String: BranchEnvironment] {
        withLock { storedEnvironments }
    }

    func environment(_ branch: String) -> BranchEnvironment? {
        withLock { storedEnvironments[branch] }
    }

    func setEnvironment(_ environment: BranchEnvironment) {
        withLock { storedEnvironments[environment.branchName] = environment }
    }

    @discardableResult
    func mutateEnvironment(_ branch: String, _ body: (inout BranchEnvironment) -> Void) -> Bool {
        withLock {
            guard var environment = storedEnvironments[branch] else { return false }
            body(&environment)
            storedEnvironments[branch] = environment
            return true
        }
    }

    func removeEnvironment(_ branch: String) {
        _ = withLock { storedEnvironments.removeValue(forKey: branch) }
    }

    func clearEnvironments() {
        withLock { storedEnvironments.removeAll() }
    }

    /// Ports currently claimed by live environments — used to avoid double-allocating.
    func portsInUse() -> Set<UInt16> {
        withLock {
            var ports = Set<UInt16>()
            for environment in storedEnvironments.values where environment.status.isLive {
                [environment.port, environment.backendPort, environment.socketPort]
                    .compactMap { $0 }
                    .forEach { ports.insert($0) }
            }
            return ports
        }
    }

    // MARK: - Child processes

    private func key(_ branch: String, _ label: String) -> String { "\(branch):\(label)" }

    func setPID(_ pid: pid_t, branch: String, label: String) {
        withLock { storedPIDs[key(branch, label)] = pid }
    }

    @discardableResult
    func removePID(branch: String, label: String) -> pid_t? {
        withLock { storedPIDs.removeValue(forKey: key(branch, label)) }
    }

    func hasPID(branch: String, label: String) -> Bool {
        withLock { storedPIDs[key(branch, label)] != nil }
    }

    func isManagingProcesses(branch: String) -> Bool {
        withLock { storedPIDs.keys.contains { $0.hasPrefix("\(branch):") } }
    }

    /// Every PID belonging to a branch, left in place.
    ///
    /// These are process-group leaders (we spawn with `POSIX_SPAWN_SETPGROUP`), so each one is
    /// also the pgid of that command's whole tree — which is what makes per-branch resource
    /// accounting a grouping key rather than a tree walk.
    func pids(branch: String) -> [pid_t] {
        withLock {
            let prefix = "\(branch):"
            return storedPIDs.filter { $0.key.hasPrefix(prefix) }.map(\.value)
        }
    }

    /// Every PID belonging to a branch, keyed by the command label it was started for.
    ///
    /// The label is what turns a flat list of nine `node` processes into "these five are the
    /// backend, these four are the frontend".
    func pidsByLabel(branch: String) -> [pid_t: String] {
        withLock {
            let prefix = "\(branch):"
            return storedPIDs.reduce(into: [pid_t: String]()) { result, entry in
                guard entry.key.hasPrefix(prefix) else { return }
                result[entry.value] = String(entry.key.dropFirst(prefix.count))
            }
        }
    }

    /// Remove and return every PID belonging to a branch.
    func takePIDs(branch: String) -> [pid_t] {
        withLock {
            let prefix = "\(branch):"
            let matching = storedPIDs.filter { $0.key.hasPrefix(prefix) }
            matching.keys.forEach { storedPIDs.removeValue(forKey: $0) }
            return Array(matching.values)
        }
    }

    func allPIDs() -> [pid_t] {
        withLock { Array(storedPIDs.values) }
    }

    // MARK: - Stop suppression

    func beginStopping(branch: String) {
        withLock { _ = storedStopping.insert(branch) }
    }

    func endStopping(branch: String) {
        withLock { _ = storedStopping.remove(branch) }
    }

    func isStopping(branch: String) -> Bool {
        withLock { storedStopping.contains(branch) }
    }

    // MARK: - Watchdog generations

    /// Retire any running watchdog for this branch and return the new generation.
    @discardableResult
    func bumpWatchdogGeneration(branch: String) -> UInt64 {
        withLock {
            let next = (storedWatchdogGenerations[branch] ?? 0) + 1
            storedWatchdogGenerations[branch] = next
            return next
        }
    }

    func watchdogGeneration(branch: String) -> UInt64 {
        withLock { storedWatchdogGenerations[branch] ?? 0 }
    }

    // MARK: - ngrok

    var ngrokPID: pid_t? {
        get { withLock { storedNgrokPID } }
        set { withLock { storedNgrokPID = newValue } }
    }

    var ngrokTunnel: NgrokTunnel? {
        get { withLock { storedNgrokTunnel } }
        set { withLock { storedNgrokTunnel = newValue } }
    }

    @discardableResult
    func takeNgrok() -> (pid: pid_t?, tunnel: NgrokTunnel?) {
        withLock {
            let result = (storedNgrokPID, storedNgrokTunnel)
            storedNgrokPID = nil
            storedNgrokTunnel = nil
            return result
        }
    }
}
