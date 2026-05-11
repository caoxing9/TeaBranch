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
  /** Whether this worktree was created/managed by TeaBranch */
  managed: boolean;
  /** Filesystem path of the worktree */
  worktreePath: string | null;
}

export interface AppSettings {
  projectPath: string | null;
  basePort: number;
  defaultStartCommand: string;
  terminalApp: string | null;
}

export interface WorktreeProgress {
  step: string;
  message: string;
  done: boolean;
}

export type DbModeType = "new" | "clone" | "reuse";

export interface WorktreeEnvOverrides {
  port: string | null;
  socketPort: string | null;
  serverPort: string | null;
  publicOrigin: string | null;
  storagePrefix: string | null;
  prismaDatabaseUrl: string | null;
  publicDatabaseProxy: string | null;
  backendCacheRedisUri: string | null;
  sandboxTeableEndpoint: string | null;
}

export interface NgrokTunnel {
  branchName: string;
  port: number;
  publicUrl: string;
}

export interface WorktreeDbInfo {
  branchName: string;
  databaseName: string | null;
  databaseUrl: string | null;
  redisUri: string | null;
}
