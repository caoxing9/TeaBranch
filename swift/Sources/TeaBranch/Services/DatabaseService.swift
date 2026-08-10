import Foundation

/// Postgres provisioning via the `psql` CLI (same approach the Rust backend took — no driver
/// dependency, and it picks up whatever local server the user's env file points at).
enum DatabaseService {
    /// Connect to the `postgres` maintenance database of the same server.
    private static func adminURL(from url: String) -> String {
        let admin = DatabaseURL.replacingName(url, with: "postgres")
        return admin.split(separator: "?").first.map(String.init) ?? admin
    }

    private static func exists(_ name: String, adminURL: String) -> Bool {
        let result = Shell.run("psql", [
            adminURL, "-tAc", "SELECT 1 FROM pg_database WHERE datname = '\(name)'",
        ])
        return result.trimmedOut == "1"
    }

    /// Create `name` from `template` if it isn't there yet, and return the URL pointing at it.
    ///
    /// A template that's currently connected to can't be copied, so we degrade to an empty
    /// database rather than failing the whole worktree creation.
    @discardableResult
    static func create(name: String, from template: String, baseURL: String) throws -> String {
        let admin = adminURL(from: baseURL)

        if exists(name, adminURL: admin) {
            Log.info("Database '\(name)' already exists")
            return DatabaseURL.replacingName(baseURL, with: name)
        }

        Log.info("Creating database '\(name)' from template '\(template)'")
        let created = Shell.run("psql", [
            admin, "-c", "CREATE DATABASE \"\(name)\" TEMPLATE \"\(template)\"",
        ])

        if !created.ok {
            if created.stderr.contains("being accessed by other users") {
                Log.info("Template db '\(template)' in use, creating empty database '\(name)'")
                let empty = Shell.run("psql", [admin, "-c", "CREATE DATABASE \"\(name)\""])
                guard empty.ok else {
                    throw TeaBranchError("Failed to create database: \(empty.stderr)")
                }
            } else {
                throw TeaBranchError("Failed to create database: \(created.stderr)")
            }
        }

        return DatabaseURL.replacingName(baseURL, with: name)
    }

    /// Make sure the database a URL points at exists, creating it empty if not.
    @discardableResult
    static func ensureExists(url: String) throws -> String {
        guard let name = DatabaseURL.name(of: url) else {
            throw TeaBranchError("Cannot extract database name from URL")
        }
        let admin = adminURL(from: url)
        guard !exists(name, adminURL: admin) else { return url }

        Log.info("Database '\(name)' does not exist, creating empty")
        let created = Shell.run("psql", [admin, "-c", "CREATE DATABASE \"\(name)\""])
        guard created.ok else {
            throw TeaBranchError("Failed to create database '\(name)': \(created.stderr)")
        }
        return url
    }
}
