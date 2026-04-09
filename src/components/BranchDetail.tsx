import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Branch, DevCategory, WorktreeEnvOverrides, WorktreeDbInfo } from "../lib/types";
import { DEV_CATEGORIES } from "../lib/types";
import { StatusBadge } from "./StatusBadge";
import { CategoryPicker } from "./CategoryPicker";
import { startBranch, stopBranch, getBranchLogs, removeBranch, openInVscode, openInTerminal, killBranchPorts, getWorktreeEnv, updateWorktreeEnv, listWorktreeDbInfo, previewUrl } from "../lib/commands";
import { AnsiLine } from "./AnsiLine";

interface BranchDetailProps {
  branch: Branch;
  devCategory: DevCategory;
  onCategoryChange: (cat: DevCategory) => void;
  onBack: () => void;
  onRefresh: () => void;
}

export function BranchDetail({
  branch,
  devCategory,
  onCategoryChange,
  onBack,
  onRefresh,
}: BranchDetailProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [killing, setKilling] = useState(false);
  const [killResult, setKillResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);

  const env = branch.environment;
  const status = env?.status ?? "stopped";
  const port = env?.port;
  const backendPort = env?.backendPort;
  const socketPort = env?.socketPort;
  const dbName = env?.databaseName;
  const worktreePath = env?.worktreePath;

  // Env overrides editing
  const [envOverrides, setEnvOverrides] = useState<WorktreeEnvOverrides | null>(null);
  const [envDraft, setEnvDraft] = useState<WorktreeEnvOverrides | null>(null);
  const [envExpanded, setEnvExpanded] = useState(false);
  const [envSaving, setEnvSaving] = useState(false);
  const [envError, setEnvError] = useState<string | null>(null);
  const [envDirty, setEnvDirty] = useState(false);
  const [dbInfos, setDbInfos] = useState<WorktreeDbInfo[]>([]);

  // Load env overrides when expanded
  useEffect(() => {
    if (!envExpanded) return;
    getWorktreeEnv(branch.name).then((data) => {
      setEnvOverrides(data);
      setEnvDraft(data);
      setEnvDirty(false);
    }).catch((e) => setEnvError(String(e)));
    listWorktreeDbInfo().then(setDbInfos).catch(() => {});
  }, [envExpanded, branch.name]);

  function updateDraft(key: keyof WorktreeEnvOverrides, value: string) {
    setEnvDraft((prev) => prev ? { ...prev, [key]: value } : prev);
    setEnvDirty(true);
  }

  async function handleEnvSave() {
    if (!envDraft) return;
    setEnvSaving(true);
    setEnvError(null);
    try {
      await updateWorktreeEnv(branch.name, envDraft);
      setEnvOverrides(envDraft);
      setEnvDirty(false);
    } catch (e) {
      setEnvError(String(e));
    } finally {
      setEnvSaving(false);
    }
  }

  function handleEnvReset() {
    setEnvDraft(envOverrides);
    setEnvDirty(false);
  }

  // Load logs + listen for new ones
  useEffect(() => {
    getBranchLogs(branch.name).then(setLogs).catch(console.error);

    const unlisten = listen<string>(`branch-log:${branch.name}`, (event) => {
      setLogs((prev) => {
        const next = [...prev, event.payload];
        return next.length > 2000 ? next.slice(-2000) : next;
      });
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [branch.name]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleScroll = () => {
    if (!logRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  };

  async function handleToggle() {
    setLoading(true);
    setError(null);
    try {
      if (status === "running" || status === "building") {
        await stopBranch(branch.name);
      } else {
        await startBranch(branch.name);
      }
      onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      await removeBranch(branch.name);
      onRefresh();
      onBack();
    } catch (e) {
      setError(String(e));
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  const hasWorktree = !!(worktreePath || branch.worktreePath);
  const catInfo = DEV_CATEGORIES[devCategory];
  const isRunning = status === "running" || status === "building";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "var(--toolbar-bg)",
        }}
      >
        <button
          onClick={onBack}
          style={{
            padding: "4px 8px",
            background: "var(--bg-card)",
            color: "var(--text-secondary)",
            borderRadius: 6,
            fontSize: 12,
            border: "1px solid var(--border)",
            transition: "all 0.15s",
          }}
        >
          {"\u2190"} Back
        </button>
        <span style={{ fontWeight: 700, fontSize: 14, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6 }}>
          {branch.name}
          {branch.managed && (
            <span
              style={{
                fontSize: 9,
                color: "var(--accent)",
                fontWeight: 500,
                background: "var(--accent-dim)",
                padding: "1px 5px",
                borderRadius: 4,
                flexShrink: 0,
              }}
            >
              managed
            </span>
          )}
        </span>
        <button
          onClick={handleToggle}
          disabled={loading}
          style={{
            padding: "4px 12px",
            background: isRunning
              ? "rgba(248, 113, 113, 0.12)"
              : "var(--accent-dim)",
            color: isRunning
              ? "var(--status-error)"
              : "var(--accent)",
            borderRadius: 6,
            fontSize: 12,
            opacity: loading ? 0.5 : 1,
            transition: "all 0.15s",
          }}
        >
          {loading
            ? "..."
            : isRunning
              ? "Stop"
              : "Start"}
        </button>
        {hasWorktree && (
          <button
            onClick={() => {
              const wt = worktreePath ?? branch.worktreePath;
              if (wt) openInTerminal(wt);
            }}
            style={{
              padding: "4px 12px",
              background: "var(--accent-dim)",
              color: "var(--accent)",
              borderRadius: 6,
              fontSize: 12,
              transition: "all 0.15s",
            }}
          >
            Terminal
          </button>
        )}
        {hasWorktree && (
          <button
            onClick={() => {
              const wt = worktreePath ?? branch.worktreePath;
              if (wt) openInVscode(wt);
            }}
            style={{
              padding: "4px 12px",
              background: "var(--accent-dim)",
              color: "var(--accent)",
              borderRadius: 6,
              fontSize: 12,
              transition: "all 0.15s",
            }}
          >
            VS Code
          </button>
        )}
        {status === "running" && port && (
          <button
            onClick={() => window.open(previewUrl(branch.name, port), "_blank")}
            style={{
              padding: "4px 12px",
              background: "var(--accent-dim)",
              color: "var(--accent)",
              borderRadius: 6,
              fontSize: 12,
              transition: "all 0.15s",
            }}
          >
            Preview
          </button>
        )}
        {hasWorktree && (
          <button
            onClick={async () => {
              setKilling(true);
              setKillResult(null);
              try {
                const result = await killBranchPorts(branch.name);
                setKillResult(result);
              } catch (e) {
                setError(String(e));
              } finally {
                setKilling(false);
              }
            }}
            disabled={killing}
            style={{
              padding: "4px 12px",
              background: "rgba(251, 191, 36, 0.12)",
              color: "var(--status-building)",
              borderRadius: 6,
              fontSize: 12,
              opacity: killing ? 0.5 : 1,
              transition: "all 0.15s",
            }}
          >
            {killing ? "..." : "Kill Ports"}
          </button>
        )}
        {hasWorktree && (
          confirmDelete ? (
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "var(--status-error)" }}>Delete?</span>
              <button
                onClick={handleDelete}
                disabled={deleting}
                style={{
                  padding: "4px 8px",
                  background: "var(--status-error)",
                  color: "#fff",
                  borderRadius: 6,
                  fontSize: 11,
                  opacity: deleting ? 0.5 : 1,
                  transition: "all 0.15s",
                }}
              >
                {deleting ? "..." : "Yes"}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                style={{
                  padding: "4px 8px",
                  background: "var(--bg-card)",
                  color: "var(--text-secondary)",
                  borderRadius: 6,
                  fontSize: 11,
                  border: "1px solid var(--border)",
                  transition: "all 0.15s",
                }}
              >
                No
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              style={{
                padding: "4px 8px",
                background: "rgba(248, 113, 113, 0.12)",
                color: "var(--status-error)",
                borderRadius: 6,
                fontSize: 12,
                transition: "all 0.15s",
              }}
            >
              Delete
            </button>
          )
        )}
      </div>

      {/* Scrollable info + env config region */}
      <div
        style={{
          maxHeight: "45vh",
          overflowY: "auto",
          flexShrink: 0,
          borderBottom: "1px solid var(--border)",
        }}
      >
      {/* Info panel */}
      <div
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid var(--border)",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "8px 16px",
          fontSize: 12,
          background: "var(--bg-card)",
        }}
      >
        {/* Status */}
        <div>
          <div style={{ color: "var(--text-secondary)", fontSize: 10, marginBottom: 2 }}>Status</div>
          <StatusBadge status={status} />
        </div>

        {/* Category */}
        <div>
          <div style={{ color: "var(--text-secondary)", fontSize: 10, marginBottom: 2 }}>Category</div>
          <CategoryPicker value={devCategory} onChange={onCategoryChange} />
        </div>

        {/* Database */}
        <div>
          <div style={{ color: "var(--text-secondary)", fontSize: 10, marginBottom: 2 }}>Database</div>
          <span style={{ color: dbName ? catInfo.color : "var(--text-secondary)", fontFamily: "'SF Mono', monospace", fontSize: 11 }}>
            {dbName ?? "\u2014"}
          </span>
        </div>

        {/* Ports */}
        <div>
          <div style={{ color: "var(--text-secondary)", fontSize: 10, marginBottom: 2 }}>Ports</div>
          {port || backendPort ? (
            <span style={{ fontFamily: "'SF Mono', monospace", fontSize: 11 }}>
              {backendPort && (
                <span style={{ color: "var(--text-primary)" }}>
                  Backend :{backendPort}
                </span>
              )}
              {backendPort && socketPort && <span style={{ color: "var(--text-secondary)" }}> / </span>}
              {socketPort && (
                <span style={{ color: "var(--text-primary)" }}>
                  Socket :{socketPort}
                </span>
              )}
              {(backendPort || socketPort) && port && <span style={{ color: "var(--text-secondary)" }}> / </span>}
              {port && (
                <span style={{ color: "var(--accent)" }}>
                  Frontend :{port}
                </span>
              )}
            </span>
          ) : (
            <span style={{ color: "var(--text-secondary)" }}>{"\u2014"}</span>
          )}
        </div>

        {/* Source */}
        <div>
          <div style={{ color: "var(--text-secondary)", fontSize: 10, marginBottom: 2 }}>Source</div>
          <span style={{
            fontSize: 11,
            color: branch.managed ? "var(--accent)" : "var(--text-secondary)",
            fontWeight: 500,
          }}>
            {branch.managed ? "TeaBranch" : "External"}
          </span>
        </div>

        {/* Worktree path */}
        <div style={{ gridColumn: "1 / -1" }}>
          <div style={{ color: "var(--text-secondary)", fontSize: 10, marginBottom: 2 }}>Worktree</div>
          <span style={{ color: "var(--text-primary)", fontFamily: "'SF Mono', monospace", fontSize: 11, wordBreak: "break-all" }}>
            {worktreePath ?? branch.worktreePath ?? "\u2014"}
          </span>
        </div>
      </div>

      {/* Env Config Panel */}
      <div>
        <button
          onClick={() => setEnvExpanded(!envExpanded)}
          style={{
            width: "100%",
            padding: "8px 12px",
            background: "none",
            border: "none",
            color: "var(--text-secondary)",
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
            textAlign: "left",
          }}
        >
          <span style={{
            display: "inline-block",
            transition: "transform 0.15s",
            transform: envExpanded ? "rotate(90deg)" : "rotate(0deg)",
            fontSize: 10,
          }}>
            {"\u25B6"}
          </span>
          Environment Overrides
          {envDirty && (
            <span style={{ color: "var(--status-building)", fontSize: 9, marginLeft: 4 }}>
              (unsaved)
            </span>
          )}
        </button>

        {envExpanded && envDraft && (
          <div style={{ padding: "0 12px 10px 12px" }}>
            <EnvField label="PORT" value={envDraft.port} onChange={(v) => updateDraft("port", v)} />
            <EnvField label="SOCKET_PORT" value={envDraft.socketPort} onChange={(v) => updateDraft("socketPort", v)} />
            <EnvField label="SERVER_PORT" value={envDraft.serverPort} onChange={(v) => updateDraft("serverPort", v)} />
            <EnvField label="PUBLIC_ORIGIN" value={envDraft.publicOrigin} onChange={(v) => updateDraft("publicOrigin", v)} />
            <EnvField label="STORAGE_PREFIX" value={envDraft.storagePrefix} onChange={(v) => updateDraft("storagePrefix", v)} />

            {/* PRISMA_DATABASE_URL with dropdown */}
            <div style={{ marginBottom: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                <span style={{ color: "var(--text-secondary)", fontSize: 10, fontFamily: "'SF Mono', monospace" }}>
                  PRISMA_DATABASE_URL
                </span>
                {dbInfos.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) {
                        updateDraft("prismaDatabaseUrl", e.target.value);
                      }
                    }}
                    style={{
                      padding: "1px 4px",
                      background: "var(--bg-card)",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      color: "var(--accent)",
                      fontSize: 9,
                      cursor: "pointer",
                    }}
                  >
                    <option value="">{"\u9009\u62E9\u5DF2\u6709\u5B9E\u4F8B..."}</option>
                    {dbInfos
                      .filter((i) => i.databaseUrl)
                      .map((info) => (
                        <option key={info.branchName} value={info.databaseUrl!}>
                          {info.branchName} ({info.databaseName})
                        </option>
                      ))}
                  </select>
                )}
              </div>
              <input
                value={envDraft.prismaDatabaseUrl ?? ""}
                onChange={(e) => updateDraft("prismaDatabaseUrl", e.target.value)}
                style={{
                  width: "100%",
                  padding: "4px 6px",
                  background: "var(--bg-card)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  color: "var(--text-primary)",
                  fontSize: 11,
                  fontFamily: "'SF Mono', monospace",
                  outline: "none",
                  boxSizing: "border-box",
                  transition: "border-color 0.15s, box-shadow 0.15s",
                }}
              />
            </div>

            <EnvField label="PUBLIC_DATABASE_PROXY" value={envDraft.publicDatabaseProxy} onChange={(v) => updateDraft("publicDatabaseProxy", v)} />

            {/* BACKEND_CACHE_REDIS_URI with dropdown */}
            <div style={{ marginBottom: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                <span style={{ color: "var(--text-secondary)", fontSize: 10, fontFamily: "'SF Mono', monospace" }}>
                  BACKEND_CACHE_REDIS_URI
                </span>
                {dbInfos.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) {
                        updateDraft("backendCacheRedisUri", e.target.value);
                      }
                    }}
                    style={{
                      padding: "1px 4px",
                      background: "var(--bg-card)",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      color: "var(--accent)",
                      fontSize: 9,
                      cursor: "pointer",
                    }}
                  >
                    <option value="">{"\u9009\u62E9\u5DF2\u6709\u5B9E\u4F8B..."}</option>
                    {dbInfos
                      .filter((i) => i.redisUri)
                      .map((info) => (
                        <option key={info.branchName} value={info.redisUri!}>
                          {info.branchName} ({info.redisUri})
                        </option>
                      ))}
                  </select>
                )}
              </div>
              <input
                value={envDraft.backendCacheRedisUri ?? ""}
                onChange={(e) => updateDraft("backendCacheRedisUri", e.target.value)}
                style={{
                  width: "100%",
                  padding: "4px 6px",
                  background: "var(--bg-card)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  color: "var(--text-primary)",
                  fontSize: 11,
                  fontFamily: "'SF Mono', monospace",
                  outline: "none",
                  boxSizing: "border-box",
                  transition: "border-color 0.15s, box-shadow 0.15s",
                }}
              />
            </div>

            {/* Save / Reset buttons */}
            {envError && (
              <div style={{ fontSize: 10, color: "var(--status-error)", marginBottom: 6 }}>{envError}</div>
            )}
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 8 }}>
              <button
                onClick={handleEnvReset}
                disabled={!envDirty}
                style={{
                  padding: "4px 10px",
                  background: "var(--bg-card)",
                  color: "var(--text-secondary)",
                  borderRadius: 6,
                  fontSize: 11,
                  border: "1px solid var(--border)",
                  cursor: envDirty ? "pointer" : "default",
                  opacity: envDirty ? 1 : 0.4,
                  transition: "all 0.15s",
                }}
              >
                Reset
              </button>
              <button
                onClick={handleEnvSave}
                disabled={!envDirty || envSaving}
                style={{
                  padding: "4px 10px",
                  background: envDirty ? "var(--accent)" : "var(--bg-card)",
                  color: envDirty ? "var(--accent-on)" : "var(--text-secondary)",
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 600,
                  border: "none",
                  cursor: envDirty ? "pointer" : "default",
                  opacity: envDirty ? 1 : 0.4,
                  transition: "all 0.15s",
                }}
              >
                {envSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        )}

        {envExpanded && !envDraft && !envError && (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-secondary)" }}>
            Loading...
          </div>
        )}
      </div>
      </div>{/* end scrollable info + env config region */}

      {/* Error */}
      {error && (
        <div style={{ padding: "6px 12px", background: "rgba(248, 113, 113, 0.12)", color: "var(--status-error)", fontSize: 11, borderBottom: "1px solid rgba(248, 113, 113, 0.2)" }}>
          {error}
        </div>
      )}
      {killResult && (
        <div style={{ padding: "6px 12px", background: "rgba(251, 191, 36, 0.12)", color: "var(--status-building)", fontSize: 11, borderBottom: "1px solid rgba(251, 191, 36, 0.2)" }}>
          {killResult}
        </div>
      )}

      {/* Logs header */}
      <div
        style={{
          padding: "6px 12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--border)",
          background: "var(--toolbar-bg)",
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)" }}>
          Logs
          <span style={{ fontWeight: 400, marginLeft: 6, fontSize: 10, opacity: 0.7 }}>
            ({logs.length} lines)
          </span>
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            style={{
              padding: "2px 6px",
              fontSize: 10,
              borderRadius: 4,
              background: autoScroll ? "var(--accent-dim)" : "var(--bg-card)",
              color: autoScroll ? "var(--accent)" : "var(--text-secondary)",
              border: "1px solid var(--border)",
              transition: "all 0.15s",
            }}
          >
            Auto-scroll {autoScroll ? "ON" : "OFF"}
          </button>
          <button
            onClick={() => setLogs([])}
            style={{
              padding: "2px 6px",
              fontSize: 10,
              borderRadius: 4,
              background: "var(--bg-card)",
              color: "var(--text-secondary)",
              border: "1px solid var(--border)",
              transition: "all 0.15s",
            }}
          >
            Clear
          </button>
        </div>
      </div>

      {/* Log output */}
      <div
        ref={logRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: "auto",
          background: "var(--log-bg)",
          padding: "8px 10px",
          fontFamily: "'SF Mono', 'Fira Code', monospace",
          fontSize: 11,
          lineHeight: 1.6,
          color: "var(--log-text)",
          minHeight: 0,
          userSelect: "text",
          WebkitUserSelect: "text",
          cursor: "text",
        }}
      >
        {logs.length === 0 ? (
          <div style={{ color: "var(--log-text-dim)", textAlign: "center", padding: 24 }}>
            {status === "stopped" ? "Start the branch to see logs" : "Waiting for output..."}
          </div>
        ) : (
          logs.map((line, i) => (
            <div
              key={i}
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                color: line.includes("[backend]")
                  ? "var(--log-backend)"
                  : line.includes("[frontend]")
                    ? "var(--log-frontend)"
                    : line.includes("error") || line.includes("Error")
                      ? "var(--log-error)"
                      : "var(--log-text)",
              }}
            >
              <AnsiLine text={line} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Reusable env field row */
function EnvField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ color: "var(--text-secondary)", fontSize: 10, fontFamily: "'SF Mono', monospace", marginBottom: 3 }}>
        {label}
      </div>
      <input
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          padding: "4px 6px",
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          color: "var(--text-primary)",
          fontSize: 11,
          fontFamily: "'SF Mono', monospace",
          outline: "none",
          boxSizing: "border-box",
          transition: "border-color 0.15s, box-shadow 0.15s",
        }}
      />
    </div>
  );
}
