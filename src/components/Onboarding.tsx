import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { setProjectPath } from "../lib/commands";

interface OnboardingProps {
  onComplete: () => void;
}

export function Onboarding({ onComplete }: OnboardingProps) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSelect() {
    setError(null);
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected) return;

      setLoading(true);
      await setProjectPath(selected as string);
      onComplete();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        background: "var(--bg-primary)",
        gap: 32,
        padding: 40,
      }}
    >
      {/* Logo area */}
      <div style={{ textAlign: "center" }}>
        <div
          style={{
            fontSize: 40,
            fontWeight: 800,
            letterSpacing: -1.5,
            color: "var(--text-primary)",
            marginBottom: 8,
          }}
        >
          TeaBranch
        </div>
        <div
          style={{
            fontSize: 13,
            color: "var(--text-secondary)",
            lineHeight: 1.5,
          }}
        >
          Manage multiple worktrees with isolated environments
        </div>
      </div>

      {/* Action */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
        <button
          onClick={handleSelect}
          disabled={loading}
          style={{
            padding: "10px 24px",
            background: "var(--accent)",
            color: "var(--accent-on)",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: loading ? "wait" : "pointer",
            opacity: loading ? 0.7 : 1,
            border: "none",
            transition: "opacity 0.15s",
          }}
        >
          {loading ? "Opening..." : "Select Project Directory"}
        </button>
        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
          Choose a git repository (e.g. teable-ee)
        </span>
      </div>

      {/* Error */}
      {error && (
        <div
          style={{
            padding: "8px 16px",
            background: "var(--status-error)22",
            color: "var(--status-error)",
            fontSize: 12,
            borderRadius: 6,
            maxWidth: 320,
            textAlign: "center",
            lineHeight: 1.4,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
