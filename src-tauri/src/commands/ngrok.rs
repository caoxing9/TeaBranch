use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

use crate::process::manager::{read_env_var, update_worktree_env_overrides, WorktreeEnvOverrides};
use crate::state::{NgrokTunnel, SharedState};

extern crate libc;

fn find_worktree_for_branch(repo_path: &Path, branch_name: &str) -> Result<std::path::PathBuf, String> {
    let output = Command::new("git")
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
    let head = Command::new("git")
        .current_dir(repo_path)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to get HEAD: {}", e))?;
    if String::from_utf8_lossy(&head.stdout).trim() == branch_name {
        return Ok(repo_path.to_path_buf());
    }
    Err(format!("No worktree found for branch '{}'", branch_name))
}

/// Poll ngrok's local API at 127.0.0.1:4040 for the public URL of the tunnel.
fn fetch_public_url(port: u16, max_seconds: u64) -> Result<String, String> {
    for _ in 0..max_seconds {
        let out = Command::new("curl")
            .args(["-s", "--max-time", "2", "http://127.0.0.1:4040/api/tunnels"])
            .output();
        if let Ok(out) = out {
            if out.status.success() && !out.stdout.is_empty() {
                if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&out.stdout) {
                    if let Some(tunnels) = json.get("tunnels").and_then(|t| t.as_array()) {
                        for t in tunnels {
                            let addr = t.get("config")
                                .and_then(|c| c.get("addr"))
                                .and_then(|a| a.as_str())
                                .unwrap_or("");
                            let matches_port = addr.ends_with(&format!(":{}", port))
                                || addr == &port.to_string()
                                || addr == &format!("http://localhost:{}", port);
                            let public_url = t.get("public_url").and_then(|u| u.as_str());
                            if let Some(url) = public_url {
                                if matches_port || tunnels.len() == 1 {
                                    return Ok(url.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    Err("Timed out waiting for ngrok tunnel".to_string())
}

fn kill_pgid(pid: u32) {
    unsafe {
        libc::killpg(pid as i32, libc::SIGTERM);
    }
    std::thread::sleep(Duration::from_millis(300));
    unsafe {
        libc::killpg(pid as i32, libc::SIGKILL);
    }
}

#[tauri::command]
pub fn start_ngrok(
    app: AppHandle,
    branch_name: String,
    state: State<'_, SharedState>,
) -> Result<NgrokTunnel, String> {
    let (repo_path, existing_pid) = {
        let s = state.lock().unwrap();
        let repo = s.settings.project_path.clone().ok_or("No project path set")?;
        (std::path::PathBuf::from(repo), s.ngrok_pid)
    };

    // Kill any existing ngrok agent — free plan only allows one at a time.
    if let Some(pid) = existing_pid {
        kill_pgid(pid);
        let mut s = state.lock().unwrap();
        s.ngrok_pid = None;
        s.ngrok_tunnel = None;
    }

    let worktree_path = find_worktree_for_branch(&repo_path, &branch_name)?;
    let port_str = read_env_var(&worktree_path, "SERVER_PORT")
        .ok_or("SERVER_PORT not found in worktree env file")?;
    let port: u16 = port_str
        .parse()
        .map_err(|e| format!("Invalid SERVER_PORT '{}': {}", port_str, e))?;

    let _ = app.emit("ngrok:status", serde_json::json!({
        "branchName": branch_name,
        "phase": "starting",
        "port": port,
    }));

    let mut cmd = Command::new("ngrok");
    cmd.args(["http", &port.to_string(), "--log=stdout"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null());
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn ngrok (is it installed?): {}", e))?;
    let pid = child.id();

    // Detach: we track only the PID. Reaping happens via killpg + wait on stop.
    std::mem::forget(child);

    let public_url = match fetch_public_url(port, 25) {
        Ok(url) => url,
        Err(e) => {
            kill_pgid(pid);
            let _ = app.emit("ngrok:status", serde_json::json!({
                "branchName": branch_name,
                "phase": "error",
                "error": e.clone(),
            }));
            return Err(e);
        }
    };

    // Write SANDBOX_TEABLE_ENDPOINT into the worktree env file.
    let overrides = WorktreeEnvOverrides {
        port: None,
        socket_port: None,
        server_port: None,
        public_origin: None,
        storage_prefix: None,
        prisma_database_url: None,
        public_database_proxy: None,
        backend_cache_redis_uri: None,
        sandbox_teable_endpoint: Some(public_url.clone()),
    };
    if let Err(e) = update_worktree_env_overrides(&worktree_path, &overrides) {
        // Don't fail the whole flow — surface as warning via event.
        let _ = app.emit("ngrok:status", serde_json::json!({
            "branchName": branch_name,
            "phase": "warning",
            "message": format!("Tunnel started but failed to update env file: {}", e),
        }));
    }

    let tunnel = NgrokTunnel {
        branch_name: branch_name.clone(),
        port,
        public_url: public_url.clone(),
    };
    {
        let mut s = state.lock().unwrap();
        s.ngrok_pid = Some(pid);
        s.ngrok_tunnel = Some(tunnel.clone());
    }

    let _ = app.emit("ngrok:status", serde_json::json!({
        "branchName": branch_name,
        "phase": "running",
        "publicUrl": public_url,
        "port": port,
    }));

    Ok(tunnel)
}

#[tauri::command]
pub fn stop_ngrok(state: State<'_, SharedState>) -> Result<(), String> {
    let pid = {
        let mut s = state.lock().unwrap();
        let pid = s.ngrok_pid.take();
        s.ngrok_tunnel = None;
        pid
    };
    if let Some(pid) = pid {
        kill_pgid(pid);
    }
    Ok(())
}

#[tauri::command]
pub fn get_ngrok_status(state: State<'_, SharedState>) -> Result<Option<NgrokTunnel>, String> {
    let s = state.lock().unwrap();
    Ok(s.ngrok_tunnel.clone())
}
