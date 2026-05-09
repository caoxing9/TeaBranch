use tauri::{AppHandle, Manager, State, Emitter, WebviewUrl, WebviewWindowBuilder};

use crate::process::manager::{self, read_env_var, extract_db_name, WorktreeEnvOverrides};
use crate::process::port::find_available_port;
use crate::state::{BranchEnvironment, SharedState, Status};
use crate::watcher::file_watcher;

/// Find the worktree path for a given branch by running `git worktree list`
fn find_worktree_for_branch(repo_path: &std::path::Path, branch_name: &str) -> Result<std::path::PathBuf, String> {
    let output = std::process::Command::new("git")
        .current_dir(repo_path)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| format!("Failed to run git worktree list: {}", e))?;

    if !output.status.success() {
        return Err("git worktree list failed".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut current_path: Option<String> = None;

    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            current_path = Some(path.to_string());
        } else if let Some(branch_ref) = line.strip_prefix("branch ") {
            // branch_ref looks like "refs/heads/fix/share-node-exchange"
            let short_name = branch_ref.strip_prefix("refs/heads/").unwrap_or(branch_ref);
            if short_name == branch_name {
                if let Some(path) = current_path.take() {
                    return Ok(std::path::PathBuf::from(path));
                }
            }
        }
        if line.is_empty() {
            current_path = None;
        }
    }

    // If not found as a separate worktree, the branch might be the main repo's current branch
    // In that case, use the repo_path itself
    let head_output = std::process::Command::new("git")
        .current_dir(repo_path)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to get HEAD: {}", e))?;

    let head_branch = String::from_utf8_lossy(&head_output.stdout).trim().to_string();
    if head_branch == branch_name {
        return Ok(repo_path.to_path_buf());
    }

    Err(format!("No worktree found for branch '{}'. You may need to create one first with `git worktree add`.", branch_name))
}

#[tauri::command]
pub fn start_branch(
    branch_name: String,
    app: AppHandle,
    state: State<'_, SharedState>,
) -> Result<(), String> {
    let repo_path;
    {
        let s = state.lock().unwrap();
        repo_path = s.project_path().ok_or("No project path set")?;

        // Check if already running
        if let Some(env) = s.environments.get(&branch_name) {
            if env.status == Status::Running || env.status == Status::Building {
                return Err("Branch is already running".to_string());
            }
        }
    }

    // Find existing worktree path for this branch (before port allocation so we can read env files)
    let worktree_path = find_worktree_for_branch(&repo_path, &branch_name)?;

    // Try to read ports from the project's env files (.env.local, .env.development.local, etc.)
    let env_backend_port = read_env_var(&worktree_path, "SERVER_PORT")
        .and_then(|v| v.parse::<u16>().ok());
    let env_socket_port = read_env_var(&worktree_path, "SOCKET_PORT")
        .and_then(|v| v.parse::<u16>().ok());
    let env_frontend_port = read_env_var(&worktree_path, "PORT")
        .and_then(|v| v.parse::<u16>().ok());

    let (backend_port, socket_port, frontend_port);
    {
        let s = state.lock().unwrap();
        let mut used_ports: std::collections::HashSet<u16> = s.environments.values()
            .filter(|env| env.status == Status::Running || env.status == Status::Building)
            .flat_map(|env| [env.port, env.backend_port, env.socket_port].into_iter().flatten())
            .collect();

        // Use ports from env files if available, otherwise allocate new ones
        backend_port = env_backend_port.unwrap_or_else(|| find_available_port(s.settings.base_port, &used_ports));
        used_ports.insert(backend_port);
        socket_port = env_socket_port.unwrap_or_else(|| find_available_port(backend_port + 1, &used_ports));
        used_ports.insert(socket_port);
        frontend_port = env_frontend_port.unwrap_or_else(|| find_available_port(socket_port + 1, &used_ports));
    }
    eprintln!("[TeaBranch] start_branch: branch={}, worktree={}, backend_port={}, socket_port={}, frontend_port={}",
        branch_name, worktree_path.display(), backend_port, socket_port, frontend_port);

    // Read actual database name from env file for display
    let db_name = manager::read_base_database_url(&worktree_path)
        .and_then(|url| extract_db_name(&url))
        .unwrap_or_else(|| manager::branch_to_db_name(&branch_name));

    // Update state — store frontend_port as the preview port
    {
        let mut s = state.lock().unwrap();
        s.environments.insert(
            branch_name.clone(),
            BranchEnvironment {
                branch_name: branch_name.clone(),
                worktree_path: Some(worktree_path.to_string_lossy().to_string()),
                port: Some(frontend_port),
                backend_port: Some(backend_port),
                socket_port: Some(socket_port),
                status: Status::Building,
                start_command: None,
                database_name: Some(db_name),
            },
        );
    }

    let _ = app.emit("environment-updated", ());

    // Start services in the existing worktree
    manager::start_service(app.clone(), state.clone(), &branch_name, &worktree_path, backend_port, socket_port, frontend_port)?;

    // Start file watcher
    file_watcher::watch_worktree(app, &branch_name, &worktree_path);

    Ok(())
}

#[tauri::command]
pub fn stop_branch(
    branch_name: String,
    app: AppHandle,
    state: State<'_, SharedState>,
) -> Result<(), String> {
    // Stop the file watcher for this branch
    file_watcher::stop_watching(&branch_name);

    manager::stop_service(&state, &branch_name)?;

    // Clear in-memory logs to free memory
    {
        let mut s = state.lock().unwrap();
        s.logs.remove(&branch_name);
    }

    let _ = app.emit("environment-updated", ());
    Ok(())
}

#[tauri::command]
pub fn get_environments(state: State<'_, SharedState>) -> Result<Vec<BranchEnvironment>, String> {
    let s = state.lock().unwrap();
    Ok(s.environments.values().cloned().collect())
}

#[tauri::command]
pub fn get_branch_logs(branch_name: String, state: State<'_, SharedState>) -> Result<Vec<String>, String> {
    let s = state.lock().unwrap();
    Ok(s.logs
        .get(&branch_name)
        .map(|logs| logs.iter().cloned().collect())
        .unwrap_or_default())
}

#[tauri::command]
pub fn open_preview_window(
    _branches: Vec<String>,
    app: AppHandle,
) -> Result<(), String> {
    // Check if preview window already exists
    if let Some(window) = app.get_webview_window("preview") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    // Create new preview window
    let url = WebviewUrl::App("preview.html".into());
    WebviewWindowBuilder::new(&app, "preview", url)
        .title("TeaBranch - Compare")
        .inner_size(1200.0, 800.0)
        .resizable(true)
        .build()
        .map_err(|e| format!("Failed to create preview window: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn get_worktree_env(
    branch_name: String,
    state: State<'_, SharedState>,
) -> Result<WorktreeEnvOverrides, String> {
    let repo_path = {
        let s = state.lock().unwrap();
        s.project_path().ok_or("No project path set")?
    };
    let worktree_path = find_worktree_for_branch(&repo_path, &branch_name)?;
    Ok(manager::read_worktree_env_overrides(&worktree_path))
}

#[tauri::command]
pub fn update_worktree_env(
    branch_name: String,
    overrides: WorktreeEnvOverrides,
    state: State<'_, SharedState>,
) -> Result<(), String> {
    let repo_path = {
        let s = state.lock().unwrap();
        s.project_path().ok_or("No project path set")?
    };
    let worktree_path = find_worktree_for_branch(&repo_path, &branch_name)?;
    manager::update_worktree_env_overrides(&worktree_path, &overrides)
}
