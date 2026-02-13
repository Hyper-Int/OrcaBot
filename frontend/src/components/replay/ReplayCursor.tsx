// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";

interface ReplayCursorProps {
  x: number;
  y: number;
  visible: boolean;
  clicking: boolean;
  /** CSS transition duration for movement in ms */
  moveDurationMs: number;
}

const CURSOR_COLOR = "#6366f1"; // indigo-500

// Inject keyframe animation once
const KEYFRAME_ID = "replay-click-ripple-style";
function ensureKeyframes() {
  if (typeof document === "undefined") return;
  if (document.getElementById(KEYFRAME_ID)) return;
  const style = document.createElement("style");
  style.id = KEYFRAME_ID;
  style.textContent = `
    @keyframes replay-click-ripple {
      0% { transform: scale(0.5); opacity: 1; }
      100% { transform: scale(1.5); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

/**
 * Animated cursor overlay for replay scripts.
 * Uses CSS transitions for smooth movement and a ripple effect on click.
 */
export function ReplayCursor({
  x,
  y,
  visible,
  clicking,
  moveDurationMs,
}: ReplayCursorProps) {
  React.useEffect(() => {
    ensureKeyframes();
  }, []);

  return (
    <div
      className="absolute top-0 left-0 pointer-events-none z-[100]"
      style={{
        transform: `translate(${x}px, ${y}px)`,
        transition: `transform ${moveDurationMs}ms cubic-bezier(0.4, 0, 0.2, 1), opacity 200ms ease`,
        opacity: visible ? 1 : 0,
      }}
    >
      {/* Cursor arrow SVG — same shape as multiplayer Cursor.tsx */}
      <svg
        width="18"
        height="24"
        viewBox="0 0 18 24"
        fill="none"
        className="drop-shadow-md"
        style={{
          transform: clicking ? "scale(0.85)" : "scale(1)",
          transition: "transform 120ms ease-out",
        }}
      >
        <path
          d="M0.5 0.5L17 12L8.5 13.5L5 23.5L0.5 0.5Z"
          fill={CURSOR_COLOR}
          stroke="white"
          strokeWidth="1"
        />
      </svg>

      {/* Click ripple */}
      {clicking && (
        <div
          className="absolute top-0 left-0 rounded-full"
          style={{
            width: 32,
            height: 32,
            marginLeft: -7,
            marginTop: -7,
            backgroundColor: `${CURSOR_COLOR}33`,
            border: `2px solid ${CURSOR_COLOR}66`,
            animation: "replay-click-ripple 300ms ease-out forwards",
          }}
        />
      )}
    </div>
  );
}
