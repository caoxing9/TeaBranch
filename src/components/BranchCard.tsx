import { useState, useRef } from "react";
import { open } from "@tauri-apps/plugin-shell";
import type { Branch, DevCategory } from "../lib/types";
import { StatusBadge } from "./StatusBadge";
import { LogViewer } from "./LogViewer";
import { CategoryPicker } from "./CategoryPicker";
import { startBranch, stopBranch, removeBranch, previewUrl, openInVscode } from "../lib/commands";

interface BranchCardProps {
  branch: Branch;
  onRefresh: () => void;
  devCategory?: DevCategory;
  onCategoryChange?: (category: DevCategory) => void;
  onSelect?: () => void;
  compact?: boolean;
}

const SWIPE_THRESHOLD = 80;
const DELETE_ZONE_WIDTH = 72;

export function BranchCard({ branch, onRefresh, devCategory, onCategoryChange, onSelect, compact }: BranchCardProps) {
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [swipeX, setSwipeX] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const lockedRef = useRef<"h" | "v" | null>(null);
  const currentXRef = useRef(0);
  const didSwipeRef = useRef(false);

  const env = branch.environment;
  const status = env?.status ?? "stopped";
  const port = env?.port;
  const hasWorktree = !!(env?.worktreePath || branch.worktreePath);
  const isRunning = status === "running" || status === "building";

  async function handleDelete() {
    setDeleting(true); setConfirmDelete(false); setSwipeX(0); setError(null);
    try { await removeBranch(branch.name); onRefresh(); }
    catch (e) { setError(String(e)); setDeleting(false); }
  }

  async function handleToggle() {
    setLoading(true); setError(null);
    try {
      if (isRunning) await stopBranch(branch.name);
      else await startBranch(branch.name);
      onRefresh();
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!hasWorktree || deleting) return;
    if ((e.target as HTMLElement).closest("button")) return;
    startXRef.current = e.clientX; startYRef.current = e.clientY;
    lockedRef.current = null; currentXRef.current = swipeX;
    didSwipeRef.current = false; setSwiping(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!swiping) return;
    const dx = e.clientX - startXRef.current;
    const dy = e.clientY - startYRef.current;
    if (!lockedRef.current) {
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      lockedRef.current = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
    }
    if (lockedRef.current !== "h") return;
    e.preventDefault(); didSwipeRef.current = true;
    const raw = currentXRef.current + dx;
    setSwipeX(Math.min(0, raw > -SWIPE_THRESHOLD * 2 ? raw : -SWIPE_THRESHOLD * 2 + (raw + SWIPE_THRESHOLD * 2) * 0.2));
  }
  function onPointerUp() {
    if (!swiping) return; setSwiping(false); lockedRef.current = null;
    if (swipeX < -SWIPE_THRESHOLD) { setSwipeX(-DELETE_ZONE_WIDTH); setConfirmDelete(true); }
    else { setSwipeX(0); setConfirmDelete(false); }
  }

  return (
    <div style={{ position: "relative", overflow: "hidden", borderRadius: "var(--radius)", marginBottom: compact ? 4 : 6 }}>
      {/* Delete zone */}
      {hasWorktree && (swipeX < 0 || confirmDelete) && (
        <div
          onClick={handleDelete}
          style={{
            position: "absolute", top: 0, bottom: 0, right: 0, width: DELETE_ZONE_WIDTH,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: "var(--status-error)", borderRadius: "0 var(--radius) var(--radius) 0",
            cursor: "pointer", zIndex: 0,
          }}
        >
          <span style={{ color: "#fff", fontSize: 12, fontWeight: 600 }}>Delete</span>
        </div>
      )}

      {/* Card */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          position: "relative",
          padding: compact ? "6px 8px" : "10px 12px",
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          cursor: onSelect ? "pointer" : undefined,
          transform: `translateX(${swipeX}px)`,
          transition: swiping ? "none" : "transform 0.25s ease",
          zIndex: 1, touchAction: "pan-y",
        }}
        onClick={(e) => {
          if (didSwipeRef.current) { didSwipeRef.current = false; return; }
          if (confirmDelete) { setSwipeX(0); setConfirmDelete(false); return; }
          if (onSelect && !(e.target as HTMLElement).closest("button")) onSelect();
        }}
      >
        {deleting && (
          <div style={{
            position: "absolute", inset: 0, background: "rgba(0,0,0,0.5)",
            borderRadius: "var(--radius)", display: "flex", alignItems: "center",
            justifyContent: "center", gap: 8, zIndex: 2,
          }}>
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" style={{ animation: "wt-spin 0.8s linear infinite" }}>
              <circle cx="12" cy="12" r="10" stroke="var(--status-error)" strokeWidth="3" opacity="0.25" />
              <path d="M12 2a10 10 0 0 1 10 10" stroke="var(--status-error)" strokeWidth="3" strokeLinecap="round" />
            </svg>
            <span style={{ fontSize: 12, color: "var(--status-error)", fontWeight: 600 }}>Deleting...</span>
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: compact ? 11 : 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {branch.name}
              {branch.managed && (
                <span style={{ marginLeft: 6, fontSize: 9, color: "var(--accent)", fontWeight: 500, background: "var(--accent-dim)", padding: "1px 5px", borderRadius: 4 }}>
                  managed
                </span>
              )}
              {branch.isCurrent && (
                <span style={{ marginLeft: 6, fontSize: 10, color: "var(--accent)", fontWeight: 400 }}>current</span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3 }}>
              <StatusBadge status={status} />
              {port && <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>:{port}</span>}
            </div>
          </div>

          <div style={{ display: "flex", gap: 4 }}>
            {(status === "running" || status === "error") && (
              <CardBtn onClick={() => setShowLogs(!showLogs)} active={showLogs}>Logs</CardBtn>
            )}
            {hasWorktree && (
              <CardBtn dim onClick={() => { const wt = env?.worktreePath || branch.worktreePath; if (wt) openInVscode(wt); }}>Code</CardBtn>
            )}
            {status === "running" && port && (
              <CardBtn dim onClick={() => open(previewUrl(branch.name, port))}>Preview</CardBtn>
            )}
            <CardBtn
              onClick={handleToggle}
              disabled={loading}
              danger={isRunning}
              dim={!isRunning}
            >
              {loading ? "..." : isRunning ? "Stop" : "Start"}
            </CardBtn>
          </div>
        </div>

        {!compact && devCategory && onCategoryChange && (
          <div style={{ marginTop: 6 }}><CategoryPicker value={devCategory} onChange={onCategoryChange} /></div>
        )}
        {error && <div style={{ padding: "6px 0", color: "var(--status-error)", fontSize: 11, marginTop: 4 }}>{error}</div>}
        {showLogs && <LogViewer branchName={branch.name} />}
      </div>
    </div>
  );
}

function CardBtn({
  children, onClick, disabled, active, dim, danger,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  dim?: boolean;
  danger?: boolean;
}) {
  let bg = "var(--bg-secondary)";
  let color = "var(--text-secondary)";
  if (dim) { bg = "var(--accent-dim)"; color = "var(--accent)"; }
  if (danger) { bg = "rgba(248,113,113,0.12)"; color = "var(--status-error)"; }
  if (active) { bg = "var(--border-strong)"; }

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      disabled={disabled}
      style={{
        padding: "4px 8px", background: bg, color, borderRadius: 5,
        fontSize: 11, opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}
