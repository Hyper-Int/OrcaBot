// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * A replay script defines a sequence of timed UI actions
 * for recording dashboard walkthroughs with OBS.
 */
export interface ReplayScript {
  name: string;
  description: string;
  /** Delay between loops in ms */
  loopDelayMs: number;
  /** Initial canvas viewport */
  initialViewport: { x: number; y: number; zoom: number };
  /** Whether to delete all created items when looping */
  cleanupOnLoop: boolean;
  /** Ordered list of actions to execute */
  actions: ReplayAction[];
}

export type ReplayAction =
  | { type: "moveCursor"; x: number; y: number; durationMs: number }
  | { type: "click"; durationMs?: number }
  | {
      type: "addBlock";
      blockType: string;
      label?: string;
      position: { x: number; y: number };
      alias: string;
    }
  | {
      type: "typeTerminal";
      alias: string;
      text: string;
      execute?: boolean;
      charDelayMs?: number;
    }
  | {
      type: "createEdge";
      sourceAlias: string;
      targetAlias: string;
      sourceHandle?: string;
      targetHandle?: string;
    }
  | { type: "panCanvas"; x: number; y: number; zoom?: number; durationMs: number }
  | { type: "wait"; durationMs: number }
  | { type: "deleteItem"; alias: string };

/**
 * API surface exposed by page.tsx for the replay runner to drive the dashboard.
 */
export interface ReplayRunnerAPI {
  addBlock: (
    blockType: string,
    label: string | undefined,
    position: { x: number; y: number }
  ) => Promise<string>;
  createEdge: (
    sourceItemId: string,
    targetItemId: string,
    sourceHandle?: string,
    targetHandle?: string
  ) => Promise<void>;
  deleteItem: (itemId: string) => Promise<void>;
  panTo: (x: number, y: number, zoom?: number, duration?: number) => void;
  /** Resolve an item ID to its React Flow node ID (_stableKey || id) */
  getNodeId: (itemId: string) => string;
  /** Get current viewport */
  getViewport: () => { x: number; y: number; zoom: number };
}
