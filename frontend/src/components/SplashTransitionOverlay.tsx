// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: splash-transition-v6-no-morph
"use client";

const MODULE_REVISION = "splash-transition-v6-no-morph";
console.log(
  `[SplashTransitionOverlay] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

import * as React from "react";
import { usePathname } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useSplashTransitionStore } from "@/stores/splash-transition-store";

export function SplashTransitionOverlay() {
  const {
    phase,
    prompt,
    startBottom,
    targetDashboardId,
    chatPanelReady,
    setHandingOff,
    setDone,
    reset,
  } = useSplashTransitionStore();

  const pathname = usePathname();

  // Animation stages:
  // 1. "initial" — bar appears at splash position, just the input row + spinner
  // 2. "fading" — overlay fades out, real ChatPanel fades in
  // No morphing/expanding — bar must stay exactly in place.
  const [stage, setStage] = React.useState<"initial" | "fading">("initial");
  const [backdropVisible, setBackdropVisible] = React.useState(false);

  // Reset when phase returns to idle
  React.useEffect(() => {
    if (phase === "idle" || phase === "done") {
      setStage("initial");
      setBackdropVisible(false);
    }
  }, [phase]);

  // Phase: creating → show backdrop
  React.useEffect(() => {
    if (phase === "creating") {
      const raf = requestAnimationFrame(() => {
        setBackdropVisible(true);
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [phase]);

  // When ChatPanel is ready, begin handoff quickly (no slide to wait for)
  React.useEffect(() => {
    if (chatPanelReady && (phase === "animating" || phase === "creating")) {
      const t = setTimeout(() => setHandingOff(), 400);
      return () => clearTimeout(t);
    }
  }, [chatPanelReady, phase, setHandingOff]);

  // Phase: handing-off → fade out overlay
  React.useEffect(() => {
    if (phase === "handing-off") {
      const raf = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setStage("fading");
        });
      });
      const t = setTimeout(() => setDone(), 800);
      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(t);
      };
    }
  }, [phase, setDone]);

  // Safety: reset on unexpected navigation
  React.useEffect(() => {
    if (phase === "idle" || phase === "done") return;
    if (
      targetDashboardId &&
      pathname &&
      !pathname.includes(targetDashboardId) &&
      pathname !== "/"
    ) {
      reset();
    }
  }, [pathname, targetDashboardId, phase, reset]);

  if (phase === "idle" || phase === "done") return null;

  // Position: bar stays at splash position through all phases
  const currentBottom = startBottom > 0 ? startBottom : Math.round(window.innerHeight * 0.4);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        pointerEvents: phase === "handing-off" ? "none" : "auto",
        opacity: stage === "fading" ? 0 : 1,
        transition: "opacity 700ms cubic-bezier(0.4, 0, 0.2, 1)",
        willChange: "opacity",
      }}
    >
      {/* Dark backdrop */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "var(--background, #030a16)",
          opacity: backdropVisible ? 1 : 0,
          transition: "opacity 500ms cubic-bezier(0.4, 0, 0.2, 1)",
          willChange: "opacity",
        }}
      />

      {/* Floating chat bar card */}
      <div
        style={{
          position: "absolute",
          bottom: currentBottom,
          left: "50%",
          transform: "translateX(-50%)",
          width: "100%",
          maxWidth: "36rem",
          padding: "0 1rem",
          /* bar stays put — no bottom transition */
          zIndex: 1,
        }}
      >
        <div
          style={{
            borderRadius: "1rem",
            boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
            overflow: "hidden",
          }}
        >
          {/* Input bar — just the prompt + spinner, nothing else expands */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.625rem 1rem",
              background: "rgba(11, 22, 59, 0.85)",
              backdropFilter: "blur(20px)",
              borderRadius: "1rem",
            }}
          >
            <span
              style={{
                flex: 1,
                fontSize: "0.875rem",
                color: "#e8edf5",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {prompt}
            </span>
            <div
              style={{
                width: "1.75rem",
                height: "1.75rem",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "9999px",
                background: "#3b82f6",
                boxShadow: "0 2px 8px rgba(59, 130, 246, 0.3)",
              }}
            >
              <Loader2
                style={{
                  width: "0.875rem",
                  height: "0.875rem",
                  color: "white",
                  animation: "spin 1s linear infinite",
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SplashTransitionOverlay;
