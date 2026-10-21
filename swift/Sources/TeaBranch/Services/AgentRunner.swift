import Darwin
import Foundation

/// Headless coding-agent runs: Claude Code in `-p` mode with `stream-json` output, and Codex in
/// `exec` mode. Output is turned into `ConversationEntry` lines as it arrives.
enum AgentRunner {
    struct Outcome: Sendable {
        var exit: Spawn.ExitReason
        /// Claude's final `result` text, or what Codex wrote to `--output-last-message`.
        var finalText: String
        var costUSD: Double
        var isError: Bool
        /// Why a run produced nothing, when the output made that recognisable.
        var diagnosis: String? = nil
    }

    /// A run in flight. `cancel()` takes the whole process group down.
    final class Handle: @unchecked Sendable {
        let pid: pid_t
        private(set) var cancelled = false
        init(pid: pid_t) { self.pid = pid }
        func cancel() {
            cancelled = true
            Spawn.killGroup(pid, graceSeconds: 1)
        }
    }

    enum Session {
        case new(String)
        case resume(String)
    }

    // MARK: - Claude Code

    /// Run Claude Code once in `cwd`. Returns immediately; `onExit` fires when it finishes.
    static func claude(
        prompt: String,
        cwd: String,
        session: Session,
        model: AgentModel,
        baseCommand: String,
        appendSystemPrompt: String? = nil,
        extraArguments: [String] = [],
        channel: ConversationEntry.Channel,
        onEntry: @escaping @Sendable (ConversationEntry) -> Void,
        onExit: @escaping @Sendable (Outcome) -> Void
    ) throws -> Handle {
        var arguments = ["-p", prompt, "--output-format", "stream-json", "--verbose"]
        switch session {
        case .new(let id): arguments += ["--session-id", id]
        case .resume(let id): arguments += ["--resume", id]
        }
        if let name = model.model, !name.isEmpty { arguments += ["--model", name] }
        if let appendSystemPrompt { arguments += ["--append-system-prompt", appendSystemPrompt] }
        arguments += extraArguments

        let command = commandLine(base: baseCommand, arguments: arguments)
        let child = try Spawn.shell(command: command, cwd: cwd, extraEnv: environment(for: model))
        let handle = Handle(pid: child.pid)

        let state = StreamState()
        child.standardOutput.streamLines { line in
            for entry in state.consume(line, channel: channel) { onEntry(entry) }
        }
        child.standardError.streamLines { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { return }
            onEntry(ConversationEntry(kind: .system, channel: channel, text: trimmed, isError: true))
        }
        Spawn.reap(pid: child.pid) { reason in
            // Give the reader threads a moment to drain the last lines after exit.
            Thread.sleep(forTimeInterval: 0.3)
            let snapshot = state.snapshot()
            onExit(Outcome(
                exit: handle.cancelled ? .signal(SIGTERM) : reason,
                finalText: snapshot.result,
                costUSD: snapshot.cost,
                isError: snapshot.isError || !reason.isClean
            ))
        }
        return handle
    }

    /// The env that points Claude Code at a gateway instead of its own login.
    static func environment(for model: AgentModel) -> [String: String] {
        guard model.provider == .magpie else { return [:] }
        let settings = SettingsStore.loadTeableConfig()
        let key = Keychain.read(Keychain.magpieKey) ?? "magpie"
        var env = [
            "ANTHROPIC_BASE_URL": settings.magpieURL,
            "ANTHROPIC_AUTH_TOKEN": key,
            "ANTHROPIC_API_KEY": key,
        ]
        if let name = model.model, !name.isEmpty {
            env["ANTHROPIC_MODEL"] = name
            // Background work (titles, summaries) must not fall back to a Claude model the
            // gateway may not route.
            env["ANTHROPIC_SMALL_FAST_MODEL"] = name
            env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = name
        }
        return env
    }

    /// `base` comes from settings (`claude --dangerously-skip-permissions`); everything we add is
    /// quoted, because the prompt is arbitrary text from a table anyone on the team can edit.
    static func commandLine(base: String, arguments: [String]) -> String {
        ([base] + arguments.map(\.shellQuoted)).joined(separator: " ")
    }

    // MARK: - Codex

    /// `codex exec` in a read-only sandbox: it can read the repo and run git, but not edit.
    static func codexReview(
        prompt: String,
        cwd: String,
        model: String,
        onEntry: @escaping @Sendable (ConversationEntry) -> Void,
        onExit: @escaping @Sendable (Outcome) -> Void
    ) throws -> Handle {
        let output = FileManager.default.temporaryDirectory
            .appendingPathComponent("teabranch-review-\(UUID().uuidString).md")
        var arguments = [
            "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral",
            "--output-last-message", output.path,
        ]
        if !model.isEmpty { arguments += ["--model", model] }
        arguments.append(prompt)

        let command = commandLine(base: "codex", arguments: arguments)
        let child = try Spawn.shell(command: command, cwd: cwd)
        let handle = Handle(pid: child.pid)

        // Codex prints progress on stderr and the final message on stdout; both are worth seeing —
        // except an HTML error page from a dead gateway or proxy, which is a hundred lines of CSS.
        let filter = CodexOutputFilter()
        let emit: @Sendable (String) -> Void = { line in
            guard let shown = filter.consume(line) else { return }
            onEntry(ConversationEntry(kind: .system, channel: .review, text: truncate(shown, 600), isError: filter.isHTMLNotice(shown)))
        }
        child.standardOutput.streamLines(emit)
        child.standardError.streamLines(emit)

        Spawn.reap(pid: child.pid) { reason in
            Thread.sleep(forTimeInterval: 0.3)
            let text = (try? String(contentsOf: output, encoding: .utf8)) ?? ""
            try? FileManager.default.removeItem(at: output)
            onExit(Outcome(
                exit: handle.cancelled ? .signal(SIGTERM) : reason,
                finalText: text.trimmingCharacters(in: .whitespacesAndNewlines),
                costUSD: 0,
                isError: !reason.isClean || text.isEmpty,
                diagnosis: filter.connectionFailed
                    ? "Codex 连不上模型服务 — 检查 ~/.codex/config.toml 指向的服务（如 Magpie）是否在运行"
                    : nil
            ))
        }
        return handle
    }

    /// Collapses HTML error pages in Codex output and notices connection failures.
    private final class CodexOutputFilter: @unchecked Sendable {
        private let lock = NSLock()
        private var inHTML = false
        private(set) var connectionFailed = false
        private static let notice = "（模型服务返回了一个 HTML 错误页，已省略）"
        private static let connectionPattern =
            #"Unable to connect|Connection refused|ECONNREFUSED|error sending request|stream disconnected|failed to connect"#

        func isHTMLNotice(_ line: String) -> Bool { line == Self.notice }

        /// The line to show, or nil to drop it.
        func consume(_ line: String) -> String? {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { return nil }
            lock.lock(); defer { lock.unlock() }
            if trimmed.range(of: Self.connectionPattern, options: [.regularExpression, .caseInsensitive]) != nil {
                connectionFailed = true
            }
            let lower = trimmed.lowercased()
            if inHTML {
                if lower.contains("</html>") { inHTML = false }
                return nil
            }
            if lower.hasPrefix("<!doctype html") || lower.hasPrefix("<html") {
                inHTML = !lower.contains("</html>")
                return Self.notice
            }
            return trimmed
        }
    }

    // MARK: - Models

    /// Model ids the Magpie gateway routes, from its OpenAI-style `/v1/models`.
    static func magpieModels(baseURL: String) throws -> [String] {
        guard let url = URL(string: baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")) + "/v1/models") else {
            throw TeaBranchError("Invalid Magpie URL")
        }
        var request = URLRequest(url: url, timeoutInterval: 5)
        if let key = Keychain.read(Keychain.magpieKey) {
            request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try HTTP.send(request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = object["data"] as? [[String: Any]]
        else {
            throw TeaBranchError("Magpie at \(baseURL) did not return a model list — is it running?")
        }
        return list.compactMap { $0["id"] as? String }.sorted()
    }

    // MARK: - stream-json

    static func truncate(_ text: String, _ limit: Int) -> String {
        text.count > limit ? String(text.prefix(limit)) + "…" : text
    }

    /// Accumulates what the final `result` event carries, across reader threads.
    private final class StreamState: @unchecked Sendable {
        private let lock = NSLock()
        private var result = ""
        private var cost = 0.0
        private var isError = false

        func snapshot() -> (result: String, cost: Double, isError: Bool) {
            lock.lock(); defer { lock.unlock() }
            return (result, cost, isError)
        }

        func consume(_ line: String, channel: ConversationEntry.Channel) -> [ConversationEntry] {
            guard let data = line.data(using: .utf8),
                  let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = event["type"] as? String
            else {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                return trimmed.isEmpty ? [] : [ConversationEntry(kind: .system, channel: channel, text: trimmed)]
            }

            switch type {
            case "system":
                guard event["subtype"] as? String == "init" else { return [] }
                let model = event["model"] as? String ?? "?"
                return [ConversationEntry(kind: .system, channel: channel, text: "会话已连接 · \(model)")]

            case "assistant":
                let content = (event["message"] as? [String: Any])?["content"] as? [[String: Any]] ?? []
                return content.compactMap { block in
                    switch block["type"] as? String {
                    case "text":
                        let text = (block["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                        return text.isEmpty ? nil : ConversationEntry(kind: .assistant, channel: channel, text: text)
                    case "tool_use":
                        let name = block["name"] as? String ?? "tool"
                        let input = block["input"] as? [String: Any] ?? [:]
                        return ConversationEntry(kind: .tool, channel: channel, text: "\(name)  \(Self.summarize(input))")
                    default:
                        return nil
                    }
                }

            case "user":
                let content = (event["message"] as? [String: Any])?["content"] as? [[String: Any]] ?? []
                return content.compactMap { block in
                    guard block["type"] as? String == "tool_result" else { return nil }
                    let text = Self.flatten(block["content"])
                    let failed = block["is_error"] as? Bool ?? false
                    guard failed || !text.isEmpty else { return nil }
                    return ConversationEntry(
                        kind: .toolResult,
                        channel: channel,
                        text: truncate(text, 1200),
                        isError: failed
                    )
                }

            case "result":
                let text = event["result"] as? String ?? ""
                let cost = event["total_cost_usd"] as? Double ?? 0
                let failed = event["is_error"] as? Bool ?? false
                lock.lock()
                result = text
                self.cost = cost
                isError = failed
                lock.unlock()
                let turns = event["num_turns"] as? Int ?? 0
                let seconds = (event["duration_ms"] as? Double ?? 0) / 1000
                let summary = String(format: "完成 · %d 轮 · %.0fs · $%.2f", turns, seconds, cost)
                return [ConversationEntry(kind: .result, channel: channel, text: summary, isError: failed)]

            default:
                return []
            }
        }

        /// One line describing a tool call — the path or command, not the whole input blob.
        private static func summarize(_ input: [String: Any]) -> String {
            for key in ["command", "file_path", "path", "pattern", "url", "description", "prompt"] {
                if let value = input[key] as? String { return truncate(value, 240) }
            }
            guard let data = try? JSONSerialization.data(withJSONObject: input),
                  let text = String(data: data, encoding: .utf8) else { return "" }
            return truncate(text, 240)
        }

        private static func flatten(_ content: Any?) -> String {
            if let text = content as? String { return text }
            if let blocks = content as? [[String: Any]] {
                return blocks.compactMap { $0["text"] as? String }.joined(separator: "\n")
            }
            return ""
        }
    }
}
