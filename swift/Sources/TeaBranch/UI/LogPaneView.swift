import AppKit
import Observation
import SwiftUI

/// Pulls a branch's log buffer onto the main actor on a timer.
///
/// Log lines arrive on the reader threads faster than SwiftUI wants to re-render, so instead of
/// pushing every line we poll a generation counter and rebuild only when it moved.
@MainActor
@Observable
final class LogFeed {
    private(set) var lines: [LogLine] = []

    private let store: LogStore
    private var key: String
    private var generation: UInt64 = 0
    private var timer: Timer?

    init(store: LogStore, key: String) {
        self.store = store
        self.key = key
    }

    func rebind(to key: String) {
        guard key != self.key else { return }
        self.key = key
        generation = 0
        lines = []
        pull()
    }

    func start() {
        pull()
        timer?.invalidate()
        let timer = Timer(timeInterval: 0.15, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.pull() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    func clear() {
        store.clear(branch: key)
        pull()
    }

    private func pull() {
        let current = store.generation(of: key)
        guard current != generation else { return }
        generation = current
        lines = store.snapshot(branch: key)
    }
}

struct LogPaneView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var branch: Branch

    private enum Tab: Hashable {
        case all
        case source(String)
        case ngrok

        var title: String {
            switch self {
            case .all: return "All"
            case .source(let name): return name.capitalized
            case .ngrok: return "Ngrok"
            }
        }
    }

    @State private var branchFeed = LogFeed(store: AppState.shared.logs, key: "")
    @State private var ngrokFeed = LogFeed(store: AppState.shared.ngrokLogs, key: AppState.ngrokLogKey)
    @State private var tab: Tab = .all
    @State private var searchText = ""
    @State private var activeMatch = 0
    @State private var autoScroll = true
    @State private var unlimited = false
    @State private var toast: String?
    @FocusState private var searchFocused: Bool

    private var isNgrokForThisBranch: Bool { model.ngrok?.branchName == branch.name }

    private var visibleLines: [LogLine] {
        switch tab {
        case .all: return branchFeed.lines
        case .source(let name): return branchFeed.lines.filter { $0.source == name }
        case .ngrok: return ngrokFeed.lines
        }
    }

    /// Sources actually present in the buffer, in a stable order.
    private var presentSources: [String] {
        let seen = Set(branchFeed.lines.compactMap(\.source))
        return LogStore.knownSources.filter(seen.contains)
    }

    /// (line offset, occurrence within that line) for every hit, in document order.
    private var matches: [(line: Int, local: Int)] {
        let needle = searchText.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty, tab != .ngrok else { return [] }

        var result: [(Int, Int)] = []
        for (index, line) in visibleLines.enumerated() {
            let count = Ansi.matchCount(in: line.text, needle: needle)
            for local in 0..<count {
                result.append((index, local))
            }
        }
        return result
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            logBody
        }
        .onAppear {
            branchFeed.rebind(to: branch.name)
            branchFeed.start()
            ngrokFeed.start()
        }
        .onDisappear {
            branchFeed.stop()
            ngrokFeed.stop()
        }
        .onChange(of: branch.name) { _, name in
            branchFeed.rebind(to: name)
            tab = .all
            unlimited = AppState.shared.logs.isUncapped(branch: name)
        }
        .onChange(of: isNgrokForThisBranch) { _, active in
            if !active, tab == .ngrok { tab = .all }
        }
        .onChange(of: searchText) { _, _ in
            activeMatch = 0
            if !matches.isEmpty { autoScroll = false }
        }
    }

    // MARK: - Toolbar

    /// Source tabs and search stay on the surface — they are what you reach for while reading. The
    /// four toggles behind them (copy, cap, auto-scroll, clear) were the same visual weight as the
    /// tabs despite being set-once controls, so they moved one level down.
    private var toolbar: some View {
        HStack(spacing: 8) {
            HStack(spacing: 3) {
                tabButton(.all, count: branchFeed.lines.count)
                ForEach(presentSources, id: \.self) { source in
                    tabButton(
                        .source(source),
                        count: branchFeed.lines.count { $0.source == source }
                    )
                }
                if isNgrokForThisBranch {
                    tabButton(.ngrok, count: ngrokFeed.lines.count)
                }
            }

            searchField

            // Match stepping appears only while there is something to step through.
            if !matches.isEmpty {
                HStack(spacing: 2) {
                    PillButton(
                        title: "",
                        systemImage: "chevron.up",
                        horizontalPadding: 5,
                        accessibilityLabel: "Previous match"
                    ) {
                        jump(to: activeMatch - 1)
                    }
                    .help("Previous match (⇧⏎)")
                    PillButton(
                        title: "",
                        systemImage: "chevron.down",
                        horizontalPadding: 5,
                        accessibilityLabel: "Next match"
                    ) {
                        jump(to: activeMatch + 1)
                    }
                    .help("Next match (⏎)")
                }
                .transition(.opacity)
            }

            logMenu
        }
        .animation(Motion.snappy(reduceMotion), value: matches.isEmpty)
        .padding(.horizontal, Layout.gutter)
        .padding(.vertical, 6)
        .chromeBackground(reduceTransparency: reduceTransparency)
        .bottomDivider()
    }

    private var logMenu: some View {
        Menu {
            Button(searchText.trimmingCharacters(in: .whitespaces).isEmpty
                   ? "Copy All Lines"
                   : "Copy Matching Lines") {
                copyAll()
            }
            .disabled(visibleLines.isEmpty)

            Button("Clear") {
                if tab == .ngrok { ngrokFeed.clear() } else { branchFeed.clear() }
            }

            Divider()

            Toggle("Auto-scroll", isOn: $autoScroll)
            Toggle("Keep Every Line", isOn: Binding(
                get: { unlimited },
                set: {
                    unlimited = $0
                    AppState.shared.logs.setUncapped($0, branch: branch.name)
                }
            ))
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 11, weight: .semibold))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        // A paused feed or an uncapped buffer is state you must be able to see without opening
        // the menu that set it.
        .foregroundStyle(autoScroll && !unlimited ? Palette.textSecondary : Palette.accent)
        .accessibilityLabel("Log options")
        .help(autoScroll ? "Log options" : "Log options — auto-scroll is off")
    }

    private func tabButton(_ target: Tab, count: Int) -> some View {
        let isActive = tab == target
        return Button {
            tab = target
            activeMatch = 0
        } label: {
            HStack(spacing: 4) {
                Text(target.title).font(.system(size: 11, weight: isActive ? .semibold : .medium))
                Text("\(count)")
                    .font(.system(size: 10))
                    // Counts tick up several times a second while a server boots; monospaced digits
                    // keep the tab from twitching wider and narrower as they do.
                    .monospacedDigit()
                    .opacity(0.7)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .foregroundStyle(isActive ? Palette.accent : Palette.textSecondary)
            .background(
                isActive ? Palette.accentDim : .clear,
                in: Capsule()
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(Motion.snappy(reduceMotion), value: isActive)
    }

    private var searchField: some View {
        HStack(spacing: 4) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(Palette.textSecondary)

            TextField("Filter logs", text: $searchText)
                .textFieldStyle(.plain)
                .font(.system(size: 11))
                .monospaced()
                .focused($searchFocused)
                .onSubmit { jump(to: activeMatch + 1) }
                .onKeyPress(.escape) {
                    searchText = ""
                    searchFocused = false
                    return .handled
                }

            if !searchText.trimmingCharacters(in: .whitespaces).isEmpty {
                Text(matches.isEmpty ? "0/0" : "\(activeMatch + 1)/\(matches.count)")
                    .font(.system(size: 10))
                    .monospacedDigit()
                    .foregroundStyle(matches.isEmpty ? Palette.statusError : Palette.textSecondary)
            }
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .background(Palette.fillSubtle, in: Capsule())
        .overlay {
            Capsule().strokeBorder(searchFocused ? Palette.accent : Palette.border, lineWidth: 1)
        }
        .animation(Motion.snappy(reduceMotion), value: searchFocused)
        .frame(minWidth: 110)
        .accessibilityLabel("Filter logs")
    }

    // MARK: - Log body

    @ViewBuilder
    private var logBody: some View {
        ZStack(alignment: .bottomTrailing) {
            if visibleLines.isEmpty {
                Text(emptyMessage)
                    .font(.system(size: 11))
                    .foregroundStyle(Palette.logTextDim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    .padding(24)
                    .background(Palette.logBg)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(visibleLines.enumerated()), id: \.element.id) { index, line in
                                LogRowView(
                                    line: line,
                                    searchTerm: tab == .ngrok ? "" : searchText.trimmingCharacters(in: .whitespaces),
                                    activeMatchLocal: activeMatchLocal(for: index),
                                    onCopy: { copy($0, note: "Copied line") }
                                )
                                .id(line.id)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 4)
                    }
                    .background(Palette.logBg)
                    .onChange(of: visibleLines.count) { _, _ in
                        guard autoScroll, let last = visibleLines.last else { return }
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                    .onChange(of: activeMatch) { _, _ in scrollToMatch(proxy) }
                    .onChange(of: searchText) { _, _ in scrollToMatch(proxy) }
                }
            }

            if let toast {
                Text(toast)
                    .font(.system(size: 11, weight: .semibold))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .foregroundStyle(Palette.accentOn)
                    .background(Palette.accent, in: Capsule())
                    .shadow(color: .black.opacity(0.25), radius: 10, y: 3)
                    .padding(12)
                    // Confirmation arrives from below and settles with a little overshoot: the
                    // click threw it there, so it is allowed to land like a thrown thing.
                    .transition(
                        reduceMotion
                            ? .opacity
                            : .move(edge: .bottom).combined(with: .opacity)
                    )
            }

            if matches.isEmpty, !searchText.trimmingCharacters(in: .whitespaces).isEmpty {
                Text("No matches")
                    .font(.system(size: 10))
                    .foregroundStyle(Palette.textSecondary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(.regularMaterial, in: Capsule())
                    .overlay { Capsule().strokeBorder(Palette.border, lineWidth: 1) }
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.top, 8)
                    .frame(maxHeight: .infinity, alignment: .top)
                    .allowsHitTesting(false)
                    .transition(.opacity)
            }
        }
        .animation(Motion.momentum(reduceMotion), value: toast)
    }

    private var emptyMessage: String {
        if tab == .ngrok {
            return isNgrokForThisBranch ? "Waiting for ngrok output..." : "No ngrok tunnel running"
        }
        return branch.status == .stopped ? "Start the branch to see logs" : "Waiting for output..."
    }

    private func activeMatchLocal(for index: Int) -> Int {
        guard matches.indices.contains(activeMatch) else { return -1 }
        let match = matches[activeMatch]
        return match.line == index ? match.local : -1
    }

    private func jump(to index: Int) {
        guard !matches.isEmpty else { return }
        let count = matches.count
        activeMatch = ((index % count) + count) % count
        autoScroll = false
    }

    private func scrollToMatch(_ proxy: ScrollViewProxy) {
        guard matches.indices.contains(activeMatch) else { return }
        let lineIndex = matches[activeMatch].line
        guard visibleLines.indices.contains(lineIndex) else { return }
        proxy.scrollTo(visibleLines[lineIndex].id, anchor: .center)
    }

    // MARK: - Clipboard

    private func copyAll() {
        let needle = searchText.trimmingCharacters(in: .whitespaces).lowercased()
        let lines = needle.isEmpty
            ? visibleLines
            : visibleLines.filter { Ansi.plainText($0.text).lowercased().contains(needle) }
        let text = lines.map { Ansi.plainText($0.text) }.joined(separator: "\n")
        copy(text, note: needle.isEmpty ? "Copied \(lines.count) lines" : "Copied \(lines.count) matching lines")
    }

    private func copy(_ text: String, note: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        withAnimation { toast = note }
        Task {
            try? await Task.sleep(for: .milliseconds(1300))
            withAnimation { toast = nil }
        }
    }
}

/// One log line: ANSI-styled text, selectable, with a copy button on hover.
private struct LogRowView: View {
    var line: LogLine
    var searchTerm: String
    var activeMatchLocal: Int
    var onCopy: (String) -> Void

    @State private var isHovering = false

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Text(Ansi.attributedString(
                for: line.text,
                baseColor: baseColor,
                highlight: searchTerm,
                activeMatch: activeMatchLocal
            ))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)

            if isHovering {
                Button {
                    onCopy(Ansi.plainText(line.text))
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.system(size: 9, weight: .medium))
                        .padding(4)
                        .foregroundStyle(Palette.logText)
                        .background(.regularMaterial, in: Circle())
                        .overlay { Circle().strokeBorder(Palette.border, lineWidth: 1) }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Copy line")
                .transition(.opacity)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 1)
        .background(isHovering ? Palette.logText.opacity(0.07) : .clear)
        .onHover { isHovering = $0 }
    }

    /// Tint by source, with errors taking precedence — same rules as the web build's row classes.
    private var baseColor: Color {
        if line.text.localizedCaseInsensitiveContains("error") { return Palette.logError }
        switch line.source {
        case "backend": return Palette.logBackend
        case "frontend": return Palette.logFrontend
        default: return Palette.logText
        }
    }
}
