// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SafariTabSleeperMenuBar",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "SafariTabSleeperMenuBar",
            path: "Sources/SafariTabSleeperMenuBar"
        )
    ]
)
