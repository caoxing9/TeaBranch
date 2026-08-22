import AppKit
import SwiftUI

/// The log console: one `NSTextView` holding the whole buffer as a single document.
///
/// It was a `LazyVStack` of one `Text` per line, which has a fatal property for a log viewer —
/// **a selection cannot cross a view boundary**. You could select within one line and no further,
/// so copying a stack trace, a SQL statement or a wrapped error meant copying it a line at a time.
/// A text view gives that back for free, along with ⌘A, drag-select, double-click-to-word,
/// find-on-page semantics and native momentum scrolling.
///
/// Two rules keep it fast:
///
///  1. **Append, never rebuild.** New output arrives several times a second; only the new lines are
///     rendered and appended. A full rebuild happens only when the identity of the buffer changes —
///     branch, tab, or an eviction that dropped lines off the front.
///  2. **Highlighting is a separate pass.** Search runs over the finished storage as an attribute
///     change, so typing in the filter box never re-parses anyone's escape sequences.
struct LogTextView: NSViewRepresentable {
    var lines: [LogLine]
    var searchTerm: String
    /// Index into the document-order list of matches, or -1.
    var activeMatch: Int
    var autoScroll: Bool
    /// Whether lines from different processes are mixed, and therefore need a source mark.
    var showsSourceGutter: Bool
    /// Incremented by the owner to request a jump to the end.
    var scrollToBottomToken: Int
    /// Reports whether the view is pinned to the bottom, so the owner can offer a jump button.
    var onPinnedChange: (Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = NSTextView()
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = false
        textView.drawsBackground = false
        textView.allowsUndo = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.isIncrementalSearchingEnabled = false
        textView.textContainerInset = NSSize(width: 8, height: 6)
        textView.autoresizingMask = [.width]
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.lineFragmentPadding = 2
        // A log line is a unit of meaning; wrapping keeps the whole of it reachable without a
        // horizontal scrollbar, which is also what makes select-all-then-copy produce something
        // you can paste into an issue.
        textView.textContainer?.containerSize = NSSize(
            width: 0,
            height: CGFloat.greatestFiniteMagnitude
        )

        let scrollView = NSScrollView()
        scrollView.documentView = textView
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.drawsBackground = false
        scrollView.autohidesScrollers = true

        context.coordinator.textView = textView
        context.coordinator.scrollView = scrollView

        // Watching the clip view is the only way to know the user has scrolled away: the text
        // view has no "did scroll" callback, and polling would either lag or burn a timer.
        scrollView.contentView.postsBoundsChangedNotifications = true
        context.coordinator.scrollObserver = NotificationCenter.default.addObserver(
            forName: NSView.boundsDidChangeNotification,
            object: scrollView.contentView,
            queue: .main
        ) { [weak coordinator = context.coordinator] _ in
            MainActor.assumeIsolated { coordinator?.reportPinnedState() }
        }
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.onPinnedChange = onPinnedChange
        context.coordinator.apply(
            lines: lines,
            searchTerm: searchTerm.trimmingCharacters(in: .whitespaces),
            activeMatch: activeMatch,
            autoScroll: autoScroll,
            showsSourceGutter: showsSourceGutter,
            scrollToBottomToken: scrollToBottomToken
        )
    }

    @MainActor
    final class Coordinator {
        weak var textView: NSTextView?
        weak var scrollView: NSScrollView?

        /// How many of `lines` are already in the storage, and the ids that bracket them — enough
        /// to tell "three new lines arrived" from "the buffer was replaced or evicted from".
        private var renderedCount = 0
        private var firstRenderedID: UInt64?
        private var lastRenderedID: UInt64?

        private var appliedSearch = ""
        private var appliedActiveMatch = -1
        private var matchRanges: [NSRange] = []
        /// The currently-promoted hit and the foreground runs it painted over.
        private var activeForeground: (range: NSRange, saved: [(NSRange, NSColor)])?
        private var showsSourceGutter = true
        private var appliedScrollToken = 0
        private var reportedPinned = true
        /// Set while *we* are moving the viewport. Our own `scrollToEndOfDocument` fires the same
        /// bounds notification a user drag does, and reporting that back as "the user scrolled"
        /// is what let auto-scroll switch itself off one line after it was switched on.
        private var isScrollingProgrammatically = false
        var onPinnedChange: (Bool) -> Void = { _ in }
        var scrollObserver: NSObjectProtocol?

        deinit {
            if let scrollObserver { NotificationCenter.default.removeObserver(scrollObserver) }
        }

        /// Tell the owner whether we are still pinned to the bottom, but only when it changes —
        /// scroll notifications arrive at frame rate.
        func reportPinnedState() {
            guard !isScrollingProgrammatically else { return }
            let pinned = isScrolledToBottom()
            guard pinned != reportedPinned else { return }
            reportedPinned = pinned
            onPinnedChange(pinned)
        }

        private var baseColor: NSColor { NSColor(Palette.logText) }
        private var errorColor: NSColor { NSColor(Palette.logError) }
        private var backendColor: NSColor { NSColor(Palette.logBackend) }
        private var frontendColor: NSColor { NSColor(Palette.logFrontend) }

        func apply(
            lines: [LogLine],
            searchTerm: String,
            activeMatch: Int,
            autoScroll: Bool,
            showsSourceGutter: Bool,
            scrollToBottomToken: Int
        ) {
            guard let textView, let storage = textView.textStorage else { return }

            let wasAtBottom = isScrolledToBottom()
            let gutterChanged = showsSourceGutter != self.showsSourceGutter
            self.showsSourceGutter = showsSourceGutter
            let needsRebuild = gutterChanged || requiresRebuild(for: lines)

            if needsRebuild {
                rebuild(lines: lines, into: storage)
            } else if lines.count > renderedCount {
                append(lines[renderedCount...], into: storage)
                renderedCount = lines.count
                lastRenderedID = lines.last?.id
            }

            let contentGrew = storage.length != appliedLength
            appliedLength = storage.length
            let searchChanged = searchTerm != appliedSearch

            // With no search active there is nothing to highlight and nothing to clear, so the
            // common case — logs streaming, filter box empty — touches no attributes at all.
            let needsHighlight = searchChanged
                || (!searchTerm.isEmpty && (needsRebuild || contentGrew))
            if needsHighlight {
                clearActiveMatch(in: storage)
                applyHighlight(searchTerm, in: storage)
                appliedSearch = searchTerm
                appliedActiveMatch = -1
            }

            if scrollToBottomToken != appliedScrollToken {
                appliedScrollToken = scrollToBottomToken
                scrollToEnd()
            } else if activeMatch != appliedActiveMatch {
                markActiveMatch(activeMatch, in: storage)
                appliedActiveMatch = activeMatch
                scrollToActiveMatch()
            } else if autoScroll, contentGrew || needsRebuild {
                // `autoScroll` is the user's stated intent, so it wins outright. The previous
                // version also required the viewport to already be at the bottom, which is a
                // heuristic that fights the switch instead of implementing it.
                scrollToEnd()
            }
            _ = wasAtBottom
        }

        /// Jump to the end without the move being mistaken for the user scrolling.
        private func scrollToEnd() {
            guard let textView else { return }
            isScrollingProgrammatically = true
            textView.scrollToEndOfDocument(nil)
            // Cleared a turn of the run loop later: the bounds notification this triggers is
            // delivered asynchronously, so clearing it inline would be too early.
            DispatchQueue.main.async { [weak self] in
                self?.isScrollingProgrammatically = false
                self?.reportPinnedState()
            }
        }

        private var appliedLength = 0

        // MARK: - Building

        /// A rebuild is needed when the storage no longer corresponds to a prefix of `lines`:
        /// a different branch or tab, a cleared buffer, or an eviction that dropped the oldest
        /// lines off the front (which shifts every offset we hold).
        private func requiresRebuild(for lines: [LogLine]) -> Bool {
            if lines.isEmpty { return renderedCount != 0 }
            if renderedCount == 0 { return true }
            if lines.count < renderedCount { return true }
            if lines.first?.id != firstRenderedID { return true }
            return lines[renderedCount - 1].id != lastRenderedID
        }

        private func rebuild(lines: [LogLine], into storage: NSTextStorage) {
            storage.beginEditing()
            storage.setAttributedString(NSAttributedString())
            for line in lines {
                storage.append(render(line))
            }
            storage.endEditing()

            renderedCount = lines.count
            firstRenderedID = lines.first?.id
            lastRenderedID = lines.last?.id
        }

        private func append(_ newLines: ArraySlice<LogLine>, into storage: NSTextStorage) {
            storage.beginEditing()
            for line in newLines {
                storage.append(render(line))
            }
            storage.endEditing()
        }

        /// One line plus its trailing newline, tinted by source with errors taking precedence.
        ///
        /// Two things make this read like a terminal rather than like a table of log records:
        /// the `[backend]` prefix is gone (it lives in `LogLine.displayText`, and its information
        /// survives as a one-column gutter mark), and wrapped lines hang under the text rather
        /// than resetting to column zero.
        private func render(_ line: LogLine) -> NSAttributedString {
            let color: NSColor
            if line.haystack.contains("error") {
                color = errorColor
            } else {
                switch line.source {
                case "backend": color = backendColor
                case "frontend": color = frontendColor
                default: color = baseColor
                }
            }

            let font = NSFont.monospacedSystemFont(ofSize: Typography.small, weight: .regular)
            let prefix = showsSourceGutter ? "[\(line.source ?? "app")] " : ""
            let gutterWidth = font.maximumAdvancement.width * CGFloat(prefix.count)

            let paragraph = NSMutableParagraphStyle()
            paragraph.lineBreakMode = .byWordWrapping
            // Continuation lines of a wrapped record line up under the first, so a long JSON blob
            // stays visually one entry instead of merging into its neighbours.
            paragraph.headIndent = gutterWidth + font.maximumAdvancement.width * 2
            // Wrapped lines hang under the message, clear of the source label.
            paragraph.firstLineHeadIndent = 0
            paragraph.lineSpacing = 1

            let rendered = NSMutableAttributedString()

            if !prefix.isEmpty {
                // The source label, dimmed so it reads as a margin rather than as part of the
                // line. Only in the "All" tab — a single-source tab has nothing to disambiguate,
                // and there the full width goes to the message.
                rendered.append(NSAttributedString(
                    string: prefix,
                    attributes: [.font: font, .foregroundColor: color.withAlphaComponent(0.55)]
                ))
            }

            rendered.append(Ansi.nsAttributedString(
                for: line.displayText,
                baseColor: color,
                fontSize: Typography.small
            ))
            rendered.append(NSAttributedString(
                string: "\n",
                attributes: [.font: font, .foregroundColor: color]
            ))
            rendered.addAttribute(
                .paragraphStyle,
                value: paragraph,
                range: NSRange(location: 0, length: rendered.length)
            )
            return rendered
        }

        // MARK: - Search

        /// Case-insensitive occurrences of `needle`, highlighted in place.
        ///
        /// Searching the storage's own string rather than the `LogLine` haystacks avoids having to
        /// map lowercased offsets back onto the document — lowercasing is not always
        /// length-preserving, and a one-character drift would highlight the wrong span.
        private func applyHighlight(_ needle: String, in storage: NSTextStorage) {
            let full = NSRange(location: 0, length: storage.length)
            storage.beginEditing()
            storage.removeAttribute(.backgroundColor, range: full)
            matchRanges.removeAll(keepingCapacity: true)

            guard !needle.isEmpty else {
                storage.endEditing()
                return
            }

            let haystack = storage.mutableString
            var searchStart = 0
            while searchStart < haystack.length {
                let remaining = NSRange(
                    location: searchStart,
                    length: haystack.length - searchStart
                )
                let found = haystack.range(of: needle, options: .caseInsensitive, range: remaining)
                guard found.location != NSNotFound else { break }

                matchRanges.append(found)
                storage.addAttribute(.backgroundColor, value: NSColor(Palette.searchMatch), range: found)
                searchStart = found.location + max(found.length, 1)
            }
            storage.endEditing()
        }

        /// The active hit needs a legible foreground on its bright background, which means
        /// overriding whatever colour the ANSI parse gave that span. The original runs are saved
        /// first and restored when the hit is demoted — the naive version (`removeAttribute`) ate
        /// the line's colour permanently, so stepping through matches slowly bleached the log.
        private func markActiveMatch(_ index: Int, in storage: NSTextStorage) {
            storage.beginEditing()
            restoreActiveForeground(in: storage)

            if matchRanges.indices.contains(index) {
                let range = matchRanges[index]
                var saved: [(NSRange, NSColor)] = []
                storage.enumerateAttribute(.foregroundColor, in: range) { value, subrange, _ in
                    if let color = value as? NSColor { saved.append((subrange, color)) }
                }
                activeForeground = (range, saved)

                storage.addAttribute(.backgroundColor, value: NSColor(Palette.searchMatchActive), range: range)
                storage.addAttribute(
                    .foregroundColor,
                    value: NSColor(Palette.searchMatchActiveText),
                    range: range
                )
            }
            storage.endEditing()
        }

        /// Put the previously-active hit back to a plain highlight with its own colours.
        private func restoreActiveForeground(in storage: NSTextStorage) {
            guard let (range, saved) = activeForeground else { return }
            activeForeground = nil
            guard NSMaxRange(range) <= storage.length else { return }

            storage.addAttribute(.backgroundColor, value: NSColor(Palette.searchMatch), range: range)
            storage.removeAttribute(.foregroundColor, range: range)
            for (subrange, color) in saved where NSMaxRange(subrange) <= storage.length {
                storage.addAttribute(.foregroundColor, value: color, range: subrange)
            }
        }

        private func clearActiveMatch(in storage: NSTextStorage) {
            storage.beginEditing()
            restoreActiveForeground(in: storage)
            storage.endEditing()
        }

        private func scrollToActiveMatch() {
            guard let textView, matchRanges.indices.contains(appliedActiveMatch) else { return }
            textView.scrollRangeToVisible(matchRanges[appliedActiveMatch])
            textView.showFindIndicator(for: matchRanges[appliedActiveMatch])
        }

        // MARK: - Scrolling

        /// Whether the view is pinned to the bottom, within a line's slack.
        ///
        /// Auto-scroll only fires when the user is already at the bottom: yanking the view down
        /// while they are reading scrollback is the single most obnoxious thing a log viewer can do.
        private func isScrolledToBottom() -> Bool {
            guard let scrollView, let documentView = scrollView.documentView else { return true }
            let visible = scrollView.contentView.bounds
            let slack: CGFloat = 24
            return visible.maxY >= documentView.bounds.height - slack
        }
    }
}
