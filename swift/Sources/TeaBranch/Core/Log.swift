import Foundation

/// Diagnostic logging to stderr, mirroring the `[TeaBranch] …` lines the Rust backend printed.
/// Visible with `Console.app`, or by launching the bundle from a terminal.
enum Log {
    static func info(_ message: @autoclosure () -> String) {
        write("[TeaBranch] \(message())")
    }

    static func warn(_ message: @autoclosure () -> String) {
        write("[TeaBranch] warning: \(message())")
    }

    private static let lock = NSLock()

    private static func write(_ line: String) {
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardError.write(Data((line + "\n").utf8))
    }
}
