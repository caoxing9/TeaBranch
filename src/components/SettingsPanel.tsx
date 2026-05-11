import { useEffect, useState } from "react";
import { getSettings, updateSettings } from "../lib/commands";

interface SettingsPanelProps {
  onClose: () => void;
}

const TERMINAL_OPTIONS = [
  { label: "System Default (Terminal)", value: "" },
  { label: "Warp", value: "Warp" },
  { label: "iTerm", value: "iTerm" },
  { label: "Ghostty", value: "Ghostty" },
  { label: "Alacritty", value: "Alacritty" },
  { label: "Kitty", value: "Kitty" },
  { label: "Hyper", value: "Hyper" },
];

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [terminalApp, setTerminalApp] = useState("");
  const [customTerminal, setCustomTerminal] = useState("");
  const [useCustom, setUseCustom] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSettings().then((s) => {
      const val = s.terminalApp ?? "";
      const isPreset = TERMINAL_OPTIONS.some((o) => o.value === val);
      if (isPreset || val === "") {
        setTerminalApp(val);
        setUseCustom(false);
      } else {
        setTerminalApp("__custom__");
        setCustomTerminal(val);
        setUseCustom(true);
      }
    });
  }, []);

  async function handleSave(value: string) {
    setSaving(true);
    try {
      await updateSettings(value || null);
    } finally {
      setSaving(false);
    }
  }

  function handleSelect(val: string) {
    if (val === "__custom__") {
      setTerminalApp("__custom__");
      setUseCustom(true);
    } else {
      setTerminalApp(val);
      setUseCustom(false);
      handleSave(val);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-primary)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 20,
          width: 360,
          maxWidth: "90vw",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>Settings</span>
          <button
            onClick={onClose}
            style={{
              background: "none",
              color: "var(--text-secondary)",
              fontSize: 16,
              padding: "2px 6px",
              cursor: "pointer",
            }}
          >
            &times;
          </button>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "block", marginBottom: 6 }}>
            Terminal App
          </label>
          <select
            value={useCustom ? "__custom__" : terminalApp}
            onChange={(e) => handleSelect(e.target.value)}
            disabled={saving}
            style={{
              width: "100%",
              padding: "6px 8px",
              background: "var(--bg-card)",
              color: "var(--text-primary)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 12,
              outline: "none",
            }}
          >
            {TERMINAL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
            <option value="__custom__">Custom...</option>
          </select>
        </div>

        {useCustom && (
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <input
              value={customTerminal}
              onChange={(e) => setCustomTerminal(e.target.value)}
              placeholder="App name, e.g. WezTerm"
              style={{
                flex: 1,
                padding: "6px 8px",
                background: "var(--bg-card)",
                color: "var(--text-primary)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                fontSize: 12,
                outline: "none",
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && customTerminal.trim()) {
                  handleSave(customTerminal.trim());
                }
              }}
            />
            <button
              onClick={() => {
                if (customTerminal.trim()) handleSave(customTerminal.trim());
              }}
              disabled={saving || !customTerminal.trim()}
              style={{
                padding: "6px 12px",
                background: "var(--accent)",
                color: "var(--accent-on)",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                opacity: saving || !customTerminal.trim() ? 0.5 : 1,
              }}
            >
              {saving ? "..." : "Save"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
