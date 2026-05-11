import { invoke } from "@tauri-apps/api/core";
import type { Branch, BranchEnvironment, AppSettings, DbModeType, WorktreeDbInfo, WorktreeEnvOverrides, NgrokTunnel } from "./types";

export async function listBranches(): Promise<Branch[]> {
  return invoke("list_branches");
}

export async function getEnvironments(): Promise<BranchEnvironment[]> {
  return invoke("get_environments");
}

export async function startBranch(branchName: string): Promise<void> {
  return invoke("start_branch", { branchName });
}

export async function stopBranch(branchName: string): Promise<void> {
  return invoke("stop_branch", { branchName });
}

export async function removeBranch(branchName: string): Promise<void> {
  return invoke("remove_worktree", { branchName });
}

export async function getBranchLogs(branchName: string): Promise<string[]> {
  return invoke("get_branch_logs", { branchName });
}

export async function getSettings(): Promise<AppSettings> {
  return invoke("get_settings");
}

export async function setProjectPath(path: string): Promise<void> {
  return invoke("set_project_path", { path });
}

export async function openPreviewWindow(branches: string[]): Promise<void> {
  return invoke("open_preview_window", { branches });
}

export async function createWorktree(
  branchName: string,
  dbMode?: DbModeType,
  sourceBranch?: string,
): Promise<void> {
  return invoke("create_worktree", { branchName, dbMode, sourceBranch });
}

export async function listWorktreeDbInfo(): Promise<WorktreeDbInfo[]> {
  return invoke("list_worktree_db_info");
}

export async function getWorktreeEnv(branchName: string): Promise<WorktreeEnvOverrides> {
  return invoke("get_worktree_env", { branchName });
}

export async function updateWorktreeEnv(branchName: string, overrides: WorktreeEnvOverrides): Promise<void> {
  return invoke("update_worktree_env", { branchName, overrides });
}

export async function updateSettings(terminalApp: string | null): Promise<void> {
  return invoke("update_settings", { terminalApp });
}

export async function openInVscode(path: string): Promise<void> {
  return invoke("open_in_vscode", { path });
}

export async function openInTerminal(path: string): Promise<void> {
  return invoke("open_in_terminal", { path });
}

export async function startNgrok(branchName: string): Promise<NgrokTunnel> {
  return invoke("start_ngrok", { branchName });
}

export async function stopNgrok(): Promise<void> {
  return invoke("stop_ngrok");
}

export async function getNgrokStatus(): Promise<NgrokTunnel | null> {
  return invoke("get_ngrok_status");
}

/** Generate a preview URL using *.localhost subdomain for cookie isolation. */
export function previewUrl(branchName: string, port: number): string {
  const slug = branchName
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return `http://${slug}.localhost:${port}`;
}
