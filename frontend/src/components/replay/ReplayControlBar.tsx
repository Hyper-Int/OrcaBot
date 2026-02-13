// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { X } from "lucide-react";

interface ReplayControlBarProps {
  scriptName: string;
  currentStep: number;
  totalSteps: number;
  loopCount: number;
  onStop: () => void;
}

/**
 * Small floating status bar shown during replay.
 * Semi-transparent, positioned at bottom-center — small enough to crop from OBS recordings.
 */
export function ReplayControlBar({
  scriptName,
  currentStep,
  totalSteps,
  loopCount,
  onStop,
}: ReplayControlBarProps) {
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[101] pointer-events-auto">
      <div className="flex items-center gap-3 px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-sm text-white text-xs font-mono shadow-lg">
        <span className="text-indigo-300">Replay</span>
        <span className="opacity-60">{scriptName}</span>
        <span>
          {currentStep}/{totalSteps}
        </span>
        {loopCount > 0 && <span className="opacity-60">loop {loopCount + 1}</span>}
        <button
          onClick={onStop}
          className="ml-1 p-0.5 rounded hover:bg-white/20 transition-colors"
          title="Stop replay"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
