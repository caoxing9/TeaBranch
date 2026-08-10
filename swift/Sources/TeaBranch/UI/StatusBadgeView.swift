import SwiftUI

struct StatusBadgeView: View {
    var status: BranchStatus

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(Palette.color(for: status))
                .frame(width: 6, height: 6)
            Text(status.label)
                .font(.system(size: 11))
                .foregroundStyle(Palette.color(for: status))
        }
    }
}

struct CategoryPickerView: View {
    var value: DevCategory
    var onChange: (DevCategory) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(DevCategory.allCases, id: \.self) { category in
                let isSelected = category == value
                let color = Palette.color(for: category)

                Button {
                    onChange(category)
                } label: {
                    Text(category.label)
                        .font(.system(size: 10, weight: isSelected ? .semibold : .regular))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .foregroundStyle(isSelected ? color : Palette.textSecondary)
                        .background(
                            isSelected ? color.opacity(0.2) : .clear,
                            in: RoundedRectangle(cornerRadius: 3, style: .continuous)
                        )
                        .overlay {
                            RoundedRectangle(cornerRadius: 3, style: .continuous)
                                .strokeBorder(isSelected ? color.opacity(0.4) : .clear, lineWidth: 1)
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }
}
