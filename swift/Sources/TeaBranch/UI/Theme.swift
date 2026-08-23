import AppKit
import SwiftUI

// MARK: - Colour

/// System-semantic colour tokens.
///
/// Nothing structural hard-codes a hue. Text, separators, fills and the accent all resolve through
/// AppKit's semantic colours, so the UI follows the user's accent colour, appearance, increased
/// contrast and reduced-transparency settings without a second code path.
///
/// Since the macOS 26 rebuild the *chrome* is Liquid Glass (see `Surface`) and these fills are
/// reserved for the content layer underneath it — selection, hover, dividers. Glass floats above
/// content; it is not what content is painted with.
enum Palette {
    // MARK: Text

    static let textPrimary = Color.primary
    static let textSecondary = Color.secondary
    static let textTertiary = Color(nsColor: .tertiaryLabelColor)

    // MARK: Accent — follows System Settings ▸ Appearance ▸ Accent colour

    static let accent = Color.accentColor
    static let accentDim = Color.accentColor.opacity(0.15)
    /// Legible on top of `accent` — the same choice `.borderedProminent` makes.
    static let accentOn = Color.white

    // MARK: Fills
    //
    // `Color.primary` is near-black in light and near-white in dark, so a single opacity reads
    // correctly in both appearances.

    /// Tints a region under chrome, for the reduced-transparency path where glass is switched off.
    static let chromeFill = Color.primary.opacity(0.04)

    static let fillSubtle = Color.primary.opacity(0.05)
    static let fillHover = Color.primary.opacity(0.09)
    static let fillPressed = Color.primary.opacity(0.14)

    static let border = Color(nsColor: .separatorColor)
    static let borderStrong = Color(nsColor: .tertiaryLabelColor)

    // MARK: Status

    static let statusRunning = Color(nsColor: .systemGreen)
    static let statusStopped = Color(nsColor: .tertiaryLabelColor)
    static let statusBuilding = Color(nsColor: .systemOrange)
    static let statusError = Color(nsColor: .systemRed)
    static let statusErrorDim = Color(nsColor: .systemRed).opacity(0.12)

    /// An agent (Claude Code) working in this worktree's terminal.
    static let statusAgent = Color(nsColor: .systemPurple)

    // MARK: Log console
    //
    // The console renders ANSI, which is defined in absolute colours — so this one region keeps a
    // fixed ramp instead of semantic colours. It still swaps per appearance.

    static let logBg = dynamic(dark: 0x06060E, darkAlpha: 0.55, light: 0xFFFFFF, lightAlpha: 0.55)
    static let logText = dynamic(dark: 0xC9D1D9, light: 0x24292F)
    static let logTextDim = dynamic(dark: 0x656C76, light: 0x8C959F)
    static let logBackend = dynamic(dark: 0xF0883E, light: 0xBF5A15)
    static let logFrontend = dynamic(dark: 0x58A6FF, light: 0x0550AE)
    static let logError = dynamic(dark: 0xF85149, light: 0xCF222E)

    static let searchMatch = Color(nsColor: .systemYellow).opacity(0.3)
    static let searchMatchActive = Color(nsColor: .systemYellow).opacity(0.9)
    static let searchMatchActiveText = Color.black

    // MARK: Shape

    /// Row/card radius. Matches the concentricity of macOS 26's own list selections.
    static let cornerRadius: CGFloat = 10
    /// Radius for the small controls that sit *inside* a row.
    static let controlRadius: CGFloat = 7

    static func color(for status: BranchStatus) -> Color {
        switch status {
        case .running: return statusRunning
        case .stopped: return statusStopped
        case .building: return statusBuilding
        case .error: return statusError
        }
    }

    /// Lane colours read as a progression — parked, in flight, landed.
    static func color(for category: DevCategory) -> Color {
        switch category {
        case .developing: return Color(nsColor: .systemBlue)
        case .todo: return Color(nsColor: .systemGray)
        case .done: return Color(nsColor: .systemGreen)
        }
    }

    // MARK: - Building blocks

    static func dynamic(
        dark: UInt32,
        darkAlpha: CGFloat = 1,
        light: UInt32,
        lightAlpha: CGFloat = 1
    ) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return isDark
                ? NSColor(hex: dark, alpha: darkAlpha)
                : NSColor(hex: light, alpha: lightAlpha)
        })
    }
}

extension NSColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}

// MARK: - Liquid Glass

/// The chrome layer.
///
/// Liquid Glass is for controls that *float above* content — toolbars, the action bar, the
/// now-running strip, popovers. Content itself stays on ordinary backgrounds. Two rules keep it
/// from turning to soup:
///
///  1. **Never nest glass in glass.** Sibling glass elements that sit near each other go inside a
///     `GlassEffectContainer` so the system blends them into one shape instead of stacking blurs.
///  2. **Reduced transparency wins.** The accessibility setting exists because translucency itself
///     is the problem, so that path goes opaque rather than merely less blurry.
enum Surface {
    /// Chrome that carries controls. Interactive so it responds to the pointer the way system
    /// controls do.
    static var chrome: Glass { .regular.interactive() }

    /// Chrome that is currently expressing the accent — an active filter, a primary action.
    static func tinted(_ color: Color) -> Glass { .regular.tint(color).interactive() }
}

extension View {
    /// Puts this view on glass, in `shape`, honouring reduced transparency.
    ///
    /// The fallback is a solid fill plus a hairline rather than a dimmer glass: at that point the
    /// user has asked for edges they can see, and a border is the thing that provides them.
    @ViewBuilder
    func glassSurface(
        _ glass: Glass = Surface.chrome,
        in shape: some Shape = RoundedRectangle(cornerRadius: Palette.cornerRadius, style: .continuous),
        reduceTransparency: Bool = false
    ) -> some View {
        if reduceTransparency {
            background(Color(nsColor: .windowBackgroundColor), in: shape)
                .overlay { shape.stroke(Palette.border, lineWidth: 1) }
        } else {
            glassEffect(glass, in: shape)
        }
    }

    /// The chrome layer behind a toolbar or bottom bar that spans the full width.
    ///
    /// Edge-to-edge chrome takes a plain rect, not a capsule: a rounded shape that reaches both
    /// window edges reads as a mistake rather than as a floating control.
    @ViewBuilder
    func chromeBackground(reduceTransparency: Bool) -> some View {
        if reduceTransparency {
            background(Color(nsColor: .windowBackgroundColor))
        } else {
            background {
                Rectangle()
                    .fill(.clear)
                    .glassEffect(.regular, in: Rectangle())
            }
        }
    }
}

// MARK: - Appearance

/// Which appearance the user picked.
enum ThemePreference: String, CaseIterable, Hashable {
    case dark, light, system

    var label: String {
        switch self {
        case .dark: return "Dark"
        case .light: return "Light"
        case .system: return "Match System"
        }
    }

    /// `nil` follows the system.
    var appearance: NSAppearance? {
        switch self {
        case .dark: return NSAppearance(named: .darkAqua)
        case .light: return NSAppearance(named: .aqua)
        case .system: return nil
        }
    }

    var symbolName: String {
        switch self {
        case .dark: return "moon.fill"
        case .light: return "sun.max.fill"
        case .system: return "circle.lefthalf.filled"
        }
    }
}

// MARK: - Motion

/// Springs, in Apple's two designer-facing parameters: *response* (how fast it reaches the target,
/// in seconds) and *damping ratio* (1.0 settles without overshoot, below 1.0 bounces).
///
/// A spring has no fixed duration and starts from wherever the value currently sits on screen, so
/// every one of these is interruptible and reversible mid-flight. That is the point — a fixed
/// `easeOut` cannot be grabbed and redirected.
enum Motion {
    /// The default for anything a user can touch. Critically damped: graceful, never distracting.
    static let standard = Animation.spring(response: 0.35, dampingFraction: 1.0)

    /// Press and hover feedback. Same critical damping, shorter response, because the whole job is
    /// to land before the user perceives a gap.
    static let snappy = Animation.spring(response: 0.2, dampingFraction: 1.0)

    /// Slight overshoot. Reserved for motion the *user's own gesture* set going — a drag release, a
    /// drawer flung open. Bounce on something that merely faded in feels wrong.
    static let momentum = Animation.spring(response: 0.32, dampingFraction: 0.8)

    /// The reduced-motion equivalent: a short cross-fade with no travel and no overshoot.
    static let reduced = Animation.easeOut(duration: 0.15)

    static func standard(_ reduceMotion: Bool) -> Animation { reduceMotion ? reduced : standard }
    static func snappy(_ reduceMotion: Bool) -> Animation { reduceMotion ? reduced : snappy }
    static func momentum(_ reduceMotion: Bool) -> Animation { reduceMotion ? reduced : momentum }
}

extension AnyTransition {
    /// A push, the way a navigation stack moves: the incoming view arrives from the trailing edge
    /// and leaves the same way it came. Under reduced motion it degrades to a plain cross-fade,
    /// because the objection to travel is vestibular, not aesthetic.
    static func push(from edge: Edge, reduceMotion: Bool) -> AnyTransition {
        guard !reduceMotion else { return .opacity }
        return .asymmetric(
            insertion: .move(edge: edge).combined(with: .opacity),
            removal: .move(edge: edge).combined(with: .opacity)
        )
    }
}

// MARK: - Typography

/// One ramp, six steps, every size in the app drawn from it.
///
/// The ramp is sized for a real resizable window, not the 420pt popover the app started as: `body`
/// is macOS's own 13pt control size, so the interface matches the system controls sitting next to
/// it instead of reading a step small everywhere.
///
/// Tracking is size-specific: letters read too far apart as type grows and too tight as it shrinks,
/// so one `letter-spacing` value is always wrong somewhere.
enum Typography {
    /// Badges and counters — the only text allowed below `caption`.
    static let micro: CGFloat = 10
    /// Field labels, port chips, metadata.
    static let caption: CGFloat = 11
    /// Secondary values and log lines.
    static let small: CGFloat = 12
    /// The workhorse: values, buttons, list rows. macOS's standard control size.
    static let body: CGFloat = 13
    /// Emphasis inside a dense row — branch names in the list, sheet fields.
    static let callout: CGFloat = 14
    /// Screen and section titles.
    static let headline: CGFloat = 16
    /// Sheet titles.
    static let title: CGFloat = 19
    /// Onboarding only.
    static let hero: CGFloat = 38

    static func tracking(forPointSize size: CGFloat) -> CGFloat {
        switch size {
        case ..<11: return 0.1
        case ..<20: return 0
        case ..<32: return -0.4
        default: return -1.0
        }
    }
}

extension View {
    /// Applies the tracking that belongs to a given optical size.
    func opticalTracking(_ size: CGFloat) -> some View {
        tracking(Typography.tracking(forPointSize: size))
    }
}

// MARK: - Layout

enum Layout {
    /// Horizontal margin for content. One value, so every edge lines up down the window.
    static let gutter: CGFloat = 14
    /// Spacing between sibling glass elements inside a `GlassEffectContainer`. Below this they
    /// merge into one blob; far above it they stop reading as a group.
    static let glassSpacing: CGFloat = 8
    /// Sidebar width bounds for the split view.
    static let sidebarMin: CGFloat = 220
    static let sidebarIdeal: CGFloat = 270
    static let sidebarMax: CGFloat = 380
}

// MARK: - Scroll edge

/// How far the scroll content has travelled under the floating chrome.
///
/// The separator under a toolbar should exist only where content actually passes beneath it — a
/// permanent 1px rule draws a line through nothing most of the time.
struct ScrollEdgeKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

extension View {
    /// Publishes this content's scroll offset within `space` up to an `onPreferenceChange`.
    func reportsScrollEdge(in space: String) -> some View {
        background {
            GeometryReader { proxy in
                Color.clear.preference(
                    key: ScrollEdgeKey.self,
                    value: -proxy.frame(in: .named(space)).minY
                )
            }
        }
    }

    /// A separator that fades in only once content has slid underneath.
    func scrollEdgeDivider(isVisible: Bool) -> some View {
        overlay(alignment: .bottom) {
            Rectangle()
                .fill(Palette.border)
                .frame(height: 1)
                .opacity(isVisible ? 1 : 0)
                .animation(.easeOut(duration: 0.18), value: isVisible)
        }
    }

    /// Hairline separator, for the few places where two regions genuinely abut.
    func bottomDivider() -> some View {
        overlay(alignment: .bottom) {
            Rectangle().fill(Palette.border).frame(height: 1)
        }
    }

    /// The same hairline on the top edge — for chrome that sits at the bottom of the window.
    func topDivider() -> some View {
        overlay(alignment: .top) {
            Rectangle().fill(Palette.border).frame(height: 1)
        }
    }
}

// MARK: - Controls

/// A compact control on glass.
///
/// Feedback lands on pointer-*down* via `configuration.isPressed`, not on release: the moment a
/// control waits for touch-up to acknowledge you, directness falls off a cliff.
///
/// Tone maps to a glass *tint* rather than to a flat fill, so a Stop button is red glass that still
/// samples what is behind it — the same material as its neighbours, saying something different.
struct PillButton: View {
    enum Tone {
        case plain, accent, dim, danger, active

        var tint: Color? {
            switch self {
            case .plain: return nil
            case .accent, .dim: return Palette.accent
            case .danger: return Palette.statusError
            case .active: return Palette.accent
            }
        }

        /// Prominent tones carry the tint at full strength and put legible text on top of it.
        var isProminent: Bool { self == .accent }
    }

    var title: String
    var systemImage: String?
    var tone: Tone = .plain
    var isDisabled: Bool = false
    var horizontalPadding: CGFloat = 11
    var verticalPadding: CGFloat = 5
    /// What VoiceOver reads. Required in practice for icon-only buttons, which have no text.
    var accessibilityLabel: String?
    var action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: Typography.small, weight: .semibold))
                }
                if !title.isEmpty {
                    Text(title)
                }
            }
            .font(.system(size: Typography.body, weight: tone.isProminent ? .semibold : .medium))
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, verticalPadding)
            .frame(minHeight: 24)
            .contentShape(Rectangle())
        }
        .buttonStyle(
            PillButtonStyle(
                tone: tone,
                reduceMotion: reduceMotion,
                reduceTransparency: reduceTransparency
            )
        )
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.4 : 1)
        .accessibilityLabel(accessibilityLabel ?? title)
    }
}

private struct PillButtonStyle: ButtonStyle {
    var tone: PillButton.Tone
    var reduceMotion: Bool
    var reduceTransparency: Bool

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: Palette.controlRadius, style: .continuous)

        return configuration.label
            .foregroundStyle(foreground)
            .glassSurface(glass, in: shape, reduceTransparency: reduceTransparency)
            // Scale is compositor-only, so the press reads instantly at any frame rate.
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(Motion.snappy(reduceMotion), value: configuration.isPressed)
    }

    private var glass: Glass {
        guard let tint = tone.tint else { return Surface.chrome }
        // A prominent tone owns its colour; the quieter tinted tones only hint at it, so the label
        // stays the thing you read rather than competing with a saturated pill.
        return Surface.tinted(tone.isProminent ? tint : tint.opacity(0.28))
    }

    private var foreground: Color {
        switch tone {
        case .plain: return Palette.textPrimary
        case .accent: return Palette.accentOn
        case .dim, .active: return Palette.accent
        case .danger: return Palette.statusError
        }
    }
}
