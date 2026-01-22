// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "vz-helper",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "vz-helper", targets: ["vz-helper"])
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-argument-parser", from: "1.2.0")
    ],
    targets: [
        .executableTarget(
            name: "vz-helper",
            dependencies: [
                .product(name: "ArgumentParser", package: "swift-argument-parser")
            ],
            path: "Sources"
        )
    ]
)
