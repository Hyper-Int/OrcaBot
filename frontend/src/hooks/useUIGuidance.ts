// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: ui-guidance-v1-initial

/**
 * useUIGuidance hook for handling Orcabot UI guidance commands
 * Manages highlights, tooltips, panel opening, and scrolling
 */

import * as React from "react";
import type { AnyUIGuidanceCommand } from "@/lib/api/cloudflare/chat";

const HOOK_REVISION = "ui-guidance-v1-initial";
console.log(`[useUIGuidance] REVISION: ${HOOK_REVISION} loaded at ${new Date().toISOString()}`);

export interface ActiveHighlight {
  command_id: string;
  target: string;
  style: "pulse" | "glow" | "ring";
  expiresAt: number;
}

export interface ActiveTooltip {
  command_id: string;
  target: string;
  text: string;
  position: "top" | "bottom" | "left" | "right";
  expiresAt: number | null; // null = manual dismiss
}

export interface UIGuidanceState {
  highlights: ActiveHighlight[];
  tooltips: ActiveTooltip[];
}

export interface UIGuidanceActions {
  handleCommand: (command: AnyUIGuidanceCommand) => void;
  dismissHighlight: (commandId: string) => void;
  dismissTooltip: (commandId: string) => void;
  dismissAll: () => void;
  isHighlighted: (target: string) => ActiveHighlight | undefined;
  getTooltip: (target: string) => ActiveTooltip | undefined;
}

export interface UseUIGuidanceReturn extends UIGuidanceState, UIGuidanceActions {}

export interface UseUIGuidanceOptions {
  /** Callback to open a panel (integrations, settings, files, etc.) */
  onOpenPanel?: (panel: string) => void;
  /** Callback to scroll to an element */
  onScrollTo?: (target: string, behavior: "smooth" | "instant") => void;
}

export function useUIGuidance(options?: UseUIGuidanceOptions): UseUIGuidanceReturn {
  const [highlights, setHighlights] = React.useState<ActiveHighlight[]>([]);
  const [tooltips, setTooltips] = React.useState<ActiveTooltip[]>([]);

  // Clean up expired highlights and tooltips
  React.useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setHighlights(prev => prev.filter(h => h.expiresAt > now));
      setTooltips(prev => prev.filter(t => t.expiresAt === null || t.expiresAt > now));
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const handleCommand = React.useCallback((command: AnyUIGuidanceCommand) => {
    console.log(`[useUIGuidance] Handling command: ${command.type}`, command);

    switch (command.type) {
      case "highlight": {
        const duration = command.duration || 3000;
        const highlight: ActiveHighlight = {
          command_id: command.command_id,
          target: command.target || "",
          style: command.style || "pulse",
          expiresAt: Date.now() + duration,
        };
        setHighlights(prev => [...prev.filter(h => h.target !== highlight.target), highlight]);
        break;
      }

      case "tooltip": {
        const duration = command.duration ?? 5000;
        const tooltip: ActiveTooltip = {
          command_id: command.command_id,
          target: command.target || "",
          text: command.text,
          position: command.position || "bottom",
          expiresAt: duration === 0 ? null : Date.now() + duration,
        };
        setTooltips(prev => [...prev.filter(t => t.target !== tooltip.target), tooltip]);
        break;
      }

      case "open_panel": {
        if (options?.onOpenPanel) {
          options.onOpenPanel(command.panel);
        }
        break;
      }

      case "scroll_to": {
        if (options?.onScrollTo) {
          options.onScrollTo(command.target || "", command.behavior || "smooth");
        }
        break;
      }

      case "dismiss_guidance": {
        if (command.all !== false) {
          setHighlights([]);
          setTooltips([]);
        }
        break;
      }
    }
  }, [options]);

  const dismissHighlight = React.useCallback((commandId: string) => {
    setHighlights(prev => prev.filter(h => h.command_id !== commandId));
  }, []);

  const dismissTooltip = React.useCallback((commandId: string) => {
    setTooltips(prev => prev.filter(t => t.command_id !== commandId));
  }, []);

  const dismissAll = React.useCallback(() => {
    setHighlights([]);
    setTooltips([]);
  }, []);

  const isHighlighted = React.useCallback((target: string) => {
    return highlights.find(h => h.target === target);
  }, [highlights]);

  const getTooltip = React.useCallback((target: string) => {
    return tooltips.find(t => t.target === target);
  }, [tooltips]);

  return {
    highlights,
    tooltips,
    handleCommand,
    dismissHighlight,
    dismissTooltip,
    dismissAll,
    isHighlighted,
    getTooltip,
  };
}
