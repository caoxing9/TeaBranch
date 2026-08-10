import Foundation

/// Where blocking work runs.
///
/// Every service call in this app blocks — `git`, `psql`, `lsof`, `pnpm install`, waiting on
/// ngrok — sometimes for minutes. Swift concurrency's cooperative pool is sized to the core
/// count and is not allowed to block, so this work is dispatched to GCD queues instead of
/// `Task.detached`, and results are handed back to the main actor explicitly.
enum Background {
    /// Short, independent reads: git queries, env file IO, launching an editor.
    static let io = DispatchQueue(
        label: "sh.teabranch.io",
        qos: .userInitiated,
        attributes: .concurrent
    )

    static func run(_ work: @escaping @Sendable () -> Void) {
        io.async(execute: work)
    }
}

/// Hop back to the main actor from a GCD queue.
func onMain(_ body: @escaping @MainActor @Sendable () -> Void) {
    DispatchQueue.main.async { MainActor.assumeIsolated { body() } }
}
