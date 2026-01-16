// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface CursorProps {
  /** User's name to display */
  name: string;
  /** Cursor color (CSS value) */
  color: string;
  /** X position on canvas */
  x: number;
  /** Y position on canvas */
  y: number;
  /** Whether user is typing */
  isTyping?: boolean;
  /** Optional className */
  className?: string;
}

/**
 * Remote cursor component with smooth animation
 * Displays another user's cursor position on the canvas
 */
export function Cursor({
  name,
  color,
  x,
  y,
  isTyping = false,
  className,
}: CursorProps) {
  return (
    <div
      className={cn(
        "absolute pointer-events-none z-50",
        // Smooth interpolation
        "transition-transform duration-75 ease-out",
        className
      )}
      style={{
        transform: `translate(${x}px, ${y}px)`,
      }}
    >
      {/* Cursor arrow */}
      <svg
        width="18"
        height="24"
        viewBox="0 0 18 24"
        fill="none"
        className="drop-shadow-sm"
      >
        <path
          d="M0.5 0.5L17 12L8.5 13.5L5 23.5L0.5 0.5Z"
          fill={color}
          stroke="white"
          strokeWidth="1"
        />
      </svg>

      {/* Name label */}
      <div
        className={cn(
          "absolute left-4 top-4",
          "px-2 py-0.5 rounded text-xs font-medium text-white whitespace-nowrap",
          "shadow-sm"
        )}
        style={{ backgroundColor: color }}
      >
        {name}
        {isTyping && (
          <span className="ml-1.5 inline-flex gap-0.5">
            <span className="w-1 h-1 rounded-full bg-white/80 animate-bounce" style={{ animationDelay: "0ms" }} />
            <span className="w-1 h-1 rounded-full bg-white/80 animate-bounce" style={{ animationDelay: "150ms" }} />
            <span className="w-1 h-1 rounded-full bg-white/80 animate-bounce" style={{ animationDelay: "300ms" }} />
          </span>
        )}
      </div>
    </div>
  );
}

export default Cursor;
