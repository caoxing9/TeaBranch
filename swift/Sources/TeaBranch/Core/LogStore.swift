import Foundation

/// One captured output line. The monotonic `id` survives buffer eviction, so SwiftUI's scroll
/// position and search anchors don't jump when old lines are dropped.
struct LogLine: Identifiable, Hashable, Sendable {
    let id: UInt64
    let text: String
    /// Process label the line came from (`backend`, `frontend`, `dev`), if it carries one.
    let source: String?
    /// `text` without the `[source]` prefix — what the console actually shows.
    ///
    /// The prefix was spending eleven columns of every single line to repeat something the line's
    /// colour and the source tabs both already say. A terminal doesn't stamp its own name down the
    /// left margin, and neither does this any more; the source survives as a gutter mark.
    let displayText: String
    /// `displayText` with the ANSI escapes stripped and lowercased — what log search matches on.
    ///
    /// Computed once here, on the reader thread that captured the line, because the alternative
    /// was recomputing it for every line on every render: the search used to strip and lowercase
    /// the whole buffer from inside a view body, which is main-thread work proportional to the
    /// scrollback and repeated several times a second.
    let haystack: String

    init(id: UInt64, text: String, source: String?) {
        self.id = id
        self.text = text
        self.source = source
        self.displayText = Self.stripPrefix(text, source: source)
        self.haystack = Ansi.plainText(displayText).lowercased()
    }

    /// Drop a leading `[label] ` when it names the source we already recorded.
    private static func stripPrefix(_ text: String, source: String?) -> String {
        guard let source else { return text }
        let prefix = "[\(source)]"
        guard text.hasPrefix(prefix) else { return text }
        var rest = Substring(text.dropFirst(prefix.count))
        // Captured output pads the prefix out to a fixed width, so continuation lines of a
        // multi-line log record carry meaningful leading spaces. Exactly one is the separator.
        if rest.first == " " { rest = rest.dropFirst() }
        return String(rest)
    }
}

/// Thread-safe per-branch log buffers.
///
/// Writers are the stdout/stderr reader threads; the reader is the UI, which polls
/// `generation(of:)` and only rebuilds when something actually changed. That coalescing is
/// what keeps a chatty dev server from melting the main thread one line at a time.
final class LogStore: @unchecked Sendable {
    /// Lines kept *per source*, not in total: capping globally lets a chatty backend push the
    /// (much sparser) frontend lines out of the shared buffer.
    static let perSourceCap = 5000

    private let lock = NSLock()
    private var buffers: [String: [LogLine]] = [:]
    private var generations: [String: UInt64] = [:]
    /// branch → source → how many lines of that source are in the buffer. Kept incrementally so
    /// the cap check is O(1); counting it by scanning the buffer made every single log line cost
    /// a full pass over the scrollback.
    private var sourceCounts: [String: [String: Int]] = [:]
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

    /// Append one line. O(1) amortised.
    ///
    /// The previous version lifted the array out of the dictionary (`var lines = buffers[branch]`),
    /// which left the dictionary holding a second reference — so the very next `append` deep-copied
    /// the whole scrollback. Then it counted the lines of this source by scanning all of them. Both
    /// costs were paid per line, under the lock the UI also takes. `subscript(_:default:)` yields
    /// in-place access instead, and the counts are maintained incrementally.
    func append(branch: String, text: String) {
        let source = Self.source(of: text)
        let countKey = source ?? ""

        lock.lock()
        defer { lock.unlock() }

        nextID += 1
        buffers[branch, default: []].append(LogLine(id: nextID, text: text, source: source))
        sourceCounts[branch, default: [:]][countKey, default: 0] += 1

        if !uncapped.contains(branch), sourceCounts[branch]?[countKey] ?? 0 > Self.perSourceCap {
            // The oldest line of this source is near the front, so this scan is short even though
            // it is nominally linear.
            if let index = buffers[branch]?.firstIndex(where: { ($0.source ?? "") == countKey }) {
                buffers[branch]?.remove(at: index)
                sourceCounts[branch]?[countKey, default: 0] -= 1
            }
        }

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
        sourceCounts[branch] = [:]
        generations[branch, default: 0] += 1
    }

    func remove(branch: String) {
        lock.lock()
        defer { lock.unlock() }
        buffers.removeValue(forKey: branch)
        sourceCounts.removeValue(forKey: branch)
        generations[branch, default: 0] += 1
    }
}
