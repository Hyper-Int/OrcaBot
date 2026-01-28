// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  type NodeTypes,
  type Node,
  type Edge,
  type EdgeChange,
  type OnNodesChange,
  type OnNodeDrag,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { NoteBlock } from "@/components/blocks/NoteBlock";
import { TodoBlock } from "@/components/blocks/TodoBlock";
import { LinkBlock } from "@/components/blocks/LinkBlock";
import { TerminalBlock } from "@/components/blocks/TerminalBlock";
import { BrowserBlock } from "@/components/blocks/BrowserBlock";
import { WorkspaceBlock } from "@/components/blocks/WorkspaceBlock";
import { RecipeBlock } from "@/components/blocks/RecipeBlock";
import { PromptBlock } from "@/components/blocks/PromptBlock";
import { ScheduleBlock } from "@/components/blocks/ScheduleBlock";
import { GmailBlock } from "@/components/blocks/GmailBlock";
import { CalendarBlock } from "@/components/blocks/CalendarBlock";
import { ContactsBlock } from "@/components/blocks/ContactsBlock";
import { SheetsBlock } from "@/components/blocks/SheetsBlock";
import { FormsBlock } from "@/components/blocks/FormsBlock";
import { CursorNode } from "@/components/canvas/CursorNode";
import type { DashboardItem, Session } from "@/types/dashboard";
import type { TerminalHandle } from "@/components/terminal";
import { TerminalOverlayProvider, useTerminalZIndex } from "@/components/terminal";

// Register custom node types
const nodeTypes: NodeTypes = {
  note: NoteBlock,
  todo: TodoBlock,
  link: LinkBlock,
  terminal: TerminalBlock,
  browser: BrowserBlock,
  workspace: WorkspaceBlock,
  recipe: RecipeBlock,
  prompt: PromptBlock,
  schedule: ScheduleBlock,
  gmail: GmailBlock,
  calendar: CalendarBlock,
  contacts: ContactsBlock,
  sheets: SheetsBlock,
  forms: FormsBlock,
  cursor: CursorNode,
};

// Convert dashboard items to React Flow nodes
function itemsToNodes(
  items: DashboardItem[],
  sessions: Session[],
  onItemChange?: (itemId: string, changes: Partial<DashboardItem>) => void,
  onRegisterTerminal?: (itemId: string, handle: TerminalHandle | null) => void,
  onCreateBrowserBlock?: (
    url: string,
    anchor?: { x: number; y: number },
    sourceId?: string
  ) => void,
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void,
  connectorMode?: boolean
): Node[] {
  const workspaceSession =
    sessions.find((s) => s.status === "active")
    ?? sessions.find((s) => s.status === "creating")
    ?? sessions[0];
  return items.map((item) => {
    // Find active session for terminal items
    const session = item.type === "terminal"
      ? sessions.find((s) => s.itemId === item.id && s.status === "active")
      : undefined;

    // Use _stableKey for React reconciliation to prevent remounting when temp ID transitions to real ID
    const nodeId = item._stableKey || item.id;

    // Extract color from metadata for notes
    const color = item.type === "note" && item.metadata?.color
      ? item.metadata.color as string
      : undefined;

    return {
      id: nodeId,
      type: item.type,
      position: item.position,
      // React Flow v12 requires width/height on node for drag before measurement
      width: item.size.width,
      height: item.size.height,
      data: {
        content: item.content,
        size: item.size,
        dashboardId: item.dashboardId,
        itemId: item.id, // Pass actual item ID for API calls
        session, // Pass session to terminal blocks
        sessionId: item.type === "workspace" ? workspaceSession?.id : undefined,
        color, // Note color from metadata
        metadata: item.metadata, // Pass full metadata for type-specific use
        onRegisterTerminal,
        onCreateBrowserBlock,
        onConnectorClick,
        connectorMode,
        onItemChange: onItemChange
          ? (changes: Partial<DashboardItem>) => onItemChange(item.id, changes)
          : undefined,
        onContentChange: onItemChange
          ? (content: string) => onItemChange(item.id, { content })
          : undefined,
      },
      style: {
        width: item.size.width,
        height: item.size.height,
      },
    };
  });
}

interface CanvasProps {
  items: DashboardItem[];
  sessions?: Session[];
  onItemChange?: (itemId: string, changes: Partial<DashboardItem>) => void;
  onItemCreate?: (item: Omit<DashboardItem, "id" | "createdAt" | "updatedAt">) => void;
  onItemDelete?: (itemId: string) => void;
  onCreateBrowserBlock?: (url: string, anchor?: { x: number; y: number }, sourceId?: string) => void;
  onViewportChange?: (viewport: { x: number; y: number; zoom: number }) => void;
  onCursorMove?: (point: { x: number; y: number }) => void;
  onCanvasClick?: () => void;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
  connectorMode?: boolean;
  fitViewEnabled?: boolean;
  edges?: Edge[];
  onEdgesChange?: (changes: EdgeChange[]) => void;
  readOnly?: boolean;
  extraNodes?: Node[];
}

export function Canvas({
  items,
  sessions = [],
  onItemChange,
  onItemCreate,
  onItemDelete,
  onCreateBrowserBlock,
  onViewportChange,
  onCursorMove,
  onCanvasClick,
  onConnectorClick,
  connectorMode = false,
  fitViewEnabled = true,
  edges: controlledEdges,
  onEdgesChange: onEdgesChangeProp,
  readOnly = false,
  extraNodes = [],
}: CanvasProps) {
  const overlayRef = React.useRef<HTMLDivElement>(null);
  const [overlayRoot, setOverlayRoot] = React.useState<HTMLDivElement | null>(null);
  const [viewport, setViewport] = React.useState({ x: 0, y: 0, zoom: 1 });
  const instanceRef = React.useRef<ReactFlowInstance | null>(null);
  const { zIndexVersion, bringToFront, getZIndex } = useTerminalZIndex();
  const terminalRefs = React.useRef<Map<string, TerminalHandle>>(new Map());
  const applyZIndex = React.useCallback(
    (nextNodes: Node[]) =>
      nextNodes.map((node) => {
        const base = getZIndex(node.id);
        const zIndex = node.type === "browser"
          ? base + 12000
          : node.type === "terminal"
            ? base + 10000
            : base;
        return {
          ...node,
          style: {
            ...node.style,
            zIndex,
          },
        };
      }),
    [getZIndex]
  );
  const initialNodes = React.useMemo(() => {
    const baseNodes = applyZIndex(
      itemsToNodes(
        items,
        sessions,
        readOnly ? undefined : onItemChange,
        (itemId, handle) => {
          if (handle) {
            terminalRefs.current.set(itemId, handle);
          } else {
            terminalRefs.current.delete(itemId);
          }
        },
        onCreateBrowserBlock,
        onConnectorClick,
        connectorMode
      )
    );
    return [...baseNodes, ...extraNodes];
  }, []);
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState<Edge>([]);
  const edgesToRender = controlledEdges ?? edges;
  const edgesChangeHandler = controlledEdges ? onEdgesChangeProp : onEdgesChange;

  // Update nodes when items or sessions change from server
  React.useEffect(() => {
    const baseNodes = applyZIndex(
      itemsToNodes(
        items,
        sessions,
        readOnly ? undefined : onItemChange,
        (itemId, handle) => {
          if (handle) {
            terminalRefs.current.set(itemId, handle);
          } else {
            terminalRefs.current.delete(itemId);
          }
        },
        onCreateBrowserBlock,
        onConnectorClick,
        connectorMode
      )
    );
    setNodes([...baseNodes, ...extraNodes]);
  }, [items, sessions, setNodes, onItemChange, readOnly, onCreateBrowserBlock, onConnectorClick, connectorMode, applyZIndex, extraNodes]);

  React.useEffect(() => {
    setNodes((current) => applyZIndex(current));
  }, [applyZIndex, setNodes, zIndexVersion]);

  // Handle node changes - apply locally, sync dimensions on resize end
  const handleNodesChange: OnNodesChange = React.useCallback(
    (changes: NodeChange[]) => {
      changes.forEach((change) => {
        if (change.type === "select" && change.selected) {
          bringToFront(change.id);
        }
      });

      onNodesChange(changes);

      // Check for dimension changes (from NodeResizer)
      changes.forEach((change) => {
        if (change.type === "dimensions" && change.resizing === false && onItemChange) {
          // Resize ended - sync to server
          const node = nodes.find((n) => n.id === change.id);
          if (node && change.dimensions) {
            // Use itemId (real ID) for API calls, not node.id (which may be stable key)
            const itemId = (node.data as { itemId?: string })?.itemId || node.id;
            // When resizing from top/left edges, position also changes
            // Include both size and position to keep the correct corner anchored
            onItemChange(itemId, {
              position: node.position,
              size: {
                width: Math.round(change.dimensions.width),
                height: Math.round(change.dimensions.height),
              },
            });
          }

          if (node?.type === "terminal") {
            terminalRefs.current.get(node.id)?.fit();
          }
        }
      });
    },
    [onNodesChange, onItemChange, nodes, bringToFront]
  );

  const handleNodeDragStart: OnNodeDrag = React.useCallback(
    (_event, node) => {
      bringToFront(node.id);
    },
    [bringToFront]
  );

  // Handle node drag END - sync to server only when drag stops
  const handleNodeDragStop: OnNodeDrag = React.useCallback(
    (_event, node) => {
      if (onItemChange && node.position) {
        // Use itemId (real ID) for API calls, not node.id (which may be stable key)
        const itemId = (node.data as { itemId?: string })?.itemId || node.id;
        onItemChange(itemId, { position: node.position });
      }

      if (node.type === "terminal") {
        terminalRefs.current.get(node.id)?.fit();
      }
    },
    [onItemChange]
  );

  // Handle node deletion
  const handleNodesDelete = React.useCallback(
    (deletedNodes: Node[]) => {
      if (onItemDelete) {
        // Use itemId (real ID) for API calls, not node.id (which may be stable key)
        deletedNodes.forEach((node) => {
          const itemId = (node.data as { itemId?: string })?.itemId || node.id;
          onItemDelete(itemId);
        });
      }
    },
    [onItemDelete]
  );

  React.useLayoutEffect(() => {
    if (overlayRef.current) {
      setOverlayRoot(overlayRef.current);
    }
  }, []);

  const handleInit = React.useCallback((instance: ReactFlowInstance) => {
    instanceRef.current = instance;
    const nextViewport = instance.getViewport();
    setViewport(nextViewport);
    onViewportChange?.(nextViewport);
  }, [onViewportChange]);

  const handlePaneMouseMove = React.useCallback(
    (event: React.MouseEvent) => {
      if (!onCursorMove || !instanceRef.current) return;
      const point = instanceRef.current.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      onCursorMove(point);
    },
    [onCursorMove]
  );

  const overlayContextValue = React.useMemo(
    () => ({ root: overlayRoot, viewport, zIndexVersion, bringToFront, getZIndex }),
    [overlayRoot, viewport, zIndexVersion, bringToFront, getZIndex]
  );

  return (
    <TerminalOverlayProvider value={overlayContextValue}>
      <div
        className="w-full h-full bg-[var(--background)] relative"
        onMouseMoveCapture={handlePaneMouseMove}
      >
        <ReactFlow
          nodes={nodes}
          edges={edgesToRender}
          onNodesChange={handleNodesChange}
          onEdgesChange={edgesChangeHandler}
          onNodeDragStart={handleNodeDragStart}
          onNodeDragStop={handleNodeDragStop}
          onNodesDelete={handleNodesDelete}
          onInit={handleInit}
          onPaneMouseMove={handlePaneMouseMove}
          onPaneClick={() => onCanvasClick?.()}
          onNodeClick={(event) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest(".react-flow__handle")) return;
            if (target?.closest("[data-connector=\"true\"]")) return;
            onCanvasClick?.();
          }}
          onMove={(_event, nextViewport) => {
            setViewport(nextViewport);
            onViewportChange?.(nextViewport);
          }}
          nodeTypes={nodeTypes}
          fitView={fitViewEnabled}
          fitViewOptions={{ maxZoom: 0.75 }}
          snapToGrid
          snapGrid={[16, 16]}
          nodesDraggable={!readOnly}
          nodesConnectable={false}
          elementsSelectable={!readOnly}
          panOnScroll
          selectionOnDrag
          panOnDrag={[1, 2]} // Middle and right mouse buttons for panning
          selectNodesOnDrag={false}
          autoPanOnNodeDrag={false}
          className="canvas-flow"
          proOptions={{ hideAttribution: true }}
          nodeDragThreshold={1}
        >
        {/* Dot grid background */}
        <Background
          variant={BackgroundVariant.Dots}
          gap={16}
          size={1}
          color="var(--border)"
          className="bg-[var(--background)]"
        />

        {/* Zoom controls - bottom left */}
        <Controls
          position="bottom-left"
          showZoom
          showFitView
          showInteractive={false}
          className="canvas-controls"
        />

        {/* Minimap - bottom right */}
        <MiniMap
          position="bottom-right"
          nodeColor={(node) => {
            switch (node.type) {
              case "terminal":
                return "var(--status-control-active)";
              case "note":
                return "var(--status-info)";
              case "todo":
                return "var(--accent-primary)";
              case "workspace":
                return "var(--foreground-muted)";
              case "recipe":
                return "var(--status-control-agent)";
              default:
                return "var(--foreground-muted)";
            }
          }}
          maskColor="rgba(0, 0, 0, 0.8)"
          className="canvas-minimap"
        />
        </ReactFlow>

        <div
          ref={overlayRef}
          className="absolute inset-0 z-10 pointer-events-none"
        />
      </div>
    </TerminalOverlayProvider>
  );
}

export default Canvas;
