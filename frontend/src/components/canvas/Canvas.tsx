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
  type OnNodeDragStart,
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
  ) => void
): Node[] {
  const workspaceSession = sessions.find((s) => s.status === "active");
  return items.map((item) => {
    // Find active session for terminal items
    const session = item.type === "terminal"
      ? sessions.find((s) => s.itemId === item.id && s.status === "active")
      : undefined;

    return {
      id: item.id,
      type: item.type,
      position: item.position,
      // React Flow v12 requires width/height on node for drag before measurement
      width: item.size.width,
      height: item.size.height,
      data: {
        content: item.content,
        size: item.size,
        dashboardId: item.dashboardId,
        session, // Pass session to terminal blocks
        sessionId: item.type === "workspace" ? workspaceSession?.id : undefined,
        onRegisterTerminal,
        onCreateBrowserBlock,
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
  fitViewEnabled?: boolean;
  edges?: Edge[];
  onEdgesChange?: (changes: EdgeChange[]) => void;
  readOnly?: boolean;
}

export function Canvas({
  items,
  sessions = [],
  onItemChange,
  onItemCreate,
  onItemDelete,
  onCreateBrowserBlock,
  onViewportChange,
  fitViewEnabled = true,
  edges: controlledEdges,
  onEdgesChange: onEdgesChangeProp,
  readOnly = false,
}: CanvasProps) {
  const overlayRef = React.useRef<HTMLDivElement>(null);
  const [overlayRoot, setOverlayRoot] = React.useState<HTMLDivElement | null>(null);
  const [viewport, setViewport] = React.useState({ x: 0, y: 0, zoom: 1 });
  const { zIndexVersion, bringToFront, getZIndex } = useTerminalZIndex();
  const terminalRefs = React.useRef<Map<string, TerminalHandle>>(new Map());
  const applyZIndex = React.useCallback(
    (nextNodes: Node[]) =>
      nextNodes.map((node) => {
        const base = getZIndex(node.id);
        const zIndex = node.type === "terminal" ? base + 10000 : base;
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
  const [nodes, setNodes, onNodesChange] = useNodesState(
    applyZIndex(
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
        onCreateBrowserBlock
      )
    )
  );
  const [edges, , onEdgesChange] = useEdgesState([]);
  const edgesToRender = controlledEdges ?? edges;
  const edgesChangeHandler = controlledEdges ? onEdgesChangeProp : onEdgesChange;

  // Update nodes when items or sessions change from server
  React.useEffect(() => {
    setNodes(
      applyZIndex(
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
          onCreateBrowserBlock
        )
      )
    );
  }, [items, sessions, setNodes, onItemChange, readOnly, onCreateBrowserBlock, applyZIndex]);

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
            // When resizing from top/left edges, position also changes
            // Include both size and position to keep the correct corner anchored
            onItemChange(change.id, {
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

  const handleNodeDragStart: OnNodeDragStart = React.useCallback(
    (_event, node) => {
      bringToFront(node.id);
    },
    [bringToFront]
  );

  // Handle node drag END - sync to server only when drag stops
  const handleNodeDragStop: OnNodeDrag = React.useCallback(
    (_event, node) => {
      if (onItemChange && node.position) {
        onItemChange(node.id, { position: node.position });
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
        deletedNodes.forEach((node) => onItemDelete(node.id));
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
    const nextViewport = instance.getViewport();
    setViewport(nextViewport);
    onViewportChange?.(nextViewport);
  }, [onViewportChange]);

  const overlayContextValue = React.useMemo(
    () => ({ root: overlayRoot, viewport, zIndexVersion, bringToFront, getZIndex }),
    [overlayRoot, viewport, zIndexVersion, bringToFront, getZIndex]
  );

  return (
    <TerminalOverlayProvider value={overlayContextValue}>
      <div className="w-full h-full bg-[var(--background)] relative">
        <ReactFlow
          nodes={nodes}
          edges={edgesToRender}
          onNodesChange={handleNodesChange}
          onEdgesChange={edgesChangeHandler}
          onNodeDragStart={handleNodeDragStart}
          onNodeDragStop={handleNodeDragStop}
          onNodesDelete={handleNodesDelete}
          onInit={handleInit}
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
