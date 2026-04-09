import { useState, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { BranchList } from "./components/BranchList";
import { Onboarding } from "./components/Onboarding";
import { CreateWorktreeDialog } from "./components/CreateWorktreeDialog";
import { SettingsPanel } from "./components/SettingsPanel";
import { getSettings, setProjectPath, openPreviewWindow } from "./lib/commands";
import { useTheme } from "./hooks/useTheme";

type AppView = "loading" | "onboarding" | "main";

function App() {
  const [view, setView] = useState<AppView>("loading");
  const [error, setError] = useState<string | null>(null);
  const [, setRefreshKey] = useState(0);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const { theme, cycleTheme } = useTheme();

  useEffect(() => {
    getSettings()
      .then((settings) => {
        setView(settings.projectPath ? "main" : "onboarding");
      })
      .catch(() => {
        setView("onboarding");
      });
  }, []);

  async function handleSelectProject() {
    setError(null);
    try {
      const selected = await open({ directory: true, multiple: false });
      if (selected) {
        await setProjectPath(selected as string);
        setRefreshKey((k) => k + 1);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleCompare() {
    setError(null);
    try {
      await openPreviewWindow([]);
    } catch (e) {
      setError(String(e));
    }
  }

  if (view === "loading") {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "var(--bg-primary)" }} />
    );
  }

  if (view === "onboarding") {
    return (
      <Onboarding
        onComplete={() => {
          setRefreshKey((k) => k + 1);
          setView("main");
        }}
      />
    );
  }

  const themeIcon = theme === "dark" ? "\u263D" : theme === "light" ? "\u2600" : "\u25D0";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg-primary)" }}>
      {/* Title bar */}
      <div
        data-tauri-drag-region
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 10px 6px 78px",
          background: "var(--toolbar-bg)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span
          data-tauri-drag-region
          style={{ fontWeight: 700, fontSize: 14, letterSpacing: -0.3, flex: 1 }}
        >
          TeaBranch
        </span>
        <div style={{ display: "flex", gap: 3, alignItems: "center", flexShrink: 0 }}>
          <TitleBtn accent onClick={() => setShowCreateDialog(true)}>New Branch</TitleBtn>
          <TitleBtn dim onClick={handleCompare}>Compare</TitleBtn>
          <TitleBtn onClick={handleSelectProject}>Open</TitleBtn>
          <div style={{ width: 1, height: 14, background: "var(--border-strong)", margin: "0 2px" }} />
          <TitleBtn onClick={cycleTheme} title={`Theme: ${theme}`}>
            <span style={{ fontSize: 14 }}>{themeIcon}</span>
          </TitleBtn>
          <TitleBtn onClick={() => setShowSettings(true)} title="Settings">
            <span style={{ fontSize: 14 }}>&#9881;</span>
          </TitleBtn>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{
          padding: "6px 12px",
          background: "rgba(248,113,113,0.12)",
          color: "var(--status-error)",
          fontSize: 11,
          borderBottom: "1px solid rgba(248,113,113,0.15)",
        }}>
          {error}
        </div>
      )}

      <BranchList />

      {showCreateDialog && (
        <CreateWorktreeDialog
          onClose={() => setShowCreateDialog(false)}
          onCreated={() => setRefreshKey((k) => k + 1)}
        />
      )}

      {showSettings && (
        <SettingsPanel onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}

function TitleBtn({
  children, onClick, accent, dim, title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  accent?: boolean;
  dim?: boolean;
  title?: string;
}) {
  let bg = "var(--bg-card)";
  let color = "var(--text-secondary)";
  if (accent) { bg = "var(--accent)"; color = "var(--accent-on)"; }
  else if (dim) { bg = "var(--accent-dim)"; color = "var(--accent)"; }

  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        padding: "0 8px",
        height: 24,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: bg,
        color,
        borderRadius: 5,
        fontSize: 11,
        fontWeight: accent ? 600 : 400,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

export default App;
