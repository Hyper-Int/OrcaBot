// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: mobile-fullscreen-canvas-v1
// A horizontal "filmstrip" of the dashboard's components, one visible full-screen
// at a time. Every component is a viewport-sized React Flow node laid left→right;
// we pan the viewport (zoom locked at 1) to the active one. Because all nodes stay
// mounted, swiping between components is instant and terminals keep their live
// connections (no reconnect between slots).
//
// It reuses the canvas's own block registry (nodeTypes) and data wiring
// (itemsToNodes), so every block renders and behaves exactly as on the canvas.
// No TerminalOverlayProvider is mounted here on purpose: at zoom 1 TerminalBlock
// takes its inline (non-portal) render path and fills the node — which is exactly
// the full-screen container we want.

import * as React from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  type Node,
  type Edge,
  type ReactFlowInstance,
} from "@xyflow/react";
import { itemsToNodes, nodeTypes } from "@/components/canvas/Canvas";
import { FullscreenNavContext } from "@/components/mobile/FullscreenNavContext";
import { MINIMIZED_SIZE } from "@/components/blocks/MinimizedBlockView";
import type { DashboardItem, Session } from "@/types/dashboard";

const MODULE_REVISION = "mobile-fullscreen-canvas-v3-dvh-touch-minimize-viewer";
if (typeof window !== "undefined") {
  console.log(`[mobile-fullscreen-canvas] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

export interface MobileFullscreenCanvasProps {
  /** Ordered components to page through (the dashboard/home slot is handled by the caller). */
  components: DashboardItem[];
  /** 0-based index into `components` of the visible slot. */
  activeIndex: number;
  sessions: Session[];
  // Same callback surface the page passes to <Canvas>, so blocks behave identically.
  onItemChange?: (itemId: string, changes: Partial<DashboardItem>) => void;
  onCreateBrowserBlock?: (url: string, anchor?: { x: number; y: number }, sourceId?: string, size?: { width: number; height: number }) => void;
  onPolicyUpdate?: (terminalItemId: string, provider: string, securityLevel: string) => void;
  onIntegrationAttached?: (terminalItemId: string, provider: string, securityLevel: string) => void;
  onIntegrationDetached?: (terminalItemId: string, provider: string) => void;
  onStorageLinked?: (workspaceItemId: string, provider: "google_drive" | "onedrive" | "box" | "github") => void;
  onStorageDisconnected?: (provider: "google_drive" | "onedrive" | "box" | "github") => void;
  onDuplicate?: (itemId: string) => void;
  onTerminalCwdChange?: (itemId: string, cwd: string) => void;
  onCreateTerminalBlock?: (name: string, bootCommand: string) => void;
  /** Delete a component (persists — same handler the canvas uses). */
  onItemDelete?: (itemId: string) => void;
  /** Horizontal swipe: +1 = next component, -1 = previous (or home when at the first). */
  onSwipeNavigate?: (delta: 1 | -1) => void;
  /** Go back to the dashboard (home). A block's "minimize" redirects here in full-screen. */
  onGoHome?: () => void;
}

const EMPTY_EDGES: Edge[] = [];

// Slots sit exactly one viewport apart (no gap) so only one is ever on screen.
function InnerFilmstrip({
  components,
  activeIndex,
  sessions,
  onItemChange,
  onCreateBrowserBlock,
  onPolicyUpdate,
  onIntegrationAttached,
  onIntegrationDetached,
  onStorageLinked,
  onStorageDisconnected,
  onDuplicate,
  onTerminalCwdChange,
  onCreateTerminalBlock,
  onItemDelete,
  onSwipeNavigate,
  onGoHome,
}: MobileFullscreenCanvasProps) {
  const navValue = React.useMemo(() => (onGoHome ? { goHome: onGoHome } : null), [onGoHome]);

  // A block's minimize sets size→MINIMIZED_SIZE then metadata.minimized=true.
  // Minimizing is meaningless full-screen, and most blocks' header minimize
  // buttons call it directly (not via the settings menu we already redirect), so
  // intercept it here at the single onItemChange choke point → go home instead.
  const handleItemChange = React.useCallback(
    (itemId: string, changes: Partial<DashboardItem>) => {
      const meta = changes.metadata as { minimized?: boolean } | undefined;
      const isMinimize =
        (!!changes.size &&
          changes.size.width === MINIMIZED_SIZE.width &&
          changes.size.height === MINIMIZED_SIZE.height) ||
        meta?.minimized === true;
      if (isMinimize) {
        onGoHome?.();
        return;
      }
      onItemChange?.(itemId, changes);
    },
    [onItemChange, onGoHome]
  );
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const instanceRef = React.useRef<ReactFlowInstance | null>(null);
  const [size, setSize] = React.useState<{ w: number; h: number }>(() => ({
    w: typeof window !== "undefined" ? window.innerWidth : 1,
    h: typeof window !== "undefined" ? window.innerHeight : 1,
  }));

  // Measure the actual render area (excludes the control bar via the parent's layout).
  React.useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setSize((prev) => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }));
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Build the block nodes with the canvas's exact data wiring, then override each
  // to be a viewport-sized slot at x = i * width. Persisted item positions/sizes
  // are NOT touched — this is a transient view-only layout.
  const computedNodes = React.useMemo<Node[]>(() => {
    const base = itemsToNodes(
      components,
      sessions,
      handleItemChange,
      undefined, // onRegisterTerminal: the block self-fits from data.size (= viewport), no parent registry needed
      onCreateBrowserBlock,
      undefined, // onConnectorClick: no edge wiring in full-screen
      false, // connectorMode
      onPolicyUpdate,
      onIntegrationAttached,
      onIntegrationDetached,
      onStorageLinked,
      onStorageDisconnected,
      onDuplicate,
      onTerminalCwdChange,
      onCreateTerminalBlock
    );
    return base.map((node, i) => ({
      ...node,
      position: { x: i * size.w, y: 0 },
      width: size.w,
      height: size.h,
      draggable: false,
      selectable: false,
      connectable: false,
      // deletable stays true so a block's Delete action (deleteElements) fires
      // onNodesDelete below — which persists the delete, not just removes the node.
      data: { ...node.data, size: { width: size.w, height: size.h } },
      style: { ...node.style, width: size.w, height: size.h },
    }));
  }, [
    components,
    sessions,
    size.w,
    size.h,
    handleItemChange,
    onCreateBrowserBlock,
    onPolicyUpdate,
    onIntegrationAttached,
    onIntegrationDetached,
    onStorageLinked,
    onStorageDisconnected,
    onDuplicate,
    onTerminalCwdChange,
    onCreateTerminalBlock,
  ]);

  // Controlled nodes with change handling so React Flow can store measurements.
  // We re-seed from computedNodes whenever the derived layout changes.
  const [nodes, setNodes, onNodesChange] = useNodesState(computedNodes);
  React.useEffect(() => {
    setNodes(computedNodes);
  }, [computedNodes, setNodes]);

  // Pan to the active slot whenever it (or the size) changes.
  React.useEffect(() => {
    const inst = instanceRef.current;
    if (!inst) return;
    inst.setViewport({ x: -activeIndex * size.w, y: 0, zoom: 1 }, { duration: 260 });
  }, [activeIndex, size.w]);

  // Basic horizontal swipe navigation (touch only).
  const touchRef = React.useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = React.useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    touchRef.current = { x: t.clientX, y: t.clientY };
  }, []);
  const onTouchEnd = React.useCallback(
    (e: React.TouchEvent) => {
      const start = touchRef.current;
      touchRef.current = null;
      if (!start || !onSwipeNavigate) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      // Horizontal intent only, with a comfortable threshold.
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      onSwipeNavigate(dx < 0 ? 1 : -1);
    },
    [onSwipeNavigate]
  );

  return (
    <FullscreenNavContext.Provider value={navValue}>
    {/* Stop iOS from panning/scrolling the React Flow pane on touch (weird-state
        drag). Our own swipe handler still fires — it's a JS listener. */}
    <style dangerouslySetInnerHTML={{ __html: ".mobile-fs-filmstrip .react-flow__pane,.mobile-fs-filmstrip .react-flow__renderer,.mobile-fs-filmstrip .react-flow{touch-action:none !important;}" }} />
    <div
      ref={wrapperRef}
      className="mobile-fs-filmstrip w-full h-full bg-[var(--background)] relative overflow-hidden"
      style={{ touchAction: "none", overscrollBehavior: "none" }}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <ReactFlow
        nodes={nodes}
        edges={EMPTY_EDGES}
        onNodesChange={onNodesChange}
        onNodesDelete={(deleted) => {
          if (!onItemDelete) return;
          for (const n of deleted) {
            const item = components.find((c) => (c._stableKey || c.id) === n.id);
            if (item) onItemDelete(item.id);
          }
        }}
        nodeTypes={nodeTypes}
        onInit={(inst) => {
          instanceRef.current = inst;
          inst.setViewport({ x: -activeIndex * size.w, y: 0, zoom: 1 });
        }}
        minZoom={1}
        maxZoom={1}
        panOnDrag={false}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        fitView={false}
      />
    </div>
    </FullscreenNavContext.Provider>
  );
}

export function MobileFullscreenCanvas(props: MobileFullscreenCanvasProps) {
  return (
    <ReactFlowProvider>
      <InnerFilmstrip {...props} />
    </ReactFlowProvider>
  );
}
