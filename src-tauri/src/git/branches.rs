use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use crate::state::{Branch, BranchEnvironment};

/// Check if a worktree path is managed by BranchPilot.
/// Managed worktrees live under `<repo>-worktree/` sibling directory
/// and/or have a `# WORKTREE_SLOT=` marker in their env files.
fn is_managed_worktree(repo_path: &Path, worktree_path: &Path) -> bool {
    // Check 1: path is under the `<repo>-worktree/` sibling directory
    let repo_name = repo_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    if let Some(parent) = repo_path.parent() {
        let managed_base = parent.join(format!("{}-worktree", repo_name));
        if worktree_path.starts_with(&managed_base) {
            return true;
        }
    }

    // Check 2: env file contains WORKTREE_SLOT marker
    let env_paths = [
        worktree_path.join("enterprise/app-ee/.env.development.local"),
        worktree_path.join(".env.development.local"),
    ];
    for env_path in &env_paths {
        if let Ok(content) = std::fs::read_to_string(env_path) {
            if content.contains("# WORKTREE_SLOT=") || content.contains("# ---- BranchPilot overrides ----") {
                return true;
            }
        }
    }

    false
}

pub fn list_local_branches(
    repo_path: &Path,
    environments: &HashMap<String, BranchEnvironment>,
) -> Result<Vec<Branch>, String> {
    // Use `git worktree list --porcelain` to get only branches with worktrees
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| format!("Failed to run git worktree list: {}", e))?;

    if !output.status.success() {
        return Err("git worktree list failed".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Get current branch of this worktree
    let head_output = Command::new("git")
        .current_dir(repo_path)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()
        .and_then(|o| if o.status.success() {
            Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
        } else {
            None
        });

    let mut result = Vec::new();
    let mut current_branch: Option<String> = None;
    let mut current_worktree_path: Option<String> = None;

    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            current_worktree_path = Some(path.to_string());
        } else if let Some(branch_ref) = line.strip_prefix("branch ") {
            let name = branch_ref
                .strip_prefix("refs/heads/")
                .unwrap_or(branch_ref)
                .to_string();
            current_branch = Some(name);
        } else if line.is_empty() {
            // End of a worktree entry
            if let Some(name) = current_branch.take() {
                let wt_path = current_worktree_path.take();
                let is_current = head_output.as_deref() == Some(&name);
                let environment = environments.get(&name).cloned();

                let managed = wt_path
                    .as_ref()
                    .map(|p| is_managed_worktree(repo_path, Path::new(p)))
                    .unwrap_or(false);

                result.push(Branch {
                    name,
                    is_current,
                    environment,
                    managed,
                    worktree_path: wt_path,
                });
            }
            current_worktree_path = None;
        }
    }
    // Handle last entry (if no trailing empty line)
    if let Some(name) = current_branch.take() {
        let wt_path = current_worktree_path.take();
        let is_current = head_output.as_deref() == Some(&name);
        let environment = environments.get(&name).cloned();

        let managed = wt_path
            .as_ref()
            .map(|p| is_managed_worktree(repo_path, Path::new(p)))
            .unwrap_or(false);

        result.push(Branch {
            name,
            is_current,
            environment,
            managed,
            worktree_path: wt_path,
        });
    }

    // Sort: current branch first, then alphabetically
    result.sort_by(|a, b| {
        if a.is_current && !b.is_current {
            std::cmp::Ordering::Less
        } else if !a.is_current && b.is_current {
            std::cmp::Ordering::Greater
        } else {
            a.name.cmp(&b.name)
        }
    });

    Ok(result)
}
