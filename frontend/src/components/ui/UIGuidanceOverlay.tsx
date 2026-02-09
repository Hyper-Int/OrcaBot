// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: ui-guidance-v2-add-targets

"use client";

/**
 * UIGuidanceOverlay - Renders tooltips and highlight effects for Orcabot guidance
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import type { ActiveHighlight, ActiveTooltip } from "@/hooks/useUIGuidance";

const OVERLAY_REVISION = "ui-guidance-v2-add-targets";
console.log(`[UIGuidanceOverlay] REVISION: ${OVERLAY_REVISION} loaded at ${new Date().toISOString()}`);

interface UIGuidanceOverlayProps {
  highlights: ActiveHighlight[];
  tooltips: ActiveTooltip[];
  onDismissTooltip: (commandId: string) => void;
}

export function UIGuidanceOverlay({
  highlights,
  tooltips,
  onDismissTooltip,
}: UIGuidanceOverlayProps) {
  const [tooltipPositions, setTooltipPositions] = React.useState<
    Map<string, { top: number; left: number; width: number; height: number }>
  >(new Map());

  // Calculate tooltip positions based on target elements
  React.useEffect(() => {
    const calculatePositions = () => {
      const positions = new Map<string, { top: number; left: number; width: number; height: number }>();

      for (const tooltip of tooltips) {
        const element = findTargetElement(tooltip.target);
        if (element) {
          const rect = element.getBoundingClientRect();
          positions.set(tooltip.command_id, {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          });
        }
      }

      setTooltipPositions(positions);
    };

    calculatePositions();
    window.addEventListener("resize", calculatePositions);
    window.addEventListener("scroll", calculatePositions, true);

    return () => {
      window.removeEventListener("resize", calculatePositions);
      window.removeEventListener("scroll", calculatePositions, true);
    };
  }, [tooltips]);

  // Apply highlight effects to target elements
  React.useEffect(() => {
    const cleanupFns: Array<() => void> = [];

    for (const highlight of highlights) {
      const element = findTargetElement(highlight.target);
      if (element) {
        // Add highlight class
        element.classList.add("orcabot-highlight", `orcabot-highlight-${highlight.style}`);
        cleanupFns.push(() => {
          element.classList.remove("orcabot-highlight", `orcabot-highlight-${highlight.style}`);
        });
      }
    }

    return () => {
      cleanupFns.forEach(fn => fn());
    };
  }, [highlights]);

  if (tooltips.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed inset-0 z-[9999]">
      {tooltips.map(tooltip => {
        const pos = tooltipPositions.get(tooltip.command_id);
        if (!pos) return null;

        const tooltipStyle = getTooltipStyle(tooltip.position, pos);

        return (
          <div
            key={tooltip.command_id}
            className="pointer-events-auto absolute animate-in fade-in slide-in-from-bottom-2 duration-200"
            style={tooltipStyle}
          >
            <div className={cn(
              "relative max-w-xs rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground shadow-lg",
              "before:absolute before:border-[6px] before:border-transparent",
              tooltip.position === "top" && "before:bottom-[-12px] before:left-1/2 before:-translate-x-1/2 before:border-t-primary",
              tooltip.position === "bottom" && "before:top-[-12px] before:left-1/2 before:-translate-x-1/2 before:border-b-primary",
              tooltip.position === "left" && "before:right-[-12px] before:top-1/2 before:-translate-y-1/2 before:border-l-primary",
              tooltip.position === "right" && "before:left-[-12px] before:top-1/2 before:-translate-y-1/2 before:border-r-primary",
            )}>
              <div className="flex items-start gap-2">
                <span className="flex-1">{tooltip.text}</span>
                {tooltip.expiresAt === null && (
                  <button
                    onClick={() => onDismissTooltip(tooltip.command_id)}
                    className="flex-shrink-0 rounded-sm opacity-70 hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Find a target element by the guidance target string
 * Supports: "add-terminal", "terminal-{id}", "integrations-panel", etc.
 */
function findTargetElement(target: string): HTMLElement | null {
  // Try data-guidance-target first (exact match)
  let element = document.querySelector(`[data-guidance-target="${target}"]`) as HTMLElement | null;
  if (element) return element;

  // Try by ID
  element = document.getElementById(target) as HTMLElement | null;
  if (element) return element;

  // Handle add-{type} patterns (e.g., "add-terminal", "add-browser", "add-note")
  if (target.startsWith("add-")) {
    const type = target.replace("add-", "");
    element = document.querySelector(`[data-guidance-target="add-${type}"]`) as HTMLElement;
    if (element) return element;
  }

  // Try common patterns
  if (target === "add-button") {
    return document.querySelector('[data-guidance-target="add-terminal"]') as HTMLElement ||
           document.querySelector('[aria-label="Add item"]') as HTMLElement;
  }
  if (target === "chat-button") {
    return document.querySelector('[aria-label="Chat"]') as HTMLElement ||
           document.querySelector('[data-guidance-target="chat"]') as HTMLElement;
  }
  if (target === "settings-button") {
    return document.querySelector('[aria-label="Settings"]') as HTMLElement;
  }
  if (target === "files-sidebar") {
    return document.querySelector('[data-panel="files"]') as HTMLElement ||
           document.querySelector('.files-sidebar') as HTMLElement;
  }
  if (target === "integrations-panel") {
    return document.querySelector('[data-panel="integrations"]') as HTMLElement;
  }
  if (target.startsWith("terminal-")) {
    const id = target.replace("terminal-", "");
    return document.querySelector(`[data-item-id="${id}"]`) as HTMLElement;
  }
  if (target.startsWith("browser-")) {
    const id = target.replace("browser-", "");
    return document.querySelector(`[data-item-id="${id}"]`) as HTMLElement;
  }
  if (target.startsWith("note-")) {
    const id = target.replace("note-", "");
    return document.querySelector(`[data-item-id="${id}"]`) as HTMLElement;
  }

  // Log for debugging
  console.log(`[UIGuidanceOverlay] Could not find target: ${target}`);
  return null;
}

/**
 * Calculate tooltip position style based on target element position
 */
function getTooltipStyle(
  position: "top" | "bottom" | "left" | "right",
  targetRect: { top: number; left: number; width: number; height: number }
): React.CSSProperties {
  const gap = 12;
  const style: React.CSSProperties = {};

  switch (position) {
    case "top":
      style.bottom = `calc(100vh - ${targetRect.top}px + ${gap}px)`;
      style.left = targetRect.left + targetRect.width / 2;
      style.transform = "translateX(-50%)";
      break;
    case "bottom":
      style.top = targetRect.top + targetRect.height + gap;
      style.left = targetRect.left + targetRect.width / 2;
      style.transform = "translateX(-50%)";
      break;
    case "left":
      style.top = targetRect.top + targetRect.height / 2;
      style.right = `calc(100vw - ${targetRect.left}px + ${gap}px)`;
      style.transform = "translateY(-50%)";
      break;
    case "right":
      style.top = targetRect.top + targetRect.height / 2;
      style.left = targetRect.left + targetRect.width + gap;
      style.transform = "translateY(-50%)";
      break;
  }

  return style;
}

export default UIGuidanceOverlay;
