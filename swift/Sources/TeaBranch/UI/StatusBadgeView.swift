import SwiftUI

/// The status indicator on its own — a filled dot, sized like a system list marker.
///
/// `building` breathes so that "working on it" is legible at a glance without a spinner competing
/// with the row's text. The cycle is deliberately ~1.4s: a slower loop lands near the 0.2 Hz
/// flicker band that reads as distracting, and it stops entirely under reduced motion.
struct StatusDotView: View {
    var status: BranchStatus

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isPulsing = false

    private var isBuilding: Bool { status == .building }

    var body: some View {
        Circle()
            .fill(Palette.color(for: status))
            .frame(width: 7, height: 7)
            .overlay {
                if status == .running {
                    Circle().strokeBorder(Palette.statusRunning.opacity(0.25), lineWidth: 3)
                }
            }
            .opacity(isBuilding && isPulsing ? 0.35 : 1)
            .animation(
                isBuilding && !reduceMotion
                    ? .easeInOut(duration: 0.7).repeatForever(autoreverses: true)
                    : .default,
                value: isPulsing
            )
            .onAppear { isPulsing = isBuilding }
            .onChange(of: status) { _, new in isPulsing = (new == .building) }
            .accessibilityHidden(true)
    }
}

struct StatusBadgeView: View {
    var status: BranchStatus

    var body: some View {
        HStack(spacing: 5) {
            StatusDotView(status: status)
            Text(status.label)
                .font(.system(size: Typography.body, weight: .medium))
                .foregroundStyle(
                    status == .stopped ? Palette.textSecondary : Palette.color(for: status)
                )
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(status.label)
    }
}

/// Lane assignment. A segmented control, because the three options are mutually exclusive, always
/// worth showing, and map directly onto the board's three columns.
struct CategoryPickerView: View {
    var value: DevCategory
    var onChange: (DevCategory) -> Void

    var body: some View {
        Picker("Category", selection: Binding(get: { value }, set: onChange)) {
            ForEach(DevCategory.allCases, id: \.self) { category in
                Text(category.label).tag(category)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .controlSize(.small)
        .fixedSize()
    }
}
