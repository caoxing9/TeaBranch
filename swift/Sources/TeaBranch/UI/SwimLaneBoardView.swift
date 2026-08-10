import SwiftUI

/// Kanban view of the branches. Lanes are an `HSplitView`, so the divider drag that the web
/// build implemented by hand comes for free — and drag-and-drop between lanes is the system's.
struct SwimLaneBoardView: View {
    @Environment(AppModel.self) private var model

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
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    private func laneView(_ lane: DevCategory) -> some View {
        let color = Palette.color(for: lane)
        let branches = model.visibleBranches.filter { model.category(for: $0.name) == lane }
        let isTargeted = dropTarget == lane

        return VStack(spacing: 0) {
            HStack {
                HStack(spacing: 6) {
                    Circle().fill(color).frame(width: 8, height: 8)
                    Text(lane.label).font(.system(size: 12, weight: .semibold))
                }
                Spacer()
                Text("\(branches.count)")
                    .font(.system(size: 10))
                    .foregroundStyle(Palette.textSecondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Palette.bgCard, in: Capsule())
                    .overlay { Capsule().strokeBorder(Palette.border, lineWidth: 1) }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .overlay(alignment: .bottom) {
                Rectangle().fill(color.opacity(0.2)).frame(height: 2)
            }

            ScrollView {
                LazyVStack(spacing: 4) {
                    if branches.isEmpty {
                        Text(isTargeted ? "Release to move here" : "No branches")
                            .font(.system(size: 11))
                            .foregroundStyle(isTargeted ? color : Palette.textSecondary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 24)
                    } else {
                        ForEach(branches) { branch in
                            BranchCardView(branch: branch, compact: true)
                                .draggable(branch.name)
                        }
                    }
                }
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .top)
            }
        }
        .background(
            isTargeted ? Palette.bgCardHover : Palette.bgSecondary,
            in: RoundedRectangle(cornerRadius: Palette.cornerRadius, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: Palette.cornerRadius, style: .continuous)
                .strokeBorder(
                    isTargeted ? color : Palette.border,
                    style: StrokeStyle(lineWidth: isTargeted ? 2 : 1, dash: isTargeted ? [4, 3] : [])
                )
        }
        .dropDestination(for: String.self) { items, _ in
            guard let name = items.first else { return false }
            model.setCategory(lane, for: name)
            return true
        } isTargeted: { targeted in
            dropTarget = targeted ? lane : (dropTarget == lane ? nil : dropTarget)
        }
    }
}
