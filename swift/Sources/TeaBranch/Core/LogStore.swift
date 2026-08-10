import Foundation

/// One captured output line. The monotonic `id` survives buffer eviction, so SwiftUI's scroll
/// position and search anchors don't jump when old lines are dropped.
struct LogLine: Identifiable, Hashable, Sendable {
    let id: UInt64
    let text: String
    /// Process label the line came from (`backend`, `frontend`, `dev`), if it carries one.
    let source: String?
}

/// Thread-safe per-branch log buffers.
///
/// Writers are the stdout/stderr reader threads; the reader is the UI, which polls
/// `generation(of:)` and only rebuilds when something actually changed. That coalescing is
/// what keeps a chatty dev server from melting the main thread one line at a time.
final class LogStore: @unchecked Sendable {
    /// Lines kept *per source*, not in total: capping globally lets a chatty backend push the
    /// (much sparser) frontend lines out of the shared buffer.
    static let perSourceCap = 2000

    private let lock = NSLock()
    private var buffers: [String: [LogLine]] = [:]
    private var generations: [String: UInt64] = [:]
    private var nextID: UInt64 = 0
    /// Branches the user asked to stop capping. Applies to output captured from then on —
    /// lines already evicted are gone.
    private var uncapped: Set<String> = []

    /// Known process labels. Anything else is treated as unsourced and shows only under "All".
    static let knownSources = ["backend", "frontend", "dev"]

    /// Pull the `[label]` prefix off a line, if it names a known source.
    static func source(of text: String) -> String? {
        guard text.hasPrefix("["), let close = text.firstIndex(of: "]") else { return nil }
        let label = String(text[text.index(after: text.startIndex)..<close])
        return knownSources.contains(label) ? label : nil
    }

    func append(branch: String, text: String) {
        let source = Self.source(of: text)
        lock.lock()
        defer { lock.unlock() }

        nextID += 1
        var lines = buffers[branch] ?? []
        lines.append(LogLine(id: nextID, text: text, source: source))

        if !uncapped.contains(branch) {
            var sameSource = 0
            for line in lines where line.source == source { sameSource += 1 }
            if sameSource > Self.perSourceCap,
               let index = lines.firstIndex(where: { $0.source == source }) {
                lines.remove(at: index)
            }
        }

        buffers[branch] = lines
        generations[branch, default: 0] += 1
    }

    func setUncapped(_ uncapped: Bool, branch: String) {
        lock.lock()
        defer { lock.unlock() }
        if uncapped { self.uncapped.insert(branch) } else { self.uncapped.remove(branch) }
    }

    func isUncapped(branch: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return uncapped.contains(branch)
    }

    func snapshot(branch: String) -> [LogLine] {
        lock.lock()
        defer { lock.unlock() }
        return buffers[branch] ?? []
    }

    func generation(of branch: String) -> UInt64 {
        lock.lock()
        defer { lock.unlock() }
        return generations[branch] ?? 0
    }

    func clear(branch: String) {
        lock.lock()
        defer { lock.unlock() }
        buffers[branch] = []
        generations[branch, default: 0] += 1
    }

    func remove(branch: String) {
        lock.lock()
        defer { lock.unlock() }
        buffers.removeValue(forKey: branch)
        generations[branch, default: 0] += 1
    }
}
