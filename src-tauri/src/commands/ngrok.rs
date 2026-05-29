use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::process::manager::{read_env_var, update_worktree_env_overrides, WorktreeEnvOverrides};
use crate::state::{NgrokTunnel, SharedState};

const NGROK_LOG_MAX: usize = 2000;

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

/// Parse ngrok's `started tunnel` log line and return the public URL.
/// Example line:
///   t=... lvl=info msg="started tunnel" obj=tunnels name=command_line addr=http://localhost:5103 url=https://abc.ngrok-free.app
fn extract_public_url(line: &str) -> Option<String> {
    if !line.contains("started tunnel") {
        return None;
    }
    let idx = line.find(" url=")?;
    let rest = &line[idx + 5..];
    let end = rest
        .find(|c: char| c.is_whitespace())
        .unwrap_or(rest.len());
    let url = &rest[..end];
    if url.starts_with("http://") || url.starts_with("https://") {
        Some(url.to_string())
    } else {
        None
    }
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

    // Clear any logs from the prior tunnel so the UI starts clean.
    {
        let mut s = state.lock().unwrap();
        s.ngrok_logs.clear();
    }

    let mut cmd = Command::new("ngrok");
    cmd.args(["http", &port.to_string(), "--log=stdout"])
        .env("PATH", crate::shell::user_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn ngrok (is it installed?): {}", e))?;
    let pid = child.id();

    let (url_tx, url_rx) = mpsc::channel::<String>();

    if let Some(stdout) = child.stdout.take() {
        spawn_log_reader(app.clone(), stdout, "stdout", Some(url_tx));
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_log_reader(app.clone(), stderr, "stderr", None);
    }

    // Detach: we track only the PID. Reaping happens via killpg + wait on stop.
    std::mem::forget(child);

    let public_url = match url_rx.recv_timeout(Duration::from_secs(25)) {
        Ok(url) => url,
        Err(_) => {
            kill_pgid(pid);
            let err = "Timed out waiting for ngrok tunnel".to_string();
            let _ = app.emit("ngrok:status", serde_json::json!({
                "branchName": branch_name,
                "phase": "error",
                "error": err.clone(),
            }));
            return Err(err);
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

#[tauri::command]
pub fn get_ngrok_logs(state: State<'_, SharedState>) -> Result<Vec<String>, String> {
    let s = state.lock().unwrap();
    Ok(s.ngrok_logs.iter().cloned().collect())
}

fn spawn_log_reader<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    reader: R,
    stream: &'static str,
    url_tx: Option<mpsc::Sender<String>>,
) {
    std::thread::spawn(move || {
        let buf = BufReader::new(reader);
        let mut url_sent = false;
        for line in buf.lines().map_while(Result::ok) {
            if !url_sent {
                if let Some(tx) = url_tx.as_ref() {
                    if let Some(url) = extract_public_url(&line) {
                        let _ = tx.send(url);
                        url_sent = true;
                    }
                }
            }
            let formatted = if stream == "stderr" {
                format!("[stderr] {}", line)
            } else {
                line
            };
            {
                let state = app.state::<SharedState>();
                let mut s = state.lock().unwrap();
                if s.ngrok_logs.len() >= NGROK_LOG_MAX {
                    s.ngrok_logs.pop_front();
                }
                s.ngrok_logs.push_back(formatted.clone());
            }
            let _ = app.emit("ngrok:log", &formatted);
        }
    });
}

/// First PID of a process matching `name` (exact match), via `pgrep -x`.
fn pgrep_first(name: &str) -> Option<u32> {
    let out = Command::new("pgrep")
        .args(["-x", name])
        .env("PATH", crate::shell::user_path())
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .and_then(|s| s.trim().parse::<u32>().ok())
}

/// Map a forwarded local port back to a branch via its SERVER_PORT env value.
fn find_branch_by_server_port(repo_path: &Path, port: u16) -> Option<String> {
    if port == 0 {
        return None;
    }
    for (branch, path) in crate::process::manager::list_worktrees(repo_path) {
        if read_env_var(&path, "SERVER_PORT")
            .and_then(|sp| sp.trim().parse::<u16>().ok())
            == Some(port)
        {
            return Some(branch);
        }
    }
    None
}

/// Best-effort recovery/sync of an ngrok tunnel that may still be running (e.g. after a
/// force-quit). Queries the local ngrok agent API (127.0.0.1:4040); if a tunnel is up it
/// restores the tracked tunnel + PID and emits a running status; if the agent is gone it
/// clears a stale tunnel. Safe to call repeatedly.
pub fn reconcile_ngrok(app: &AppHandle) {
    let state = app.state::<SharedState>();

    let output = Command::new("curl")
        .args(["-s", "--max-time", "2", "http://127.0.0.1:4040/api/tunnels"])
        .env("PATH", crate::shell::user_path())
        .output();

    let body = match output {
        Ok(o) if o.status.success() && !o.stdout.is_empty() => o.stdout,
        _ => {
            clear_stale_tunnel(app, &state);
            return;
        }
    };

    let parsed: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return,
    };
    let tunnel = parsed
        .get("tunnels")
        .and_then(|t| t.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|t| {
                    t.get("public_url")
                        .and_then(|u| u.as_str())
                        .map(|u| u.starts_with("https"))
                        .unwrap_or(false)
                })
                .or_else(|| arr.first())
        });

    let tunnel = match tunnel {
        Some(t) => t,
        None => {
            clear_stale_tunnel(app, &state);
            return;
        }
    };

    let public_url = tunnel
        .get("public_url")
        .and_then(|u| u.as_str())
        .unwrap_or("")
        .to_string();
    if public_url.is_empty() {
        return;
    }

    // Already tracking this exact tunnel — nothing to update.
    {
        let s = state.lock().unwrap();
        if s.ngrok_tunnel.as_ref().map(|t| t.public_url == public_url).unwrap_or(false) {
            return;
        }
    }

    let local_port: u16 = tunnel
        .get("config")
        .and_then(|c| c.get("addr"))
        .and_then(|a| a.as_str())
        .and_then(|addr| addr.rsplit(':').next())
        .and_then(|p| p.trim().parse().ok())
        .unwrap_or(0);

    let project_path = { state.lock().unwrap().settings.project_path.clone() };
    let branch_name = project_path
        .as_deref()
        .map(Path::new)
        .and_then(|repo| find_branch_by_server_port(repo, local_port))
        .unwrap_or_default();

    let pid = pgrep_first("ngrok");

    {
        let mut s = state.lock().unwrap();
        s.ngrok_pid = pid;
        s.ngrok_tunnel = Some(NgrokTunnel {
            branch_name: branch_name.clone(),
            port: local_port,
            public_url: public_url.clone(),
        });
    }

    let _ = app.emit(
        "ngrok:status",
        serde_json::json!({
            "branchName": branch_name,
            "phase": "running",
            "publicUrl": public_url,
            "port": local_port,
        }),
    );
}

/// Drop a tunnel we were tracking once the agent is no longer reachable.
fn clear_stale_tunnel(app: &AppHandle, state: &State<'_, SharedState>) {
    let had = {
        let mut s = state.lock().unwrap();
        s.ngrok_pid = None;
        s.ngrok_tunnel.take().is_some()
    };
    if had {
        let _ = app.emit("ngrok:status", serde_json::json!({ "phase": "stopped" }));
    }
}

#[cfg(test)]
mod tests {
    use super::extract_public_url;

    #[test]
    fn parses_started_tunnel_line() {
        let line = "t=2026-05-12T11:05:24+0800 lvl=info msg=\"started tunnel\" obj=tunnels name=command_line addr=http://localhost:5103 url=https://a988-156-0-200-137.ngrok-free.app";
        assert_eq!(
            extract_public_url(line).as_deref(),
            Some("https://a988-156-0-200-137.ngrok-free.app")
        );
    }

    #[test]
    fn ignores_unrelated_lines() {
        assert_eq!(extract_public_url("lvl=info msg=\"client session established\""), None);
        assert_eq!(extract_public_url("update available"), None);
    }

    #[test]
    fn ignores_lines_without_url_field() {
        let line = "msg=\"started tunnel\" obj=tunnels name=foo";
        assert_eq!(extract_public_url(line), None);
    }
}
