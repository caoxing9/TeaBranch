import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { previewUrl } from "../lib/commands";

interface PreviewFrameProps {
  branchName: string;
  port: number;
}

export function PreviewFrame({ branchName, port }: PreviewFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const url = previewUrl(branchName, port);

  // Auto-refresh on file change
  useEffect(() => {
    const unlisten = listen(`file-changed:${branchName}`, () => {
      if (iframeRef.current) {
        iframeRef.current.src = url;
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [branchName, url]);

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        overflow: "hidden",
        minWidth: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 10px",
          background: "var(--bg-secondary)",
          borderBottom: "1px solid var(--border)",
          fontSize: 12,
        }}
      >
        <span style={{ fontWeight: 600 }}>{branchName}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>
            :{port}
          </span>
          <button
            onClick={() => {
              if (iframeRef.current) {
                iframeRef.current.src = url;
              }
            }}
            style={{
              padding: "2px 6px",
              background: "var(--bg-card)",
              color: "var(--text-secondary)",
              borderRadius: 3,
              fontSize: 10,
            }}
          >
            Reload
          </button>
          <button
            onClick={() => {
              openExternal(url).catch(() => {});
            }}
            style={{
              padding: "2px 6px",
              background: "var(--accent-dim)",
              color: "var(--accent)",
              borderRadius: 3,
              fontSize: 10,
            }}
          >
            Open
          </button>
        </div>
      </div>

      {/* iframe */}
      <div style={{ flex: 1, position: "relative", background: "#fff" }}>
        {loading && !error && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--bg-primary)",
              color: "var(--text-secondary)",
              fontSize: 12,
            }}
          >
            Loading...
          </div>
        )}
        {error && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--bg-primary)",
              color: "var(--status-error)",
              fontSize: 12,
            }}
          >
            Failed to load. Service may still be starting...
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={url}
          onLoad={() => {
            setLoading(false);
            setError(false);
          }}
          onError={() => {
            setLoading(false);
            setError(true);
          }}
          style={{
            width: "100%",
            height: "100%",
            border: "none",
            display: loading || error ? "none" : "block",
          }}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        />
      </div>
    </div>
  );
}
