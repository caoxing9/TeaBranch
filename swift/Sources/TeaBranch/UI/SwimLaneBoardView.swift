import SwiftUI

/// Kanban view of the branches. Lanes are an `HSplitView`, so the divider drag that the web
/// build implemented by hand comes for free — and drag-and-drop between lanes is the system's.
struct SwimLaneBoardView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var dropTarget: DevCategory?

    private var lanes: [DevCategory] {
        DevCategory.allCases.filter { model.categoryFilter == nil || model.categoryFilter == $0 }
    }

    var body: some View {
        HSplitView {
            ForEach(lanes, id: \.self) { lane in
                laneView(lane)
                    .frame(minWidth: 170)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
    }

    private func laneView(_ lane: DevCategory) -> some View {
        let color = Palette.color(for: lane)
        let branches = model.visibleBranches.filter { model.category(for: $0.name) == lane }
        let isTargeted = dropTarget == lane
        let shape = RoundedRectangle(cornerRadius: Palette.cornerRadius, style: .continuous)

        return VStack(spacing: 0) {
            laneHeader(lane, color: color, count: branches.count)

            ScrollView {
                LazyVStack(spacing: 2) {
                    if branches.isEmpty {
                        Text(isTargeted ? "Release to move here" : "Empty")
                            .font(.system(size: 11))
                            .foregroundStyle(isTargeted ? color : Palette.textTertiary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 24)
                    } else {
                        ForEach(branches) { branch in
                            BranchCardView(branch: branch, compact: true)
                                .draggable(branch.name)
                        }
                    }
                }
                .padding(4)
                .frame(maxWidth: .infinity, alignment: .top)
            }
        }
        // A single fill over the window's one material — not a second sheet of translucency.
        .background { shape.fill(isTargeted ? color.opacity(0.12) : Palette.fillSubtle) }
        .overlay {
            shape.strokeBorder(
                isTargeted ? color : Palette.border,
                style: StrokeStyle(lineWidth: isTargeted ? 2 : 1, dash: isTargeted ? [4, 3] : [])
            )
        }
        // The lane leans toward the pointer as it becomes the target, so the drop lands where the
        // motion already said it would.
        .scaleEffect(isTargeted && !reduceMotion ? 1.012 : 1)
        .animation(Motion.momentum(reduceMotion), value: isTargeted)
        .dropDestination(for: String.self) { items, _ in
            guard let name = items.first else { return false }
            model.setCategory(lane, for: name)
            return true
        } isTargeted: { targeted in
            dropTarget = targeted ? lane : (dropTarget == lane ? nil : dropTarget)
        }
    }

    private func laneHeader(_ lane: DevCategory, color: Color, count: Int) -> some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(lane.label)
                .font(.system(size: 11, weight: .semibold))
            Spacer()
            Text("\(count)")
                .font(.system(size: 10, weight: .medium))
                // Monospaced digits so the count doesn't nudge the header as branches move lanes.
                .monospacedDigit()
                .foregroundStyle(Palette.textSecondary)
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(Palette.fillHover, in: Capsule())
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .overlay(alignment: .bottom) {
            Rectangle().fill(color.opacity(0.25)).frame(height: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(lane.label), \(count) branches")
    }
}
