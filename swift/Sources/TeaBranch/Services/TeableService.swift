import Foundation

/// The Teable REST API, authenticated with a personal access token.
///
/// Blocking like every other service here — callers are already on `Background` queues, and a
/// synchronous call keeps the pipeline code a straight line instead of a ladder of callbacks.
enum TeableService {
    /// Where the user mints a token. Scopes needed: table/field/record read, record update.
    static func tokenPageURL(baseURL: String) -> URL? {
        URL(string: "\(baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")))/setting/personal-access-token")
    }

    static func me(config: TeableConfig, token: String) throws -> TeableUser {
        let json = try request("GET", "/api/auth/user/me", config: config, token: token)
        guard let object = json as? [String: Any], let id = object["id"] as? String else {
            throw TeaBranchError("Teable returned an unexpected user payload")
        }
        return TeableUser(
            id: id,
            name: object["name"] as? String ?? id,
            email: object["email"] as? String
        )
    }

    static func fields(config: TeableConfig, token: String) throws -> [TeableField] {
        var query = [URLQueryItem]()
        if let viewId = config.viewId { query.append(URLQueryItem(name: "viewId", value: viewId)) }
        let json = try request("GET", "/api/table/\(config.tableId)/field", query: query, config: config, token: token)
        guard let list = json as? [[String: Any]] else {
            throw TeaBranchError("Teable returned an unexpected field list")
        }
        return list.compactMap { object in
            guard let id = object["id"] as? String, let name = object["name"] as? String else { return nil }
            let options = object["options"] as? [String: Any]
            let choices = (options?["choices"] as? [[String: Any]])?.compactMap { $0["name"] as? String } ?? []
            return TeableField(
                id: id,
                name: name,
                type: object["type"] as? String ?? "",
                isPrimary: object["isPrimary"] as? Bool ?? false,
                choices: choices,
                isMultiple: options?["isMultiple"] as? Bool ?? false
            )
        }
    }

    /// A filter matching records whose `field` contains the token's own user. `Me` is resolved by
    /// the server, so this works without knowing who the token belongs to.
    static func mineFilter(_ field: TeableField) -> [String: Any] {
        let item: [String: Any] = field.isMultiple
            ? ["fieldId": field.id, "operator": "hasAnyOf", "value": ["Me"]]
            : ["fieldId": field.id, "operator": "is", "value": "Me"]
        return ["conjunction": "and", "filterSet": [item]]
    }

    /// Every record in the view, in view order, cells rendered as text. `filter` narrows the view's
    /// own filter further.
    static func records(config: TeableConfig, token: String, filter: [String: Any]? = nil) throws -> [TeableRecord] {
        let filterJSON = try filter.map { String(decoding: try JSONSerialization.data(withJSONObject: $0), as: UTF8.self) }
        // Personal access tokens are capped at 100 records per request.
        let pageSize = 100
        var all: [TeableRecord] = []
        while true {
            var query = [
                URLQueryItem(name: "fieldKeyType", value: "name"),
                URLQueryItem(name: "cellFormat", value: "text"),
                URLQueryItem(name: "take", value: String(pageSize)),
                URLQueryItem(name: "skip", value: String(all.count)),
            ]
            if let viewId = config.viewId { query.append(URLQueryItem(name: "viewId", value: viewId)) }
            if let filterJSON { query.append(URLQueryItem(name: "filter", value: filterJSON)) }
            let json = try request("GET", "/api/table/\(config.tableId)/record", query: query, config: config, token: token)
            guard let records = (json as? [String: Any])?["records"] as? [[String: Any]] else {
                throw TeaBranchError("Teable returned an unexpected record list")
            }
            all += records.compactMap(parseRecord)
            // A hard ceiling so a misbehaving cursor can't spin forever.
            if records.count < pageSize || all.count >= 10_000 { break }
        }
        return all
    }

    /// Write cells by field name. `typecast` lets a plain string land in a select or URL field.
    static func update(recordId: String, fields: [String: Any], config: TeableConfig, token: String) throws {
        let body: [String: Any] = [
            "fieldKeyType": "name",
            "typecast": true,
            "record": ["fields": fields],
        ]
        _ = try request(
            "PATCH",
            "/api/table/\(config.tableId)/record/\(recordId)",
            body: body,
            config: config,
            token: token
        )
    }

    // MARK: - Internals

    private static func parseRecord(_ object: [String: Any]) -> TeableRecord? {
        guard let id = object["id"] as? String else { return nil }
        var fields: [String: String] = [:]
        for (name, value) in object["fields"] as? [String: Any] ?? [:] {
            fields[name] = render(value)
        }
        return TeableRecord(id: id, autoNumber: object["autoNumber"] as? Int, fields: fields)
    }

    /// `cellFormat=text` already gives strings; this only covers servers that ignore it.
    private static func render(_ value: Any) -> String {
        switch value {
        case let string as String: return string
        case let number as NSNumber: return number.stringValue
        case let list as [Any]: return list.map(render).joined(separator: ", ")
        case let object as [String: Any]:
            return (object["title"] ?? object["name"] ?? object["id"]).map(render) ?? ""
        default: return String(describing: value)
        }
    }

    private static func request(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = [],
        body: [String: Any]? = nil,
        config: TeableConfig,
        token: String
    ) throws -> Any {
        guard var components = URLComponents(string: config.apiBase + path) else {
            throw TeaBranchError("Invalid Teable URL: \(config.apiBase)")
        }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw TeaBranchError("Invalid Teable URL: \(path)") }

        var request = URLRequest(url: url, timeoutInterval: 30)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let (data, response) = try HTTP.send(request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let detail = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String
                ?? String(decoding: data.prefix(300), as: UTF8.self)
            if status == 401 || status == 403 {
                throw TeaBranchError("Teable rejected the token (\(status)): \(detail)")
            }
            throw TeaBranchError("Teable \(method) \(path) failed (\(status)): \(detail)")
        }
        return data.isEmpty ? [:] : try JSONSerialization.jsonObject(with: data)
    }
}

/// A synchronous `URLSession` round trip for code already running on a background queue.
enum HTTP {
    static func send(_ request: URLRequest) throws -> (Data, URLResponse) {
        final class Box: @unchecked Sendable {
            var result: Result<(Data, URLResponse), Error> = .failure(TeaBranchError("No response"))
        }
        let box = Box()
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error {
                box.result = .failure(error)
            } else if let data, let response {
                box.result = .success((data, response))
            }
            done.signal()
        }.resume()
        done.wait()
        return try box.result.get()
    }
}
