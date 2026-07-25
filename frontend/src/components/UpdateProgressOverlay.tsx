// REVISION: update-progress-overlay-v1
"use client";

import { useEffect, useState } from "react";
import { DESKTOP_MODE } from "@/config/env";
import { onUpdateProgress, type UpdateProgress } from "@/lib/tauri-bridge";

const MODULE_REVISION = "update-progress-overlay-v1";
if (typeof window !== "undefined") {
  console.log(
    `[update-overlay] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Fixed toast that appears while the desktop app is auto-updating. The native
 * "Update available" dialog gives no feedback between the user accepting and the
 * relaunch; this listens to the Rust `update-progress` events and shows a live
 * download bar (then an "installing / restarting" state). No-op on web.
 */
export function UpdateProgressOverlay() {
  const [progress, setProgress] = useState<UpdateProgress | null>(null);

  useEffect(() => {
    if (!DESKTOP_MODE) return;
    let unlisten: (() => void) | null = null;
    onUpdateProgress((p) => setProgress(p)).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  if (!DESKTOP_MODE || !progress) return null;

  const { phase, downloaded, total, message } = progress;
  const pct =
    total && total > 0
      ? Math.min(100, Math.round((downloaded / total) * 100))
      : null;

  const isError = phase === "error";
  const isInstalling = phase === "installing";
  const indeterminate = !isError && !isInstalling && pct === null;

  let title: string;
  let detail: string;
  if (isError) {
    title = "Update failed";
    detail = message || "The update couldn't be installed. It'll retry next launch.";
  } else if (isInstalling) {
    title = "Installing update…";
    detail = "The app will restart in a moment.";
  } else if (phase === "starting") {
    title = "Downloading update…";
    detail = "Starting…";
  } else {
    title = "Downloading update…";
    detail =
      pct !== null
        ? `${pct}% · ${fmtBytes(downloaded)}${total ? ` / ${fmtBytes(total)}` : ""}`
        : fmtBytes(downloaded);
  }

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        zIndex: 2147483000,
        width: 320,
        maxWidth: "calc(100vw - 32px)",
        padding: "12px 14px",
        borderRadius: 12,
        background: "var(--card, #12161f)",
        color: "var(--foreground, #eef2f8)",
        border: "1px solid rgba(255,255,255,0.12)",
        boxShadow: "0 8px 30px rgba(0,0,0,0.35)",
        fontSize: 13,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
        {!isError && (
          <span
            aria-hidden
            style={{
              width: 12,
              height: 12,
              flex: "none",
              borderRadius: "50%",
              border: "2px solid rgba(255,255,255,0.25)",
              borderTopColor: isInstalling ? "#34d399" : "#5b8cff",
              animation: "orcaSpin 0.8s linear infinite",
            }}
          />
        )}
        <span>{title}</span>
      </div>
      <div style={{ marginTop: 4, opacity: 0.7, fontSize: 12 }}>{detail}</div>

      {!isError && (
        <div
          style={{
            marginTop: 10,
            height: 6,
            borderRadius: 999,
            overflow: "hidden",
            background: "rgba(255,255,255,0.10)",
          }}
        >
          <div
            style={{
              height: "100%",
              borderRadius: 999,
              background: isInstalling ? "#34d399" : "#5b8cff",
              width: indeterminate || isInstalling ? "100%" : `${pct}%`,
              transition: "width 0.25s ease",
              animation: indeterminate ? "orcaPulse 1.2s ease-in-out infinite" : undefined,
            }}
          />
        </div>
      )}

      <style>{`
        @keyframes orcaSpin { to { transform: rotate(360deg); } }
        @keyframes orcaPulse { 0%,100% { opacity: 0.5; } 50% { opacity: 1; } }
      `}</style>
    </div>
  );
}
