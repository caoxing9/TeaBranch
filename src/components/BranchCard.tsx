import { useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import type { Branch, DevCategory } from "../lib/types";
import { StatusBadge } from "./StatusBadge";
import { LogViewer } from "./LogViewer";
import { CategoryPicker } from "./CategoryPicker";
import { startBranch, stopBranch, previewUrl } from "../lib/commands";

interface BranchCardProps {
  branch: Branch;
  onRefresh: () => void;
  devCategory?: DevCategory;
  onCategoryChange?: (category: DevCategory) => void;
  onSelect?: () => void;
  compact?: boolean;
}

export function BranchCard({ branch, onRefresh, devCategory, onCategoryChange, onSelect, compact }: BranchCardProps) {
  const [loading, setLoading] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const env = branch.environment;
  const status = env?.status ?? "stopped";
  const port = env?.port;

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
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        padding: compact ? "6px 8px" : "10px 12px",
        background: "var(--bg-card)",
        borderRadius: "var(--radius)",
        marginBottom: compact ? 4 : 6,
        transition: "background 0.15s",
        cursor: onSelect ? "pointer" : undefined,
      }}
      onClick={(e) => {
        if (onSelect && !(e.target as HTMLElement).closest("button")) {
          onSelect();
        }
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 600,
              fontSize: compact ? 11 : 13,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {branch.name}
            {branch.managed && (
              <span
                style={{
                  marginLeft: 6,
                  fontSize: 9,
                  color: "var(--accent)",
                  fontWeight: 500,
                  background: "var(--accent-dim)",
                  padding: "1px 5px",
                  borderRadius: 3,
                }}
              >
                managed
              </span>
            )}
            {branch.isCurrent && (
              <span
                style={{
                  marginLeft: 6,
                  fontSize: 10,
                  color: "var(--accent)",
                  fontWeight: 400,
                }}
              >
                current
              </span>
            )}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 3,
            }}
          >
            <StatusBadge status={status} />
            {port && (
              <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                :{port}
              </span>
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: 4 }}>
          {(status === "running" || status === "error") && (
            <button
              onClick={() => setShowLogs(!showLogs)}
              style={{
                padding: "4px 6px",
                background: showLogs ? "var(--border)" : "var(--bg-secondary)",
                color: "var(--text-secondary)",
                borderRadius: 4,
                fontSize: 10,
              }}
            >
              Logs
            </button>
          )}
          {status === "running" && port && (
            <button
              onClick={() =>
                open(previewUrl(branch.name, port))
              }
              style={{
                padding: "4px 8px",
                background: "var(--accent-dim)",
                color: "var(--accent)",
                borderRadius: 4,
                fontSize: 11,
              }}
            >
              Preview
            </button>
          )}
          <button
            onClick={handleToggle}
            disabled={loading}
            style={{
              padding: "4px 10px",
              background:
                status === "running" || status === "building"
                  ? "var(--status-error)22"
                  : "var(--accent-dim)",
              color:
                status === "running" || status === "building"
                  ? "var(--status-error)"
                  : "var(--accent)",
              borderRadius: 4,
              fontSize: 11,
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
      </div>

      {/* Category picker — hidden in compact/board mode */}
      {!compact && devCategory && onCategoryChange && (
        <div style={{ marginTop: 6 }}>
          <CategoryPicker value={devCategory} onChange={onCategoryChange} />
        </div>
      )}

      {/* Error display */}
      {error && (
        <div style={{ padding: "6px 0", color: "var(--status-error)", fontSize: 11, marginTop: 4 }}>
          {error}
        </div>
      )}
      {/* Log viewer */}
      {showLogs && <LogViewer branchName={branch.name} />}
    </div>
  );
}
