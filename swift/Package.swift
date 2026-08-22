// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "TeaBranch",
    // macOS 26 is the floor on purpose. The interface is built on Liquid Glass — `glassEffect`,
    // `GlassEffectContainer`, `.buttonStyle(.glass)` — which have no back-deployment story, and
    // hand-rolling their look out of opacity ramps is what the old palette was doing badly.
    platforms: [.macOS(.v26)],
    targets: [
        .executableTarget(
            name: "TeaBranch",
            path: "Sources/TeaBranch",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
