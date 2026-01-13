"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface SelectionRingProps {
  /** User's name */
  name: string;
  /** Ring color (CSS value) */
  color: string;
  /** Whether to show the ring */
  visible?: boolean;
  /** Children to wrap */
  children: React.ReactNode;
  /** Optional className */
  className?: string;
}

/**
 * Selection ring wrapper that shows when another user has selected an item
 */
export function SelectionRing({
  name,
  color,
  visible = true,
  children,
  className,
}: SelectionRingProps) {
  if (!visible) {
    return <>{children}</>;
  }

  return (
    <div className={cn("relative", className)}>
      {children}

      {/* Selection ring */}
      <div
        className="absolute inset-0 pointer-events-none rounded-[var(--radius-card)] ring-2 ring-offset-1 ring-offset-[var(--background)]"
        style={{ ["--tw-ring-color" as string]: color }}
      />

      {/* User name badge */}
      <div
        className="absolute -top-6 left-2 px-2 py-0.5 rounded text-xs font-medium text-white whitespace-nowrap"
        style={{ backgroundColor: color }}
      >
        {name}
      </div>
    </div>
  );
}

export default SelectionRing;
