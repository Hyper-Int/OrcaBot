// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: fullscreen-control-bar-v1
// Bottom control bar for mobile full-screen view mode: ◀ prev · ⌂ home ·
// "X / N" counter · ▶ next, plus an exit (✕) button. Index 0 = the live
// dashboard (home); 1..componentCount = each component full-screen.

import * as React from "react";
import { ChevronLeft, ChevronRight, Home, X } from "lucide-react";
import { cn } from "@/lib/utils";

const MODULE_REVISION = "fullscreen-control-bar-v1";
if (typeof window !== "undefined") {
  console.log(`[fullscreen-control-bar] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

export interface FullscreenControlBarProps {
  /** 0 = dashboard/home, 1..componentCount = component slots. */
  index: number;
  componentCount: number;
  onPrev: () => void;
  onHome: () => void;
  onNext: () => void;
  onExit: () => void;
  /** Optional label of the current component (shown above the counter). */
  currentLabel?: string;
}

export function FullscreenControlBar({
  index,
  componentCount,
  onPrev,
  onHome,
  onNext,
  onExit,
  currentLabel,
}: FullscreenControlBarProps) {
  const atStart = index <= 0;
  const atEnd = index >= componentCount;
  const onHomeSlot = index === 0;

  const btn =
    "flex items-center justify-center h-10 w-10 rounded-full text-[var(--foreground)] disabled:opacity-30 disabled:pointer-events-none hover:bg-[var(--background-elevated)] active:scale-95 transition";

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[9999] flex justify-center pointer-events-none"
      style={{ paddingBottom: "max(env(safe-area-inset-bottom), 8px)" }}
    >
      <div
        className={cn(
          "pointer-events-auto flex items-center gap-1 m-2 px-2 py-1.5 rounded-full",
          "bg-[var(--background)]/90 backdrop-blur border border-[var(--border)] shadow-lg"
        )}
      >
        <button type="button" className={btn} onClick={onPrev} disabled={atStart} aria-label="Previous component">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <button
          type="button"
          className={cn(btn, onHomeSlot && "text-[var(--accent-primary)]")}
          onClick={onHome}
          aria-label="Dashboard home"
        >
          <Home className="w-5 h-5" />
        </button>

        {/* X / N counter (home slot shows a dash) */}
        <div className="flex flex-col items-center justify-center min-w-[3.5rem] px-1 leading-tight select-none">
          {currentLabel && !onHomeSlot && (
            <span className="max-w-[7rem] truncate text-[10px] text-[var(--foreground-muted)]">{currentLabel}</span>
          )}
          <span className="text-xs font-medium tabular-nums text-[var(--foreground)]">
            {onHomeSlot ? `— / ${componentCount}` : `${index} / ${componentCount}`}
          </span>
        </div>

        <button type="button" className={btn} onClick={onNext} disabled={atEnd} aria-label="Next component">
          <ChevronRight className="w-5 h-5" />
        </button>
        <div className="w-px h-6 bg-[var(--border)] mx-0.5" />
        <button
          type="button"
          className={cn(btn, "text-[var(--foreground-muted)]")}
          onClick={onExit}
          aria-label="Exit full-screen mode"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
