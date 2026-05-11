use tauri::{AppHandle, Emitter, State};

use crate::git::branches::list_local_branches;
use crate::git::worktree::{self, DbMode};
use crate::process::manager::{self, stop_service, WorktreeDbInfo};
use crate::state::{Branch, SharedState};
use crate::watcher::file_watcher;

#[tauri::command]
pub fn list_branches(state: State<'_, SharedState>) -> Result<Vec<Branch>, String> {
    let s = state.lock().unwrap();
    let path = s.project_path().ok_or("No project path set")?;
    let envs = &s.environments;
    list_local_branches(&path, envs)
}

#[tauri::command(async)]
pub fn remove_worktree(branch_name: String, state: State<'_, SharedState>) -> Result<(), String> {
    // Stop file watcher and service first
    file_watcher::stop_watching(&branch_name);
    let _ = stop_service(&state, &branch_name);

    let s = state.lock().unwrap();
    let path = s.project_path().ok_or("No project path set")?;
    drop(s);

    worktree::remove_worktree(&path, &branch_name)?;

    let mut s = state.lock().unwrap();
    s.environments.remove(&branch_name);
    s.logs.remove(&branch_name);
    Ok(())
}

#[tauri::command(async)]
pub fn create_worktree(
    branch_name: String,
    db_mode: Option<String>,
    source_branch: Option<String>,
    app: AppHandle,
    state: State<'_, SharedState>,
) -> Result<(), String> {
    let repo_path = {
        let s = state.lock().unwrap();
        s.project_path().ok_or("No project path set")?
    };

    let mode = match db_mode.as_deref() {
        Some("clone") => {
            let src = source_branch.ok_or("source_branch is required for clone mode")?;
            DbMode::Clone { source_branch: src }
        }
        Some("reuse") => {
            let src = source_branch.ok_or("source_branch is required for reuse mode")?;
            DbMode::Reuse { source_branch: src }
        }
        _ => DbMode::New,
    };

    worktree::create_worktree_full(&app, &repo_path, &branch_name, mode)?;

    let _ = app.emit("environment-updated", ());
    Ok(())
}

#[tauri::command]
pub fn list_worktree_db_info(state: State<'_, SharedState>) -> Result<Vec<WorktreeDbInfo>, String> {
    let s = state.lock().unwrap();
    let path = s.project_path().ok_or("No project path set")?;
    drop(s);
    Ok(manager::list_worktree_db_info(&path))
}

#[tauri::command]
pub fn open_in_vscode(path: String) -> Result<(), String> {
    let dir = std::path::Path::new(&path);
    // Look for a .code-workspace file in the worktree root so VS Code
    // opens the multi-root workspace directly instead of a plain folder.
    let workspace_file = std::fs::read_dir(dir)
        .ok()
        .and_then(|entries| {
            entries
                .filter_map(|e| e.ok())
                .find(|e| {
                    e.path()
                        .extension()
                        .map_or(false, |ext| ext == "code-workspace")
                })
                .map(|e| e.path())
        });

    let target = workspace_file
        .as_deref()
        .unwrap_or(dir);

    std::process::Command::new("code")
        .env("PATH", crate::shell::user_path())
        .arg("-n")
        .arg(target)
        .spawn()
        .map_err(|e| format!("Failed to open VS Code: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn open_in_terminal(path: String, state: State<'_, SharedState>) -> Result<(), String> {
    let s = state.lock().unwrap();
    let terminal_app = s.settings.terminal_app.clone();
    drop(s);

    let dir = std::path::Path::new(&path);
    if !dir.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    match terminal_app.as_deref() {
        Some(app) => {
            // Ghostty ignores the path passed via `open -a <app> <path>` and
            // needs `--working-directory=<path>` forwarded as a launch arg.
            if app.eq_ignore_ascii_case("Ghostty") {
                std::process::Command::new("open")
                    .args(["-na", app, "--args", &format!("--working-directory={}", path)])
                    .spawn()
                    .map_err(|e| format!("Failed to open {}: {}", app, e))?;
            } else {
                std::process::Command::new("open")
                    .args(["-a", app, &path])
                    .spawn()
                    .map_err(|e| format!("Failed to open {}: {}", app, e))?;
            }
        }
        None => {
            // Default: use macOS `open -a Terminal <path>`
            std::process::Command::new("open")
                .args(["-a", "Terminal", &path])
                .spawn()
                .map_err(|e| format!("Failed to open Terminal: {}", e))?;
        }
    }
    Ok(())
}
