export type BranchStatus = "running" | "stopped" | "building" | "error";

export type DevCategory = "developing" | "todo" | "done";

export const DEV_CATEGORIES: Record<DevCategory, { label: string; color: string }> = {
  developing: { label: "开发中", color: "#ffc107" },
  todo: { label: "待开发", color: "#8892b0" },
  done: { label: "已完成", color: "#64ffda" },
};

export interface BranchEnvironment {
  branchName: string;
  worktreePath: string | null;
  port: number | null;
  backendPort: number | null;
  socketPort: number | null;
  status: BranchStatus;
  startCommand: string | null;
  databaseName: string | null;
}

export interface Branch {
  name: string;
  isCurrent: boolean;
  environment: BranchEnvironment | null;
  /** Whether this worktree was created/managed by BranchPilot */
  managed: boolean;
  /** Filesystem path of the worktree */
  worktreePath: string | null;
}

export interface AppSettings {
  projectPath: string | null;
  basePort: number;
  defaultStartCommand: string;
}

export interface WorktreeProgress {
  step: string;
  message: string;
  done: boolean;
}
