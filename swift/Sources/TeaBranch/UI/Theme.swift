import AppKit
import SwiftUI

/// The design tokens from the web build's `global.css`, as appearance-aware colors.
///
/// Every surface is translucent on purpose: the window is backed by an `NSVisualEffectView`,
/// so opacity — not hue — is what conveys elevation.
enum Palette {
    static let bgPrimary = dynamic(dark: 0x0F0F1A, darkAlpha: 0.82, light: 0xF3F4FA, lightAlpha: 0.82)
    static let bgSecondary = dynamic(dark: 0xFFFFFF, darkAlpha: 0.05, light: 0xFFFFFF, lightAlpha: 0.45)
    static let bgCard = dynamic(dark: 0xFFFFFF, darkAlpha: 0.09, light: 0xFFFFFF, lightAlpha: 0.66)
    static let bgCardHover = dynamic(dark: 0xFFFFFF, darkAlpha: 0.14, light: 0xFFFFFF, lightAlpha: 0.88)

    static let textPrimary = dynamic(dark: 0xECEEF6, light: 0x1A1A2E)
    static let textSecondary = dynamic(dark: 0xA8ACCE, light: 0x6B7084)

    static let accent = dynamic(dark: 0x6EE7B7, light: 0x059669)
    static let accentDim = dynamic(dark: 0x6EE7B7, darkAlpha: 0.16, light: 0x059669, lightAlpha: 0.12)
    static let accentOn = dynamic(dark: 0x0F0F1A, light: 0xFFFFFF)

    static let statusRunning = dynamic(dark: 0x6EE7B7, light: 0x059669)
    static let statusStopped = dynamic(dark: 0x9AA0B4, light: 0x9CA3AF)
    static let statusBuilding = dynamic(dark: 0xFBBF24, light: 0xD97706)
    static let statusError = dynamic(dark: 0xF87171, light: 0xDC2626)
    static let statusErrorDim = dynamic(dark: 0xF87171, darkAlpha: 0.12, light: 0xDC2626, lightAlpha: 0.12)

    static let border = dynamic(dark: 0xFFFFFF, darkAlpha: 0.09, light: 0x000000, lightAlpha: 0.07)
    static let borderStrong = dynamic(dark: 0xFFFFFF, darkAlpha: 0.18, light: 0x000000, lightAlpha: 0.14)
    static let toolbarBg = dynamic(dark: 0x131320, darkAlpha: 0.6, light: 0xF8F9FC, lightAlpha: 0.62)

    static let logBg = dynamic(dark: 0x06060E, darkAlpha: 0.72, light: 0xFCFDFF, lightAlpha: 0.75)
    static let logText = dynamic(dark: 0xC9D1D9, light: 0x24292F)
    static let logTextDim = dynamic(dark: 0x484F58, light: 0xB0B8C1)
    static let logBackend = dynamic(dark: 0xF0883E, light: 0xBF5A15)
    static let logFrontend = dynamic(dark: 0x58A6FF, light: 0x0550AE)
    static let logError = dynamic(dark: 0xF85149, light: 0xCF222E)

    static let searchMatch = dynamic(dark: 0xFBBF24, darkAlpha: 0.32, light: 0xD97706, lightAlpha: 0.28)
    static let searchMatchActive = dynamic(dark: 0xFBBF24, darkAlpha: 0.9, light: 0xD97706, lightAlpha: 0.9)
    static let searchMatchActiveText = dynamic(dark: 0x1A1A1A, light: 0xFFFFFF)

    static let cornerRadius: CGFloat = 14

    static func color(for status: BranchStatus) -> Color {
        switch status {
        case .running: return statusRunning
        case .stopped: return statusStopped
        case .building: return statusBuilding
        case .error: return statusError
        }
    }

    static func color(for category: DevCategory) -> Color {
        switch category {
        case .developing: return dynamic(dark: 0xFFC107, light: 0xB45309)
        case .todo: return dynamic(dark: 0x8892B0, light: 0x6B7084)
        case .done: return dynamic(dark: 0x64FFDA, light: 0x059669)
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

/// Which appearance the user picked in the title bar.
enum ThemePreference: String, CaseIterable {
    case dark, light, system

    var next: ThemePreference {
        switch self {
        case .dark: return .light
        case .light: return .system
        case .system: return .dark
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

// MARK: - Shared view chrome

extension View {
    /// Hairline separator matching the web build's 1px borders.
    func topDivider() -> some View {
        overlay(alignment: .top) {
            Rectangle().fill(Palette.border).frame(height: 1)
        }
    }

    func bottomDivider() -> some View {
        overlay(alignment: .bottom) {
            Rectangle().fill(Palette.border).frame(height: 1)
        }
    }
}

/// A compact pill button — the shape used throughout the title bar, cards and log toolbar.
struct PillButton: View {
    enum Tone {
        case plain, accent, dim, danger, active
    }

    var title: String
    var systemImage: String?
    var tone: Tone = .plain
    var isDisabled: Bool = false
    var horizontalPadding: CGFloat = 8
    var verticalPadding: CGFloat = 3
    var action: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if let systemImage {
                    Image(systemName: systemImage).font(.system(size: 10, weight: .medium))
                }
                if !title.isEmpty {
                    Text(title)
                }
            }
            .font(.system(size: 11, weight: tone == .accent ? .semibold : .regular))
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, verticalPadding)
            .frame(minHeight: 20)
            .foregroundStyle(foreground)
            .background(background, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(tone == .plain ? Palette.border : .clear, lineWidth: 1)
            }
            .brightness(isHovering && !isDisabled ? 0.06 : 0)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.45 : 1)
        .onHover { isHovering = $0 }
    }

    private var foreground: Color {
        switch tone {
        case .plain, .active: return Palette.textSecondary
        case .accent: return Palette.accentOn
        case .dim: return Palette.accent
        case .danger: return Palette.statusError
        }
    }

    private var background: Color {
        switch tone {
        case .plain: return Palette.bgCard
        case .accent: return Palette.accent
        case .dim: return Palette.accentDim
        case .danger: return Palette.statusErrorDim
        case .active: return Palette.borderStrong
        }
    }
}
