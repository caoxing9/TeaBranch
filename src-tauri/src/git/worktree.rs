use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

use crate::process::manager;

/// Emit a progress event for worktree creation
fn emit_progress(app: &AppHandle, branch: &str, step: &str, message: &str, done: bool) {
    let _ = app.emit(
        &format!("worktree-progress:{}", branch),
        serde_json::json!({ "step": step, "message": message, "done": done }),
    );
}

/// Auto-assign a worktree slot by scanning sibling worktree env files for WORKTREE_SLOT markers
fn assign_slot(repo_path: &Path) -> u32 {
    let repo_name = repo_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("repo");
    let worktree_base = repo_path
        .parent()
        .map(|p| p.join(format!("{}-worktree", repo_name)))
        .unwrap_or_default();

    let mut max_slot: u32 = 0;

    // Also scan the main repo env
    let scan_dirs: Vec<PathBuf> = {
        let mut dirs = vec![repo_path.to_path_buf()];
        if worktree_base.exists() {
            if let Ok(entries) = std::fs::read_dir(&worktree_base) {
                for entry in entries.flatten() {
                    if entry.path().is_dir() {
                        dirs.push(entry.path());
                    }
                }
            }
        }
        dirs
    };

    for dir in &scan_dirs {
        let env_path = dir.join("enterprise/app-ee/.env.development.local");
        if let Ok(content) = std::fs::read_to_string(&env_path) {
            for line in content.lines() {
                if let Some(slot_str) = line.strip_prefix("# WORKTREE_SLOT=") {
                    if let Ok(s) = slot_str.trim().parse::<u32>() {
                        if s > max_slot {
                            max_slot = s;
                        }
                    }
                }
            }
        }
    }

    max_slot + 1
}

/// Read the base .env.development.local (or .env.development) from the main repo,
/// then override port/DB/Redis keys for an isolated worktree.
fn generate_env_file(
    repo_path: &Path,
    worktree_path: &Path,
    slot: u32,
    db_name: &str,
) -> Result<(), String> {
    let port = 3000 + slot * 100;
    let socket_port = port + 1;
    let server_port = port + 3;
    let redis_db = slot;

    // Try to read existing env from main repo
    let env_local = repo_path.join("enterprise/app-ee/.env.development.local");
    let env_dev = repo_path.join("enterprise/app-ee/.env.development");

    let base_content = std::fs::read_to_string(&env_local)
        .or_else(|_| std::fs::read_to_string(&env_dev))
        .unwrap_or_default();

    // Parse base content, override specific keys
    let override_keys = [
        "PORT", "SOCKET_PORT", "SERVER_PORT", "PUBLIC_ORIGIN",
        "STORAGE_PREFIX", "PRISMA_DATABASE_URL", "PUBLIC_DATABASE_PROXY",
        "BACKEND_CACHE_REDIS_URI",
    ];

    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("# WORKTREE_SLOT={}", slot));

    // Keep non-overridden lines from base
    for line in base_content.lines() {
        let trimmed = line.trim();
        // Skip existing slot marker
        if trimmed.starts_with("# WORKTREE_SLOT=") {
            continue;
        }
        // Check if this line sets one of our override keys
        let is_override = override_keys.iter().any(|key| {
            trimmed.starts_with(&format!("{}=", key))
        });
        if !is_override {
            lines.push(line.to_string());
        }
    }

    // Read base DB URL to derive the branch-specific one
    let base_db_url = manager::read_base_database_url(repo_path)
        .unwrap_or_else(|| format!(
            "postgresql://teable:teable@127.0.0.1:5432/{}?schema=public&statement_cache_size=1",
            db_name
        ));
    let branch_db_url = manager::replace_db_name(&base_db_url, db_name);

    // Append overridden values
    lines.push(String::new());
    lines.push("# ---- BranchPilot overrides ----".to_string());
    lines.push(format!("PORT={}", port));
    lines.push(format!("SOCKET_PORT={}", socket_port));
    lines.push(format!("SERVER_PORT={}", server_port));
    lines.push(format!("PUBLIC_ORIGIN=http://127.0.0.1:{}", port));
    lines.push(format!("STORAGE_PREFIX=http://127.0.0.1:{}", port));
    lines.push(format!("PRISMA_DATABASE_URL={}", branch_db_url));
    lines.push("PUBLIC_DATABASE_PROXY=127.0.0.1:5432".to_string());
    lines.push(format!("BACKEND_CACHE_REDIS_URI=redis://:teable@127.0.0.1:6379/{}", redis_db));

    let output_path = worktree_path.join("enterprise/app-ee/.env.development.local");
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create env dir: {}", e))?;
    }
    std::fs::write(&output_path, lines.join("\n"))
        .map_err(|e| format!("Failed to write .env.development.local: {}", e))?;

    Ok(())
}

/// Full worktree creation matching the `wt` shell workflow:
/// fetch develop → create branch → sibling worktree → env → install deps → migrate DB
pub fn create_worktree_full(
    app: &AppHandle,
    repo_path: &Path,
    branch_name: &str,
) -> Result<PathBuf, String> {
    let repo_name = repo_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("repo");
    let repo_parent = repo_path
        .parent()
        .ok_or("Cannot determine repo parent directory")?;
    let worktree_base = repo_parent.join(format!("{}-worktree", repo_name));
    let safe_name = branch_name.replace('/', "-");
    let worktree_path = worktree_base.join(&safe_name);

    if worktree_path.exists() {
        return Ok(worktree_path);
    }

    // Ensure worktree base directory exists
    std::fs::create_dir_all(&worktree_base)
        .map_err(|e| format!("Failed to create worktree base dir: {}", e))?;

    // Step 1: Fetch origin/develop
    emit_progress(app, branch_name, "fetch", "Fetching origin/develop...", false);
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["fetch", "origin", "develop"])
        .output()
        .map_err(|e| format!("Failed to run git fetch: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git fetch failed: {}", stderr));
    }

    // Step 2: Create worktree with new branch from origin/develop
    emit_progress(app, branch_name, "branch", &format!("Creating branch {}...", branch_name), false);
    let output = Command::new("git")
        .current_dir(repo_path)
        .args([
            "worktree", "add", "-b", branch_name,
            worktree_path.to_str().unwrap(),
            "origin/develop", "--no-track",
        ])
        .output()
        .map_err(|e| format!("Failed to run git worktree add: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // If branch already exists, try without -b
        if stderr.contains("already exists") {
            let output2 = Command::new("git")
                .current_dir(repo_path)
                .args([
                    "worktree", "add",
                    worktree_path.to_str().unwrap(),
                    branch_name,
                ])
                .output()
                .map_err(|e| format!("Failed to run git worktree add: {}", e))?;
            if !output2.status.success() {
                let stderr2 = String::from_utf8_lossy(&output2.stderr);
                return Err(format!("git worktree add failed: {}", stderr2));
            }
        } else {
            return Err(format!("git worktree add failed: {}", stderr));
        }
    }

    // Step 3: Generate .env.development.local
    emit_progress(app, branch_name, "env", "Setting up environment...", false);
    let slot = assign_slot(repo_path);
    let db_name = format!("teable_wt{}", slot);
    generate_env_file(repo_path, &worktree_path, slot, &db_name)?;

    // Step 4: Install dependencies
    emit_progress(app, branch_name, "install", "Installing dependencies (pnpm install)...", false);
    let output = Command::new("pnpm")
        .args(["install"])
        .current_dir(&worktree_path)
        .output()
        .map_err(|e| format!("Failed to run pnpm install: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("pnpm install failed: {}", stderr));
    }

    // Step 5: Database setup - ensure docker services and create DB
    emit_progress(app, branch_name, "database", "Setting up database...", false);
    if let Some(base_url) = manager::read_base_database_url(&worktree_path) {
        match manager::ensure_branch_database(&base_url, &format!("wt{}", slot)) {
            Ok(url) => {
                eprintln!("[BranchPilot] Created database with URL: {}", url);
            }
            Err(e) => {
                eprintln!("[BranchPilot] Warning: database creation failed: {}. Will try migration anyway.", e);
            }
        }
    }

    // Step 6: Run migration
    emit_progress(app, branch_name, "migrate", "Running database migration (make postgres.mode)...", false);
    let output = Command::new("make")
        .args(["postgres.mode"])
        .current_dir(&worktree_path)
        .output()
        .map_err(|e| format!("Failed to run make postgres.mode: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("[BranchPilot] Warning: migration may have failed: {}", stderr);
        // Don't fail the whole flow - migration might work later
    }

    emit_progress(app, branch_name, "done", "Worktree ready!", true);
    Ok(worktree_path)
}

pub fn remove_worktree(repo_path: &Path, branch_name: &str) -> Result<(), String> {
    // Try sibling worktree directory first
    let repo_name = repo_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("repo");
    let safe_name = branch_name.replace('/', "-");

    let worktree_paths = [
        // New location: sibling worktree dir
        repo_path
            .parent()
            .map(|p| p.join(format!("{}-worktree", repo_name)).join(&safe_name)),
        // Legacy location: .worktrees subdirectory
        Some(repo_path.join(".worktrees").join(&safe_name)),
    ];

    for path_opt in &worktree_paths {
        if let Some(path) = path_opt {
            if path.exists() {
                let output = Command::new("git")
                    .current_dir(repo_path)
                    .args(["worktree", "remove", "--force", path.to_str().unwrap()])
                    .output()
                    .map_err(|e| format!("Failed to run git worktree remove: {}", e))?;

                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    return Err(format!("git worktree remove failed: {}", stderr));
                }
                return Ok(());
            }
        }
    }

    // Fallback: find worktree path from `git worktree list` for externally created worktrees
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| format!("Failed to run git worktree list: {}", e))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut current_path: Option<String> = None;

        for line in stdout.lines() {
            if let Some(path) = line.strip_prefix("worktree ") {
                current_path = Some(path.to_string());
            } else if let Some(branch_ref) = line.strip_prefix("branch ") {
                let short_name = branch_ref.strip_prefix("refs/heads/").unwrap_or(branch_ref);
                if short_name == branch_name {
                    if let Some(path) = current_path.take() {
                        let output = Command::new("git")
                            .current_dir(repo_path)
                            .args(["worktree", "remove", "--force", &path])
                            .output()
                            .map_err(|e| format!("Failed to run git worktree remove: {}", e))?;

                        if !output.status.success() {
                            let stderr = String::from_utf8_lossy(&output.stderr);
                            return Err(format!("git worktree remove failed: {}", stderr));
                        }
                        return Ok(());
                    }
                }
            }
            if line.is_empty() {
                current_path = None;
            }
        }
    }

    Ok(())
}
