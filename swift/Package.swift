// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TeaBranch",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "TeaBranch",
            path: "Sources/TeaBranch",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
