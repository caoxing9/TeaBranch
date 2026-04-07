import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Branch, DevCategory } from "../lib/types";
import { DEV_CATEGORIES } from "../lib/types";
import { StatusBadge } from "./StatusBadge";
import { CategoryPicker } from "./CategoryPicker";
import { startBranch, stopBranch, getBranchLogs } from "../lib/commands";
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

  const catInfo = DEV_CATEGORIES[devCategory];

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
        }}
      >
        <button
          onClick={onBack}
          style={{
            padding: "4px 8px",
            background: "var(--bg-card)",
            color: "var(--text-secondary)",
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          ← Back
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
                borderRadius: 3,
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
            background:
              status === "running" || status === "building"
                ? "var(--status-error)22"
                : "var(--accent-dim)",
            color:
              status === "running" || status === "building"
                ? "var(--status-error)"
                : "var(--accent)",
            borderRadius: 4,
            fontSize: 12,
            opacity: loading ? 0.5 : 1,
          }}
        >
          {loading
            ? "..."
            : status === "running" || status === "building"
              ? "Stop"
              : "Start"}
        </button>
      </div>

      {/* Info panel */}
      <div
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid var(--border)",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "8px 16px",
          fontSize: 12,
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
            {dbName ?? "—"}
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
            <span style={{ color: "var(--text-secondary)" }}>—</span>
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
            {branch.managed ? "BranchPilot" : "External"}
          </span>
        </div>

        {/* Worktree path */}
        <div style={{ gridColumn: "1 / -1" }}>
          <div style={{ color: "var(--text-secondary)", fontSize: 10, marginBottom: 2 }}>Worktree</div>
          <span style={{ color: "var(--text-primary)", fontFamily: "'SF Mono', monospace", fontSize: 11, wordBreak: "break-all" }}>
            {worktreePath ?? branch.worktreePath ?? "—"}
          </span>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: "6px 12px", background: "var(--status-error)22", color: "var(--status-error)", fontSize: 11 }}>
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
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)" }}>
          Logs
          <span style={{ fontWeight: 400, marginLeft: 6, fontSize: 10 }}>
            ({logs.length} lines)
          </span>
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            style={{
              padding: "2px 6px",
              fontSize: 10,
              borderRadius: 3,
              background: autoScroll ? "var(--accent-dim)" : "var(--bg-card)",
              color: autoScroll ? "var(--accent)" : "var(--text-secondary)",
            }}
          >
            Auto-scroll {autoScroll ? "ON" : "OFF"}
          </button>
          <button
            onClick={() => setLogs([])}
            style={{
              padding: "2px 6px",
              fontSize: 10,
              borderRadius: 3,
              background: "var(--bg-card)",
              color: "var(--text-secondary)",
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
