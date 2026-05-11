import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import type { Branch, DevCategory, WorktreeEnvOverrides, WorktreeDbInfo } from "../lib/types";
import { DEV_CATEGORIES } from "../lib/types";
import { StatusBadge } from "./StatusBadge";
import { CategoryPicker } from "./CategoryPicker";
import { startBranch, stopBranch, getBranchLogs, removeBranch, openInVscode, openInTerminal, getWorktreeEnv, updateWorktreeEnv, listWorktreeDbInfo, previewUrl, startNgrok, stopNgrok, getNgrokStatus } from "../lib/commands";
import type { NgrokTunnel } from "../lib/types";
import { LogList } from "./LogList";
import { useListRef } from "react-window";

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

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
  const [logsClearedAt, setLogsClearedAt] = useState(0); // bumped to invalidate height cache
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const [limitLogs, setLimitLogs] = useState(true);
  const limitLogsRef = useRef(true);
  const listRef = useListRef(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

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

  const [ngrok, setNgrok] = useState<NgrokTunnel | null>(null);
  const [ngrokLoading, setNgrokLoading] = useState(false);
  const [ngrokError, setNgrokError] = useState<string | null>(null);

  useEffect(() => {
    getNgrokStatus().then(setNgrok).catch(() => {});
  }, []);

  async function handleNgrokToggle() {
    setNgrokError(null);
    setNgrokLoading(true);
    try {
      if (ngrok && ngrok.branchName === branch.name) {
        await stopNgrok();
        setNgrok(null);
      } else {
        const tunnel = await startNgrok(branch.name);
        setNgrok(tunnel);
        // Refresh the env editor if it's open so the user sees the updated value.
        if (envExpanded) {
          getWorktreeEnv(branch.name).then((data) => {
            setEnvOverrides(data);
            setEnvDraft(data);
            setEnvDirty(false);
          }).catch(() => {});
        }
      }
    } catch (e) {
      setNgrokError(String(e));
    } finally {
      setNgrokLoading(false);
    }
  }

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
        return limitLogsRef.current && next.length > 2000 ? next.slice(-2000) : next;
      });
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [branch.name]);

  // Compute search matches across all log lines.
  const matches = useMemo(() => {
    const term = searchTerm.trim();
    if (!term) return [] as Array<{ line: number; local: number }>;
    const needle = term.toLowerCase();
    const out: Array<{ line: number; local: number }> = [];
    for (let i = 0; i < logs.length; i++) {
      const visible = stripAnsi(logs[i]).toLowerCase();
      let pos = 0;
      let local = 0;
      while (true) {
        const found = visible.indexOf(needle, pos);
        if (found === -1) break;
        out.push({ line: i, local });
        local += 1;
        pos = found + Math.max(needle.length, 1);
      }
    }
    return out;
  }, [logs, searchTerm]);

  // Reset active match when search results shrink past it.
  useEffect(() => {
    if (activeMatchIdx >= matches.length) setActiveMatchIdx(0);
  }, [matches.length, activeMatchIdx]);

  // Jump to first match when search term changes (and turn off auto-scroll).
  const lastSearchRef = useRef("");
  useEffect(() => {
    if (lastSearchRef.current === searchTerm) return;
    lastSearchRef.current = searchTerm;
    if (matches.length > 0) {
      setActiveMatchIdx(0);
      setAutoScroll(false);
      listRef.current?.scrollToRow({ index: matches[0].line, align: "center", behavior: "auto" });
    }
  }, [searchTerm, matches]);

  // Auto-scroll to bottom when new logs arrive (only if at bottom).
  const lastLogCountRef = useRef(0);
  useEffect(() => {
    if (logs.length === 0) {
      lastLogCountRef.current = 0;
      return;
    }
    if (autoScroll && logs.length > lastLogCountRef.current) {
      listRef.current?.scrollToRow({ index: logs.length - 1, align: "end", behavior: "auto" });
    }
    lastLogCountRef.current = logs.length;
  }, [logs.length, autoScroll]);

  // Update autoScroll based on what's visible.
  const handleRowsRendered = useCallback(
    (vis: { startIndex: number; stopIndex: number }) => {
      if (logs.length === 0) return;
      setAutoScroll(vis.stopIndex >= logs.length - 2);
    },
    [logs.length]
  );

  const goToMatch = useCallback(
    (idx: number) => {
      if (matches.length === 0) return;
      const next = ((idx % matches.length) + matches.length) % matches.length;
      setActiveMatchIdx(next);
      setAutoScroll(false);
      listRef.current?.scrollToRow({ index: matches[next].line, align: "center", behavior: "auto" });
    },
    [matches]
  );

  const handleCopyLine = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopyToast("Copied line");
      setTimeout(() => setCopyToast(null), 1200);
    }).catch(() => {});
  }, []);

  const handleCopyAll = useCallback(() => {
    const term = searchTerm.trim().toLowerCase();
    const lines = term
      ? logs.filter((l) => stripAnsi(l).toLowerCase().includes(term))
      : logs;
    const text = lines.map(stripAnsi).join("\n");
    navigator.clipboard.writeText(text).then(() => {
      setCopyToast(term ? `Copied ${lines.length} matching lines` : `Copied ${lines.length} lines`);
      setTimeout(() => setCopyToast(null), 1500);
    }).catch(() => {});
  }, [logs, searchTerm]);

  // Cmd/Ctrl+F focuses search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activeMatch = matches[activeMatchIdx];

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
            onClick={() => {
              openExternal(previewUrl(branch.name, port)).catch((e) => setError(String(e)));
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
            Preview
          </button>
        )}
        {hasWorktree && (() => {
          const isThisBranch = ngrok?.branchName === branch.name;
          const activeOnOther = ngrok && !isThisBranch;
          const label = ngrokLoading
            ? "..."
            : isThisBranch
              ? "Stop Ngrok"
              : activeOnOther
                ? `Ngrok (on ${ngrok!.branchName})`
                : "Ngrok";
          return (
            <button
              onClick={handleNgrokToggle}
              disabled={ngrokLoading}
              title={isThisBranch ? ngrok!.publicUrl : "Start ngrok tunnel for SERVER_PORT and write SANDBOX_TEABLE_ENDPOINT"}
              style={{
                padding: "4px 12px",
                background: isThisBranch ? "rgba(248, 113, 113, 0.12)" : "var(--accent-dim)",
                color: isThisBranch ? "var(--status-error)" : "var(--accent)",
                borderRadius: 6,
                fontSize: 12,
                opacity: ngrokLoading ? 0.5 : 1,
                transition: "all 0.15s",
              }}
            >
              {label}
            </button>
          );
        })()}
        {ngrok?.branchName === branch.name && (
          <button
            onClick={() => {
              navigator.clipboard.writeText(ngrok.publicUrl).then(() => {
                setCopyToast("Copied ngrok URL");
                setTimeout(() => setCopyToast(null), 1200);
              }).catch(() => {});
            }}
            title="Click to copy"
            style={{
              padding: "4px 10px",
              background: "var(--bg-card)",
              color: "var(--accent)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 11,
              fontFamily: "'SF Mono', monospace",
              maxWidth: 280,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {ngrok.publicUrl}
          </button>
        )}
        {ngrokError && (
          <span style={{ fontSize: 11, color: "var(--status-error)" }}>
            {ngrokError}
          </span>
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

            <EnvField label="SANDBOX_TEABLE_ENDPOINT" value={envDraft.sandboxTeableEndpoint} onChange={(v) => updateDraft("sandboxTeableEndpoint", v)} />

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
      {/* Logs header */}
      <div
        style={{
          padding: "6px 12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--border)",
          background: "var(--toolbar-bg)",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", flexShrink: 0 }}>
          Logs
          <span style={{ fontWeight: 400, marginLeft: 6, fontSize: 10, opacity: 0.7 }}>
            ({logs.length})
          </span>
        </span>
        <div style={{ position: "relative", flex: 1, minWidth: 0, display: "flex", alignItems: "center" }}>
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search logs ( \u2318F )"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                goToMatch(activeMatchIdx + (e.shiftKey ? -1 : 1));
              } else if (e.key === "Escape") {
                e.preventDefault();
                setSearchTerm("");
                e.currentTarget.blur();
              }
            }}
            style={{
              flex: 1,
              minWidth: 0,
              padding: "3px 70px 3px 8px",
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text-primary)",
              fontSize: 11,
              fontFamily: "'SF Mono', 'Fira Code', monospace",
              outline: "none",
              transition: "border-color 0.15s",
            }}
          />
          {searchTerm.trim() && (
            <span
              style={{
                position: "absolute",
                right: 8,
                fontSize: 10,
                fontFamily: "'SF Mono', monospace",
                color: matches.length === 0 ? "var(--status-error)" : "var(--text-secondary)",
                pointerEvents: "none",
              }}
            >
              {matches.length === 0 ? "0/0" : `${activeMatchIdx + 1}/${matches.length}`}
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          <button
            onClick={() => goToMatch(activeMatchIdx - 1)}
            disabled={matches.length === 0}
            title="Previous match (Shift+Enter)"
            style={{
              padding: "2px 6px",
              fontSize: 11,
              borderRadius: 4,
              background: "var(--bg-card)",
              color: matches.length === 0 ? "var(--text-secondary)" : "var(--text-primary)",
              border: "1px solid var(--border)",
              opacity: matches.length === 0 ? 0.4 : 1,
              cursor: matches.length === 0 ? "default" : "pointer",
            }}
          >
            {"\u2191"}
          </button>
          <button
            onClick={() => goToMatch(activeMatchIdx + 1)}
            disabled={matches.length === 0}
            title="Next match (Enter)"
            style={{
              padding: "2px 6px",
              fontSize: 11,
              borderRadius: 4,
              background: "var(--bg-card)",
              color: matches.length === 0 ? "var(--text-secondary)" : "var(--text-primary)",
              border: "1px solid var(--border)",
              opacity: matches.length === 0 ? 0.4 : 1,
              cursor: matches.length === 0 ? "default" : "pointer",
            }}
          >
            {"\u2193"}
          </button>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <button
            onClick={handleCopyAll}
            disabled={logs.length === 0}
            title={searchTerm.trim() ? "Copy matching lines" : "Copy all lines"}
            style={{
              padding: "2px 6px",
              fontSize: 10,
              borderRadius: 4,
              background: "var(--bg-card)",
              color: "var(--text-secondary)",
              border: "1px solid var(--border)",
              opacity: logs.length === 0 ? 0.4 : 1,
              cursor: logs.length === 0 ? "default" : "pointer",
              transition: "all 0.15s",
            }}
          >
            {searchTerm.trim() ? "Copy match" : "Copy all"}
          </button>
          <button
            onClick={() => {
              const next = !limitLogs;
              setLimitLogs(next);
              limitLogsRef.current = next;
            }}
            style={{
              padding: "2px 6px",
              fontSize: 10,
              borderRadius: 4,
              background: limitLogs ? "var(--bg-card)" : "rgba(251, 191, 36, 0.12)",
              color: limitLogs ? "var(--text-secondary)" : "var(--status-building)",
              border: "1px solid var(--border)",
              transition: "all 0.15s",
            }}
          >
            {limitLogs ? "2K limit" : "Unlimited"}
          </button>
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
            onClick={() => {
              setLogs([]);
              setLogsClearedAt((n) => n + 1);
            }}
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
      <div style={{ flex: 1, position: "relative", display: "flex", flexDirection: "column", minHeight: 0 }}>
        {logs.length === 0 ? (
          <div style={{ flex: 1, background: "var(--log-bg)", color: "var(--log-text-dim)", textAlign: "center", padding: 24, fontSize: 11 }}>
            {status === "stopped" ? "Start the branch to see logs" : "Waiting for output..."}
          </div>
        ) : (
          <LogList
            logs={logs}
            searchTerm={searchTerm.trim()}
            activeMatchLine={activeMatch?.line ?? -1}
            activeMatchLocal={activeMatch?.local ?? -1}
            onCopy={handleCopyLine}
            listRef={listRef}
            onRowsRendered={handleRowsRendered}
            cacheKey={`${branch.name}:${logsClearedAt}`}
          />
        )}
        {searchTerm.trim() && matches.length === 0 && logs.length > 0 && (
          <div
            style={{
              position: "absolute",
              top: 8,
              left: "50%",
              transform: "translateX(-50%)",
              background: "var(--bg-card)",
              color: "var(--text-secondary)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: "3px 10px",
              fontSize: 10,
              pointerEvents: "none",
            }}
          >
            No matches
          </div>
        )}
        {copyToast && (
          <div
            style={{
              position: "absolute",
              bottom: 12,
              right: 12,
              background: "var(--accent)",
              color: "var(--accent-on)",
              borderRadius: 6,
              padding: "4px 10px",
              fontSize: 11,
              fontWeight: 600,
              pointerEvents: "none",
              animation: "wt-fade-in 0.15s ease-out",
            }}
          >
            {copyToast}
          </div>
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
