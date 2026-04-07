use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter, Manager};

use crate::shell;
use crate::state::{SharedState, Status};

extern crate libc;

/// A command to start, with its label and whether it's the preview target
struct StartCommand {
    label: String,
    command: String,
    /// The port this process listens on (for preview)
    port: u16,
    /// Extra env vars to set
    env_vars: Vec<(String, String)>,
}

/// Strip leading env var assignments from a shell script line
/// e.g. "SERVER_PORT=3003 SOCKET_PORT=3003 pnpm -r dev" -> "pnpm -r dev"
fn strip_env_prefix(script: &str) -> String {
    let mut result_parts = Vec::new();
    let mut found_cmd = false;

    for part in script.split_whitespace() {
        if !found_cmd && part.contains('=') {
            // Skip env var assignments like VAR=value
            continue;
        } else {
            found_cmd = true;
            result_parts.push(part);
        }
    }

    result_parts.join(" ")
}

/// Detect start commands from package.json, with proper port allocation.
fn detect_start_commands(worktree_path: &Path, backend_port: u16, socket_port: u16, frontend_port: u16) -> Vec<StartCommand> {
    let pkg_path = worktree_path.join("package.json");
    if let Ok(content) = std::fs::read_to_string(&pkg_path) {
        if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(scripts) = pkg.get("scripts").and_then(|s| s.as_object()) {
                let pm = detect_package_manager(worktree_path);

                // Check for separate backend/frontend scripts
                let has_backend = scripts.contains_key("dev:backend:swc");
                let has_frontend = scripts.contains_key("dev:frontend");

                if has_backend && has_frontend {
                    let backend_script = scripts["dev:backend:swc"].as_str().unwrap_or("");
                    let frontend_script = scripts["dev:frontend"].as_str().unwrap_or("");

                    let backend_cmd = strip_env_prefix(backend_script);
                    let frontend_cmd = strip_env_prefix(frontend_script);

                    // Always set port env vars as process environment variables,
                    // because tools like Next.js determine the dev server port from
                    // process env BEFORE loading .env files.
                    let backend_env = vec![
                        ("SERVER_PORT".to_string(), backend_port.to_string()),
                        ("SOCKET_PORT".to_string(), socket_port.to_string()),
                    ];

                    let frontend_env = vec![
                        ("SERVER_PORT".to_string(), backend_port.to_string()),
                        ("SOCKET_PORT".to_string(), socket_port.to_string()),
                        ("PORT".to_string(), frontend_port.to_string()),
                    ];

                    return vec![
                        StartCommand {
                            label: "backend".to_string(),
                            command: backend_cmd,
                            port: backend_port,
                            env_vars: backend_env,
                        },
                        StartCommand {
                            label: "frontend".to_string(),
                            command: frontend_cmd,
                            port: frontend_port,
                            env_vars: frontend_env,
                        },
                    ];
                }

                // Fallback: single dev or start script
                let script_name = if scripts.contains_key("dev") { "dev" }
                    else if scripts.contains_key("start") { "start" }
                    else { "dev" };

                return vec![StartCommand {
                    label: "dev".to_string(),
                    command: format!("{} run {}", pm, script_name),
                    port: frontend_port,
                    env_vars: vec![("PORT".to_string(), frontend_port.to_string())],
                }];
            }
        }
    }

    vec![StartCommand {
        label: "dev".to_string(),
        command: "npm run dev".to_string(),
        port: frontend_port,
        env_vars: vec![("PORT".to_string(), frontend_port.to_string())],
    }]
}

/// Detect package manager from lockfile
fn detect_package_manager(path: &Path) -> &'static str {
    if path.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if path.join("yarn.lock").exists() {
        "yarn"
    } else if path.join("bun.lock").exists() || path.join("bun.lockb").exists() {
        "bun"
    } else {
        "npm"
    }
}

/// Check if node_modules exists, if not install dependencies
fn ensure_dependencies(worktree_path: &Path) -> Result<(), String> {
    if worktree_path.join("node_modules").exists() {
        return Ok(());
    }

    let pm = detect_package_manager(worktree_path);
    let install_cmd = format!("{} install", pm);

    let output = shell::shell_command(&install_cmd)
        .current_dir(worktree_path)
        .output()
        .map_err(|e| format!("Failed to install deps: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Dependency install failed: {}", stderr));
    }

    Ok(())
}

/// Spawn a single process and wire up logging + exit monitoring
fn spawn_process(
    app: &AppHandle,
    state: &tauri::State<'_, SharedState>,
    branch_name: &str,
    cmd: &StartCommand,
    worktree_path: &Path,
) -> Result<u32, String> {
    eprintln!("[BranchPilot] spawn: branch={}, label={}, cmd='{}', dir={}, port={}",
        branch_name, cmd.label, cmd.command, worktree_path.display(), cmd.port);

    let mut command = shell::shell_command(&cmd.command);
    command.current_dir(worktree_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Set env vars
    for (key, val) in &cmd.env_vars {
        command.env(key, val);
    }

    let mut child = unsafe {
        command
            .pre_exec(|| {
                libc::setpgid(0, 0);
                Ok(())
            })
            .spawn()
            .map_err(|e| format!("Failed to start {}: {}", cmd.label, e))?
    };

    let pid = child.id();

    // Stream stdout
    let log_prefix = format!("[{}] ", cmd.label);
    let branch_name_s = branch_name.to_string();
    let app_clone = app.clone();
    let prefix = log_prefix.clone();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let formatted = format!("{}{}", prefix, line);
                    // Store in state for persistence
                    if let Some(state) = app_clone.try_state::<SharedState>() {
                        let mut s = state.lock().unwrap();
                        let buf = s.logs.entry(branch_name_s.clone()).or_insert_with(|| std::collections::VecDeque::with_capacity(2000));
                        if buf.len() >= 2000 {
                            buf.pop_front();
                        }
                        buf.push_back(formatted.clone());
                    }
                    let _ = app_clone.emit(
                        &format!("branch-log:{}", branch_name_s),
                        formatted,
                    );
                }
            }
        });
    }

    // Stream stderr
    let branch_name_s = branch_name.to_string();
    let app_clone = app.clone();
    let prefix = log_prefix;
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let formatted = format!("{}{}", prefix, line);
                    // Store in state for persistence
                    if let Some(state) = app_clone.try_state::<SharedState>() {
                        let mut s = state.lock().unwrap();
                        let buf = s.logs.entry(branch_name_s.clone()).or_insert_with(|| std::collections::VecDeque::with_capacity(2000));
                        if buf.len() >= 2000 {
                            buf.pop_front();
                        }
                        buf.push_back(formatted.clone());
                    }
                    let _ = app_clone.emit(
                        &format!("branch-log:{}", branch_name_s),
                        formatted,
                    );
                }
            }
        });
    }

    // Monitor exit
    let branch_name_s = branch_name.to_string();
    let label_s = cmd.label.clone();
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        eprintln!("[BranchPilot] process exited: branch={}, label={}, status={:?}",
            branch_name_s, label_s, status);
        if let Some(state) = app_clone.try_state::<SharedState>() {
            let mut s = state.lock().unwrap();
            s.pids.remove(&format!("{}:{}", branch_name_s, label_s));
            // If no more PIDs for this branch, mark as error
            let has_remaining = s.pids.keys().any(|k| k.starts_with(&format!("{}:", branch_name_s)));
            if !has_remaining {
                if let Some(env) = s.environments.get_mut(&branch_name_s) {
                    if env.status == Status::Running {
                        env.status = Status::Error;
                    }
                }
            }
        }
        let _ = app_clone.emit("environment-updated", ());
    });

    // Store PID with label
    {
        let mut s = state.lock().unwrap();
        s.pids.insert(format!("{}:{}", branch_name, cmd.label), pid);
    }

    Ok(pid)
}

/// Read an env var value from the project's .env files
pub fn read_env_var(worktree_path: &Path, key: &str) -> Option<String> {
    let env_files = [
        "enterprise/app-ee/.env.development.local",
        ".env.development.local",
        "enterprise/app-ee/.env.local",
        ".env.local",
        "enterprise/app-ee/.env.development",
        ".env.development",
        "enterprise/app-ee/.env",
        ".env",
    ];

    let prefix = format!("{}=", key);
    for env_file in &env_files {
        let path = worktree_path.join(env_file);
        if let Ok(content) = std::fs::read_to_string(&path) {
            for line in content.lines() {
                let line = line.trim();
                if line.starts_with('#') || !line.contains('=') {
                    continue;
                }
                if let Some(val) = line.strip_prefix(&prefix) {
                    return Some(val.to_string());
                }
            }
        }
    }
    None
}

/// Read the base PRISMA_DATABASE_URL from the project's .env files
pub fn read_base_database_url(worktree_path: &Path) -> Option<String> {
    read_env_var(worktree_path, "PRISMA_DATABASE_URL")
}

/// Replace the database name in a PostgreSQL URL
/// e.g. "postgresql://user:pass@host:5432/teable?schema=public"
///   -> "postgresql://user:pass@host:5432/teable_fix_share?schema=public"
pub fn replace_db_name(url: &str, new_db_name: &str) -> String {
    // URL format: postgresql://user:pass@host:port/dbname?params
    if let Some(slash_pos) = url.rfind("://") {
        let after_proto = &url[slash_pos + 3..];
        // Find the slash before db name (after host:port)
        if let Some(db_start) = after_proto.find('/') {
            let prefix = &url[..slash_pos + 3 + db_start + 1]; // everything up to and including the /
            let after_db = &after_proto[db_start + 1..];
            // Find where db name ends (? or end of string)
            let db_end = after_db.find('?').unwrap_or(after_db.len());
            let suffix = &after_db[db_end..]; // ?params or empty
            return format!("{}{}{}", prefix, new_db_name, suffix);
        }
    }
    url.to_string()
}

/// Extract database name from a PostgreSQL URL
pub fn extract_db_name(url: &str) -> Option<String> {
    if let Some(slash_pos) = url.rfind("://") {
        let after_proto = &url[slash_pos + 3..];
        if let Some(db_start) = after_proto.find('/') {
            let after_db = &after_proto[db_start + 1..];
            let db_end = after_db.find('?').unwrap_or(after_db.len());
            return Some(after_db[..db_end].to_string());
        }
    }
    None
}

/// Start dev services for a branch.
/// `backend_port` / `frontend_port` are the ports to use (either from env files or allocated).
pub fn start_service(
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
    branch_name: &str,
    worktree_path: &Path,
    backend_port: u16,
    socket_port: u16,
    frontend_port: u16,
) -> Result<(), String> {
    // Clean up stale Next.js dev lock files to prevent "is another instance running?" errors
    for lock_path in &[
        worktree_path.join("enterprise/app-ee/.next/dev/lock"),
        worktree_path.join(".next/dev/lock"),
    ] {
        if lock_path.exists() {
            eprintln!("[BranchPilot] Removing stale Next.js lock: {}", lock_path.display());
            let _ = std::fs::remove_file(lock_path);
        }
    }

    // Install deps if needed
    ensure_dependencies(worktree_path)?;

    // Database: ensure the database referenced in the env file exists
    let db_url = if let Some(env_url) = read_base_database_url(worktree_path) {
        match ensure_database_exists(&env_url) {
            Ok(url) => {
                eprintln!("[BranchPilot] Using database URL: {}", url);
                Some(url)
            }
            Err(e) => {
                eprintln!("[BranchPilot] Warning: database check failed: {}. Using env URL.", e);
                Some(env_url)
            }
        }
    } else {
        eprintln!("[BranchPilot] No PRISMA_DATABASE_URL found, skipping database setup");
        None
    };

    let mut commands = detect_start_commands(worktree_path, backend_port, socket_port, frontend_port);

    // Add PRISMA_DATABASE_URL to all commands if we have an isolated db
    if let Some(ref url) = db_url {
        for cmd in &mut commands {
            cmd.env_vars.push(("PRISMA_DATABASE_URL".to_string(), url.clone()));
        }
    }

    // Redis: use the URI from the env file as-is (already configured during worktree creation)
    if let Some(redis_uri) = read_env_var(worktree_path, "BACKEND_CACHE_REDIS_URI") {
        eprintln!("[BranchPilot] Using Redis URI: {}", redis_uri);
        for cmd in &mut commands {
            cmd.env_vars.push(("BACKEND_CACHE_REDIS_URI".to_string(), redis_uri.clone()));
        }
    }

    for cmd in &commands {
        spawn_process(&app, &state, branch_name, cmd, worktree_path)?;
    }

    // Update status to running
    {
        let mut s = state.lock().unwrap();
        if let Some(env) = s.environments.get_mut(branch_name) {
            env.status = Status::Running;
        }
    }

    let _ = app.emit("environment-updated", ());
    Ok(())
}

/// Create a database with a specific name from a specific template.
/// If the database already exists, do nothing.
pub fn create_database_with_template(
    base_url: &str,
    new_db_name: &str,
    template_db_name: &str,
) -> Result<String, String> {
    let admin_url = replace_db_name(base_url, "postgres");
    let admin_url_clean = admin_url.split('?').next().unwrap_or(&admin_url);

    // Check if database already exists
    let check = Command::new("psql")
        .env("PATH", shell::user_path())
        .args([admin_url_clean, "-tAc",
            &format!("SELECT 1 FROM pg_database WHERE datname = '{}'", new_db_name)])
        .output()
        .map_err(|e| format!("Failed to run psql: {}", e))?;

    let exists = String::from_utf8_lossy(&check.stdout).trim() == "1";

    if !exists {
        eprintln!("[BranchPilot] Creating database '{}' from template '{}'", new_db_name, template_db_name);

        let create = Command::new("psql")
            .env("PATH", shell::user_path())
            .args([admin_url_clean, "-c",
                &format!("CREATE DATABASE \"{}\" TEMPLATE \"{}\"", new_db_name, template_db_name)])
            .output()
            .map_err(|e| format!("Failed to create database: {}", e))?;

        if !create.status.success() {
            let stderr = String::from_utf8_lossy(&create.stderr);
            if stderr.contains("being accessed by other users") {
                eprintln!("[BranchPilot] Template db '{}' in use, creating empty database '{}'", template_db_name, new_db_name);
                let create_empty = Command::new("psql")
                    .env("PATH", shell::user_path())
                    .args([admin_url_clean, "-c",
                        &format!("CREATE DATABASE \"{}\"", new_db_name)])
                    .output()
                    .map_err(|e| format!("Failed to create empty database: {}", e))?;

                if !create_empty.status.success() {
                    let stderr = String::from_utf8_lossy(&create_empty.stderr);
                    return Err(format!("Failed to create database: {}", stderr));
                }
            } else {
                return Err(format!("Failed to create database: {}", stderr));
            }
        }
    } else {
        eprintln!("[BranchPilot] Database '{}' already exists", new_db_name);
    }

    let new_url = replace_db_name(base_url, new_db_name);
    Ok(new_url)
}

/// Ensure the database referenced in a URL exists. If not, create it empty.
/// Returns the URL unchanged.
pub fn ensure_database_exists(db_url: &str) -> Result<String, String> {
    let db_name = extract_db_name(db_url).ok_or("Cannot extract database name from URL")?;
    let admin_url = replace_db_name(db_url, "postgres");
    let admin_url_clean = admin_url.split('?').next().unwrap_or(&admin_url);

    let check = Command::new("psql")
        .env("PATH", shell::user_path())
        .args([admin_url_clean, "-tAc",
            &format!("SELECT 1 FROM pg_database WHERE datname = '{}'", db_name)])
        .output()
        .map_err(|e| format!("Failed to run psql: {}", e))?;

    let exists = String::from_utf8_lossy(&check.stdout).trim() == "1";

    if !exists {
        eprintln!("[BranchPilot] Database '{}' does not exist, creating empty", db_name);
        let create = Command::new("psql")
            .env("PATH", shell::user_path())
            .args([admin_url_clean, "-c",
                &format!("CREATE DATABASE \"{}\"", db_name)])
            .output()
            .map_err(|e| format!("Failed to create database: {}", e))?;

        if !create.status.success() {
            let stderr = String::from_utf8_lossy(&create.stderr);
            return Err(format!("Failed to create database '{}': {}", db_name, stderr));
        }
    }

    Ok(db_url.to_string())
}

/// Derive a safe database name from a branch name: teable_{sanitized}
pub fn branch_to_db_name(branch_name: &str) -> String {
    let safe_name = branch_name
        .replace('/', "_")
        .replace('-', "_")
        .to_lowercase();
    format!("teable_{}", safe_name)
}

/// Info about a worktree's database and Redis configuration
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDbInfo {
    pub branch_name: String,
    pub database_name: Option<String>,
    pub database_url: Option<String>,
    pub redis_uri: Option<String>,
}

/// Scan all worktrees and read their DB/Redis configuration from env files
pub fn list_worktree_db_info(repo_path: &std::path::Path) -> Vec<WorktreeDbInfo> {
    let mut result = Vec::new();

    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["worktree", "list", "--porcelain"])
        .output();

    let output = match output {
        Ok(o) if o.status.success() => o,
        _ => return result,
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut current_path: Option<String> = None;

    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            current_path = Some(path.to_string());
        } else if let Some(branch_ref) = line.strip_prefix("branch ") {
            let short_name = branch_ref.strip_prefix("refs/heads/").unwrap_or(branch_ref);
            if let Some(ref path) = current_path {
                let wt_path = std::path::Path::new(path);
                let db_url = read_base_database_url(wt_path);
                let db_name = db_url.as_ref().and_then(|u| extract_db_name(u));
                let redis_uri = read_env_var(wt_path, "BACKEND_CACHE_REDIS_URI");

                result.push(WorktreeDbInfo {
                    branch_name: short_name.to_string(),
                    database_name: db_name,
                    database_url: db_url,
                    redis_uri,
                });
            }
        }
        if line.is_empty() {
            current_path = None;
        }
    }

    result
}

/// The keys that BranchPilot overrides in the env file
pub const OVERRIDE_KEYS: &[&str] = &[
    "PORT",
    "SOCKET_PORT",
    "SERVER_PORT",
    "PUBLIC_ORIGIN",
    "STORAGE_PREFIX",
    "PRISMA_DATABASE_URL",
    "PUBLIC_DATABASE_PROXY",
    "BACKEND_CACHE_REDIS_URI",
];

/// The BranchPilot override env vars for a worktree
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEnvOverrides {
    pub port: Option<String>,
    pub socket_port: Option<String>,
    pub server_port: Option<String>,
    pub public_origin: Option<String>,
    pub storage_prefix: Option<String>,
    pub prisma_database_url: Option<String>,
    pub public_database_proxy: Option<String>,
    pub backend_cache_redis_uri: Option<String>,
}

/// Read the BranchPilot override env vars from a worktree's env file
pub fn read_worktree_env_overrides(worktree_path: &Path) -> WorktreeEnvOverrides {
    WorktreeEnvOverrides {
        port: read_env_var(worktree_path, "PORT"),
        socket_port: read_env_var(worktree_path, "SOCKET_PORT"),
        server_port: read_env_var(worktree_path, "SERVER_PORT"),
        public_origin: read_env_var(worktree_path, "PUBLIC_ORIGIN"),
        storage_prefix: read_env_var(worktree_path, "STORAGE_PREFIX"),
        prisma_database_url: read_env_var(worktree_path, "PRISMA_DATABASE_URL"),
        public_database_proxy: read_env_var(worktree_path, "PUBLIC_DATABASE_PROXY"),
        backend_cache_redis_uri: read_env_var(worktree_path, "BACKEND_CACHE_REDIS_URI"),
    }
}

/// Update BranchPilot override env vars in a worktree's env file.
/// Only updates the values in the "BranchPilot overrides" section.
pub fn update_worktree_env_overrides(
    worktree_path: &Path,
    overrides: &WorktreeEnvOverrides,
) -> Result<(), String> {
    // Find the env file
    let env_paths = [
        worktree_path.join("enterprise/app-ee/.env.development.local"),
        worktree_path.join(".env.development.local"),
    ];

    let env_path = env_paths.iter().find(|p| p.exists())
        .ok_or("No .env.development.local found in worktree")?;

    let content = std::fs::read_to_string(env_path)
        .map_err(|e| format!("Failed to read env file: {}", e))?;

    // Build a map of new override values
    let new_values: std::collections::HashMap<&str, &str> = [
        ("PORT", overrides.port.as_deref()),
        ("SOCKET_PORT", overrides.socket_port.as_deref()),
        ("SERVER_PORT", overrides.server_port.as_deref()),
        ("PUBLIC_ORIGIN", overrides.public_origin.as_deref()),
        ("STORAGE_PREFIX", overrides.storage_prefix.as_deref()),
        ("PRISMA_DATABASE_URL", overrides.prisma_database_url.as_deref()),
        ("PUBLIC_DATABASE_PROXY", overrides.public_database_proxy.as_deref()),
        ("BACKEND_CACHE_REDIS_URI", overrides.backend_cache_redis_uri.as_deref()),
    ]
    .into_iter()
    .filter_map(|(k, v)| v.map(|val| (k, val)))
    .collect();

    // Rewrite the file, replacing override lines with new values
    let mut output_lines: Vec<String> = Vec::new();
    let mut replaced_keys: std::collections::HashSet<&str> = std::collections::HashSet::new();

    for line in content.lines() {
        let trimmed = line.trim();
        // Check if this line is one of our override keys
        let mut matched_key: Option<&str> = None;
        for key in OVERRIDE_KEYS {
            if trimmed.starts_with(&format!("{}=", key)) {
                matched_key = Some(key);
                break;
            }
        }

        if let Some(key) = matched_key {
            if let Some(new_val) = new_values.get(key) {
                output_lines.push(format!("{}={}", key, new_val));
                replaced_keys.insert(key);
            } else {
                output_lines.push(line.to_string());
            }
        } else {
            output_lines.push(line.to_string());
        }
    }

    // Append any new override keys that weren't in the file
    for (key, val) in &new_values {
        if !replaced_keys.contains(key) {
            output_lines.push(format!("{}={}", key, val));
        }
    }

    std::fs::write(env_path, output_lines.join("\n"))
        .map_err(|e| format!("Failed to write env file: {}", e))?;

    Ok(())
}

/// Kill any process listening on the given port via `lsof`
fn kill_port(port: u16) {
    let output = std::process::Command::new("lsof")
        .args(["-ti", &format!("tcp:{}", port)])
        .output();
    if let Ok(output) = output {
        let pids_str = String::from_utf8_lossy(&output.stdout);
        for pid_s in pids_str.split_whitespace() {
            if let Ok(pid) = pid_s.trim().parse::<i32>() {
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }
    }
}

/// Stop a branch service by killing all process groups for this branch
pub fn stop_service(state: &SharedState, branch_name: &str) -> Result<(), String> {
    let mut s = state.lock().unwrap();

    // Collect ports before clearing, so we can do port-level cleanup
    let ports_to_kill: Vec<u16> = s.environments.get(branch_name)
        .map(|env| {
            let mut ports = Vec::new();
            if let Some(p) = env.port { ports.push(p); }
            if let Some(p) = env.backend_port { ports.push(p); }
            if let Some(p) = env.socket_port { ports.push(p); }
            ports
        })
        .unwrap_or_default();

    let prefix = format!("{}:", branch_name);
    let pids: Vec<(String, u32)> = s.pids.iter()
        .filter(|(k, _)| k.starts_with(&prefix))
        .map(|(k, v)| (k.clone(), *v))
        .collect();

    for (key, pid) in &pids {
        s.pids.remove(key);
        unsafe {
            libc::killpg(*pid as i32, libc::SIGTERM);
        }
    }

    if let Some(env) = s.environments.get_mut(branch_name) {
        env.status = Status::Stopped;
        env.port = None;
        env.backend_port = None;
        env.socket_port = None;
    }

    // Drop the lock before sleeping
    drop(s);

    // Background: force-kill process groups after timeout, then kill anything still on the ports
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        for (_, pid) in pids {
            unsafe {
                libc::killpg(pid as i32, libc::SIGKILL);
            }
        }
        // Final fallback: kill anything still listening on these ports
        for port in ports_to_kill {
            kill_port(port);
        }
    });

    Ok(())
}

/// Kill all running processes (called on app exit)
pub fn cleanup_all(state: &SharedState) {
    let s = state.lock().unwrap();
    for (_, pid) in s.pids.iter() {
        unsafe {
            libc::killpg(*pid as i32, libc::SIGKILL);
        }
    }
    // Also kill by port for any leaked child processes
    for env in s.environments.values() {
        if env.status == Status::Running || env.status == Status::Building {
            if let Some(p) = env.port { kill_port(p); }
            if let Some(p) = env.backend_port { kill_port(p); }
            if let Some(p) = env.socket_port { kill_port(p); }
        }
    }
}
