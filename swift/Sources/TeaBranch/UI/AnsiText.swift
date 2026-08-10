import SwiftUI

/// Minimal ANSI SGR renderer — the native replacement for `anser` + the `AnsiLine` component.
///
/// Only the escapes dev servers actually emit are honoured (colors, bold, italic, underline);
/// every other CSI sequence is swallowed so cursor moves don't leak into the text.
enum Ansi {
    struct Style: Equatable {
        var foreground: Color?
        var background: Color?
        var bold = false
        var italic = false
        var underline = false
        var dim = false
    }

    struct Segment {
        var text: String
        var style: Style
    }

    /// Split a raw line into styled runs.
    static func segments(of line: String) -> [Segment] {
        var segments: [Segment] = []
        var style = Style()
        var buffer = ""
        var index = line.startIndex

        while index < line.endIndex {
            let character = line[index]
            let next = line.index(after: index)

            guard character == "\u{1B}", next < line.endIndex, line[next] == "[" else {
                buffer.append(character)
                index = next
                continue
            }

            var scan = line.index(after: next)
            var parameters = ""
            while scan < line.endIndex, !line[scan].isLetter {
                parameters.append(line[scan])
                scan = line.index(after: scan)
            }
            guard scan < line.endIndex else { break } // truncated escape: drop the tail

            if !buffer.isEmpty {
                segments.append(Segment(text: buffer, style: style))
                buffer = ""
            }
            if line[scan] == "m" {
                apply(parameters: parameters, to: &style)
            }
            index = line.index(after: scan)
        }

        if !buffer.isEmpty {
            segments.append(Segment(text: buffer, style: style))
        }
        return segments
    }

    /// The line with every escape sequence removed.
    static func plainText(_ line: String) -> String {
        segments(of: line).map(\.text).joined()
    }

    /// Render to an `AttributedString`, optionally highlighting search hits. `activeMatch` is
    /// the index *within this line* of the occurrence that should read as the current match.
    static func attributedString(
        for line: String,
        baseColor: Color,
        highlight: String = "",
        activeMatch: Int = -1
    ) -> AttributedString {
        var result = AttributedString()
        let runs = segments(of: line)

        for run in runs {
            var piece = AttributedString(run.text)
            piece.foregroundColor = run.style.foreground ?? baseColor
            if let background = run.style.background { piece.backgroundColor = background }
            piece.font = .system(
                size: Typography.body,
                weight: run.style.bold ? .bold : .regular,
                design: .monospaced
            )
            if run.style.italic { piece.font = piece.font?.italic() }
            if run.style.underline { piece.underlineStyle = .single }
            if run.style.dim { piece.foregroundColor = (run.style.foreground ?? baseColor).opacity(0.7) }
            result.append(piece)
        }

        let needle = highlight.lowercased()
        guard !needle.isEmpty else { return result }

        // Walk the plain text, then map each hit back onto the attributed string by offset.
        let plain = String(result.characters)
        let haystack = plain.lowercased()
        var searchStart = haystack.startIndex
        var occurrence = 0

        while let range = haystack.range(of: needle, range: searchStart..<haystack.endIndex) {
            let lower = haystack.distance(from: haystack.startIndex, to: range.lowerBound)
            let upper = haystack.distance(from: haystack.startIndex, to: range.upperBound)

            let characters = result.characters
            if let start = characters.index(characters.startIndex, offsetBy: lower, limitedBy: characters.endIndex),
               let end = characters.index(characters.startIndex, offsetBy: upper, limitedBy: characters.endIndex) {
                let isActive = occurrence == activeMatch
                result[start..<end].backgroundColor = isActive ? Palette.searchMatchActive : Palette.searchMatch
                if isActive {
                    result[start..<end].foregroundColor = Palette.searchMatchActiveText
                }
            }

            occurrence += 1
            searchStart = range.upperBound == range.lowerBound
                ? haystack.index(after: range.lowerBound)
                : range.upperBound
            if searchStart >= haystack.endIndex { break }
        }

        return result
    }

    /// Occurrences of `needle` in a line, as a count (used to build the match index).
    static func matchCount(in line: String, needle: String) -> Int {
        guard !needle.isEmpty else { return 0 }
        let haystack = plainText(line).lowercased()
        var count = 0
        var start = haystack.startIndex
        while let range = haystack.range(of: needle, range: start..<haystack.endIndex) {
            count += 1
            start = range.upperBound == range.lowerBound
                ? haystack.index(after: range.lowerBound)
                : range.upperBound
            if start >= haystack.endIndex { break }
        }
        return count
    }

    // MARK: - SGR

    private static func apply(parameters: String, to style: inout Style) {
        let codes = parameters
            .split(separator: ";", omittingEmptySubsequences: false)
            .map { Int($0) ?? 0 }
        var index = 0

        // A bare `ESC[m` means reset.
        if codes.isEmpty { style = Style(); return }

        while index < codes.count {
            let code = codes[index]
            switch code {
            case 0: style = Style()
            case 1: style.bold = true
            case 2: style.dim = true
            case 3: style.italic = true
            case 4: style.underline = true
            case 22: style.bold = false; style.dim = false
            case 23: style.italic = false
            case 24: style.underline = false
            case 30...37: style.foreground = standard(code - 30, bright: false)
            case 90...97: style.foreground = standard(code - 90, bright: true)
            case 39: style.foreground = nil
            case 40...47: style.background = standard(code - 40, bright: false)
            case 100...107: style.background = standard(code - 100, bright: true)
            case 49: style.background = nil
            case 38, 48:
                let isForeground = code == 38
                if index + 1 < codes.count, codes[index + 1] == 5, index + 2 < codes.count {
                    let color = xterm256(codes[index + 2])
                    if isForeground { style.foreground = color } else { style.background = color }
                    index += 2
                } else if index + 1 < codes.count, codes[index + 1] == 2, index + 4 < codes.count {
                    let color = Color(
                        .sRGB,
                        red: Double(codes[index + 2]) / 255,
                        green: Double(codes[index + 3]) / 255,
                        blue: Double(codes[index + 4]) / 255
                    )
                    if isForeground { style.foreground = color } else { style.background = color }
                    index += 4
                }
            default:
                break
            }
            index += 1
        }
    }

    private static func standard(_ index: Int, bright: Bool) -> Color {
        let normal: [UInt32] = [0x000000, 0xCD3131, 0x0DBC79, 0xE5E510, 0x2472C8, 0xBC3FBC, 0x11A8CD, 0xE5E5E5]
        let vivid: [UInt32] = [0x666666, 0xF14C4C, 0x23D18B, 0xF5F543, 0x3B8EEA, 0xD670D6, 0x29B8DB, 0xFFFFFF]
        let table = bright ? vivid : normal
        guard table.indices.contains(index) else { return Palette.logText }
        return Color(nsColor: NSColor(hex: table[index]))
    }

    private static func xterm256(_ value: Int) -> Color {
        switch value {
        case 0...7:
            return standard(value, bright: false)
        case 8...15:
            return standard(value - 8, bright: true)
        case 16...231:
            let offset = value - 16
            let steps = [0, 95, 135, 175, 215, 255]
            let red = steps[(offset / 36) % 6]
            let green = steps[(offset / 6) % 6]
            let blue = steps[offset % 6]
            return Color(.sRGB, red: Double(red) / 255, green: Double(green) / 255, blue: Double(blue) / 255)
        case 232...255:
            let level = Double(8 + (value - 232) * 10) / 255
            return Color(.sRGB, red: level, green: level, blue: level)
        default:
            return Palette.logText
        }
    }
}
