import { useState, useEffect, useRef } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { createWorktree, listWorktreeDbInfo } from "../lib/commands";
import type { WorktreeProgress, DbModeType, WorktreeDbInfo } from "../lib/types";

interface CreateWorktreeDialogProps {
  onClose: () => void;
  onCreated: () => void;
}

const STEPS = [
  { key: "fetch", label: "Fetch origin/develop" },
  { key: "branch", label: "Create branch & worktree" },
  { key: "env", label: "Setup environment" },
  { key: "install", label: "Install dependencies" },
  { key: "database", label: "Setup database" },
  { key: "migrate", label: "Run migration" },
  { key: "done", label: "Done" },
];

const DB_MODE_OPTIONS: { value: DbModeType; label: string; desc: string }[] = [
  { value: "new", label: "\u65B0\u5EFA\u6570\u636E\u5E93", desc: "\u57FA\u4E8E\u57FA\u7840\u6A21\u677F\u521B\u5EFA\uFF0C\u547D\u540D\u4E0E worktree \u4E00\u81F4" },
  { value: "clone", label: "\u514B\u9686\u5DF2\u6709\u6570\u636E\u5E93", desc: "\u57FA\u4E8E\u5DF2\u6709 worktree \u7684\u6570\u636E\u5E93\u514B\u9686\uFF0C\u547D\u540D\u4E0E\u65B0 worktree \u4E00\u81F4" },
  { value: "reuse", label: "\u590D\u7528\u5DF2\u6709\u6570\u636E\u5E93", desc: "\u76F4\u63A5\u4F7F\u7528\u5DF2\u6709 worktree \u7684\u6570\u636E\u5E93\u548C Redis" },
];

function Spinner({ size = 14, color = "var(--status-building)" }: { size?: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ animation: "wt-spin 0.8s linear infinite" }}
    >
      <circle cx="12" cy="12" r="10" stroke={color} strokeWidth="3" opacity="0.25" />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Derive the DB name that will be used, matching backend logic */
function deriveDbName(branchName: string): string {
  return "teable_" + branchName.replace(/\//g, "_").replace(/-/g, "_").toLowerCase();
}

export function CreateWorktreeDialog({ onClose, onCreated }: CreateWorktreeDialogProps) {
  const [branchName, setBranchName] = useState("");
  const [creating, setCreating] = useState(false);
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // DB mode state
  const [dbMode, setDbMode] = useState<DbModeType>("new");
  const [sourceBranch, setSourceBranch] = useState<string>("");
  const [worktreeDbInfos, setWorktreeDbInfos] = useState<WorktreeDbInfo[]>([]);

  useEffect(() => {
    inputRef.current?.focus();
    // Load existing worktree DB info for the dropdown
    listWorktreeDbInfo().then(setWorktreeDbInfos).catch(() => {});
  }, []);

  // Auto-close when done
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => {
      onCreated();
      onClose();
    }, 800);
    return () => clearTimeout(timer);
  }, [done]);

  useEffect(() => {
    if (!creating || !branchName) return;

    let unlisten: UnlistenFn | null = null;
    listen<WorktreeProgress>(`worktree-progress:${branchName}`, (event) => {
      setCurrentStep(event.payload.step);
      if (event.payload.done) {
        setDone(true);
        setCreating(false);
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [creating, branchName]);

  async function handleCreate() {
    const name = branchName.trim();
    if (!name) return;
    if (dbMode !== "new" && !sourceBranch) return;

    setError(null);
    setCreating(true);
    setCurrentStep(null);
    setDone(false);

    try {
      await createWorktree(
        name,
        dbMode,
        dbMode !== "new" ? sourceBranch : undefined,
      );
      // If the command returns without events, mark as done
      if (!done) {
        setDone(true);
        setCreating(false);
      }
    } catch (e) {
      setError(String(e));
      setCreating(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !creating && !done) {
      handleCreate();
    }
    if (e.key === "Escape") {
      onClose();
    }
  }

  // Filter out worktrees that have a database configured
  const availableSources = worktreeDbInfos.filter((i) => i.databaseName);

  // Preview what DB name will be used
  const previewDbName = (() => {
    if (!branchName.trim()) return null;
    if (dbMode === "reuse" && sourceBranch) {
      const src = worktreeDbInfos.find((i) => i.branchName === sourceBranch);
      return src?.databaseName ?? null;
    }
    return deriveDbName(branchName.trim());
  })();

  const canCreate = branchName.trim() && (dbMode === "new" || sourceBranch);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--overlay-bg)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !creating) onClose();
      }}
    >
      <div
        style={{
          background: "var(--bg-secondary)",
          borderRadius: 14,
          border: "1px solid var(--border-strong)",
          padding: 24,
          width: 420,
          maxHeight: "80vh",
          overflow: "auto",
          boxShadow: "0 8px 40px rgba(0, 0, 0, 0.3)",
          animation: "wt-fade-in 0.2s ease",
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16 }}>
          New Worktree
        </div>

        {/* Input form */}
        {!creating && !done && (
          <>
            {/* Branch name */}
            <div style={{ marginBottom: 8, fontSize: 12, color: "var(--text-secondary)" }}>
              Branch name (from origin/develop):
            </div>
            <input
              ref={inputRef}
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="feat/my-feature"
              style={{
                width: "100%",
                padding: "8px 10px",
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                color: "var(--text-primary)",
                fontSize: 13,
                outline: "none",
                boxSizing: "border-box",
                backdropFilter: "blur(8px)",
                transition: "border-color 0.15s, box-shadow 0.15s",
              }}
            />

            {/* DB Mode selection */}
            <div style={{ marginTop: 16, marginBottom: 8, fontSize: 12, color: "var(--text-secondary)" }}>
              数据库模式:
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {DB_MODE_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    padding: "6px 8px",
                    borderRadius: 8,
                    cursor: "pointer",
                    background: dbMode === opt.value ? "var(--accent-dim)" : "transparent",
                    border: dbMode === opt.value ? "1px solid var(--accent)" : "1px solid transparent",
                    transition: "all 0.15s",
                  }}
                >
                  <input
                    type="radio"
                    name="dbMode"
                    value={opt.value}
                    checked={dbMode === opt.value}
                    onChange={() => {
                      setDbMode(opt.value);
                      if (opt.value === "new") setSourceBranch("");
                    }}
                    style={{ marginTop: 2, accentColor: "var(--accent)" }}
                  />
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
                      {opt.label}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 1 }}>
                      {opt.desc}
                    </div>
                  </div>
                </label>
              ))}
            </div>

            {/* Source branch dropdown (for clone/reuse) */}
            {dbMode !== "new" && (
              <div style={{ marginTop: 12 }}>
                <div style={{ marginBottom: 6, fontSize: 12, color: "var(--text-secondary)" }}>
                  {dbMode === "clone" ? "\u514B\u9686\u6765\u6E90:" : "\u590D\u7528\u6765\u6E90:"}
                </div>
                {availableSources.length === 0 ? (
                  <div style={{ fontSize: 11, color: "var(--status-error)", padding: "4px 0" }}>
                    \u6CA1\u6709\u627E\u5230\u5DF2\u914D\u7F6E\u6570\u636E\u5E93\u7684 worktree
                  </div>
                ) : (
                  <select
                    value={sourceBranch}
                    onChange={(e) => setSourceBranch(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "6px 8px",
                      background: "var(--bg-card)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      color: "var(--text-primary)",
                      fontSize: 12,
                      outline: "none",
                      backdropFilter: "blur(8px)",
                      transition: "border-color 0.15s",
                    }}
                  >
                    <option value="">-- \u9009\u62E9 worktree --</option>
                    {availableSources.map((info) => (
                      <option key={info.branchName} value={info.branchName}>
                        {info.branchName} ({info.databaseName})
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}

            {/* DB name preview */}
            {previewDbName && branchName.trim() && (
              <div
                style={{
                  marginTop: 12,
                  padding: "6px 10px",
                  background: "var(--bg-card)",
                  borderRadius: 8,
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  border: "1px solid var(--border)",
                }}
              >
                <span style={{ opacity: 0.6 }}>DB:</span>
                <code style={{ color: "var(--accent)", fontFamily: "monospace", fontSize: 11 }}>
                  {previewDbName}
                </code>
                {dbMode === "reuse" && (
                  <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--status-building)" }}>
                    shared
                  </span>
                )}
              </div>
            )}

            {/* Action buttons */}
            <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
              <button
                onClick={onClose}
                style={{
                  padding: "6px 14px",
                  background: "var(--bg-card)",
                  color: "var(--text-secondary)",
                  borderRadius: 8,
                  fontSize: 12,
                  border: "1px solid var(--border)",
                  cursor: "pointer",
                  transition: "all 0.15s",
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!canCreate}
                style={{
                  padding: "6px 14px",
                  background: canCreate ? "var(--accent)" : "var(--bg-card)",
                  color: canCreate ? "var(--accent-on)" : "var(--text-secondary)",
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 600,
                  border: "none",
                  cursor: canCreate ? "pointer" : "default",
                  transition: "all 0.15s",
                }}
              >
                Create
              </button>
            </div>
          </>
        )}

        {/* Progress */}
        {(creating || done) && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {STEPS.map((step) => {
              const isActive = currentStep === step.key;
              const isPast =
                currentStep != null &&
                STEPS.findIndex((s) => s.key === currentStep) >
                  STEPS.findIndex((s) => s.key === step.key);
              const isDone = step.key === "done" && done;

              let color = "var(--text-secondary)";
              if (isPast || isDone) {
                color = "var(--accent)";
              } else if (isActive) {
                color = "var(--status-building)";
              }

              return (
                <div
                  key={step.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                    color,
                    opacity: !isPast && !isActive && !isDone ? 0.5 : 1,
                    transition: "all 0.2s",
                  }}
                >
                  <span style={{ width: 14, height: 14, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, flexShrink: 0 }}>
                    {isActive ? (
                      <Spinner size={14} />
                    ) : isPast || isDone ? (
                      "\u2713"
                    ) : (
                      "\u00B7"
                    )}
                  </span>
                  <span>{step.label}</span>
                </div>
              );
            })}

            {done && (
              <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-secondary)", textAlign: "right" }}>
                Closing...
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div
            style={{
              marginTop: 12,
              padding: "8px 12px",
              background: "rgba(248, 113, 113, 0.12)",
              color: "var(--status-error)",
              fontSize: 11,
              borderRadius: 8,
              lineHeight: 1.4,
              border: "1px solid rgba(248, 113, 113, 0.2)",
            }}
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
