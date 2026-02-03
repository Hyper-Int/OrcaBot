// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: todo-settings-v1-font-size-duplicate

"use client";

const TODO_BLOCK_REVISION = "todo-settings-v1-font-size-duplicate";
console.log(`[TodoBlock] REVISION: ${TODO_BLOCK_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import { Plus, Check, X, CheckSquare, Minimize2, Settings, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";
import { MinimizedBlockView, MINIMIZED_SIZE } from "./MinimizedBlockView";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui";
import { useDebouncedCallback } from "@/hooks/useDebounce";
import { useConnectionDataFlow } from "@/contexts/ConnectionDataFlowContext";
import type { DashboardItem } from "@/types/dashboard";

interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
}

type FontSizeSetting = "small" | "medium" | "large" | "xlarge";

const FONT_SIZES: Record<FontSizeSetting, { label: string; className: string }> = {
  small:  { label: "Small",  className: "text-[10px]" },
  medium: { label: "Medium", className: "text-sm" },
  large:  { label: "Large",  className: "text-base" },
  xlarge: { label: "X-Large", className: "text-lg" },
};

interface TodoData extends Record<string, unknown> {
  content: string; // JSON stringified array of TodoItem
  title?: string;
  size: { width: number; height: number };
  metadata?: { minimized?: boolean; fontSize?: FontSizeSetting; [key: string]: unknown };
  onContentChange?: (content: string) => void;
  onItemChange?: (changes: Partial<DashboardItem>) => void;
  onDuplicate?: () => void;
  connectorMode?: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
}

type TodoNode = Node<TodoData, "todo">;

// Parse content which can be either:
// - Old format: JSON array of items
// - New format: JSON object with { title, items }
function parseContent(content: string): { title: string; items: TodoItem[] } {
  try {
    const parsed = JSON.parse(content || "[]");
    if (Array.isArray(parsed)) {
      // Old format: just an array of items
      return { title: "Todo List", items: parsed };
    } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.items)) {
      // New format: object with title and items
      return { title: parsed.title || "Todo List", items: parsed.items };
    }
    return { title: "Todo List", items: [] };
  } catch {
    return { title: "Todo List", items: [] };
  }
}

export function TodoBlock({ id, data, selected }: NodeProps<TodoNode>) {
  const initialParsed = React.useMemo(() => parseContent(data.content), []);
  const [title, setTitle] = React.useState(data.title || initialParsed.title);
  const [items, setItems] = React.useState<TodoItem[]>(initialParsed.items);
  const [newItemText, setNewItemText] = React.useState("");
  const [isAdding, setIsAdding] = React.useState(false);
  const fontSizeSetting = (data.metadata?.fontSize as FontSizeSetting) || "medium";
  const connectorsVisible = selected || Boolean(data.connectorMode);
  const isMinimized = data.metadata?.minimized === true;
  const [expandAnimation, setExpandAnimation] = React.useState<string | null>(null);
  const [isAnimatingMinimize, setIsAnimatingMinimize] = React.useState(false);
  const minimizeTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (minimizeTimeoutRef.current) clearTimeout(minimizeTimeoutRef.current);
    };
  }, []);

  const handleMinimize = () => {
    const expandedSize = data.size;
    setIsAnimatingMinimize(true);
    data.onItemChange?.({
      metadata: { ...data.metadata, expandedSize },
      size: MINIMIZED_SIZE,
    });
    minimizeTimeoutRef.current = setTimeout(() => {
      setIsAnimatingMinimize(false);
      data.onItemChange?.({
        metadata: { ...data.metadata, minimized: true, expandedSize },
      });
    }, 350);
  };

  const handleExpand = () => {
    const savedSize = data.metadata?.expandedSize as { width: number; height: number } | undefined;
    setExpandAnimation("animate-expand-bounce");
    setTimeout(() => setExpandAnimation(null), 300);
    data.onItemChange?.({
      metadata: { ...data.metadata, minimized: false },
      size: savedSize || { width: 250, height: 300 },
    });
  };

  // Sync content from server
  React.useEffect(() => {
    const parsed = parseContent(data.content);
    setItems(parsed.items);
    // Only update title if it comes from new format (not default)
    if (parsed.title !== "Todo List" || !title) {
      setTitle(parsed.title);
    }
  }, [data.content]);

  // Persist items to server (debounced)
  // Save in new format with title to preserve it
  const persistItems = useDebouncedCallback(
    (newItems: TodoItem[], currentTitle: string) => {
      data.onContentChange?.(JSON.stringify({ title: currentTitle, items: newItems }));
    },
    500
  );

  const completedCount = items.filter((item) => item.completed).length;

  const handleFontSizeChange = React.useCallback(
    (value: string) => {
      data.onItemChange?.({
        metadata: { ...data.metadata, fontSize: value as FontSizeSetting },
      });
    },
    [data]
  );

  const addItem = () => {
    if (newItemText.trim()) {
      const newItems = [
        ...items,
        {
          id: crypto.randomUUID(),
          text: newItemText.trim(),
          completed: false,
        },
      ];
      setItems(newItems);
      persistItems(newItems, title);
      setNewItemText("");
      setIsAdding(false);
    }
  };

  const toggleItem = (id: string) => {
    const newItems = items.map((item) =>
      item.id === id ? { ...item, completed: !item.completed } : item
    );
    setItems(newItems);
    persistItems(newItems, title);
  };

  const removeItem = (itemId: string) => {
    const newItems = items.filter((item) => item.id !== itemId);
    setItems(newItems);
    persistItems(newItems, title);
  };

  // Register handlers for incoming data from connections (both left and top inputs)
  const connectionFlow = useConnectionDataFlow();
  React.useEffect(() => {
    if (!connectionFlow) return;

    const handler = (payload: { text: string }) => {
      if (payload.text) {
        const newItems = [
          ...items,
          {
            id: crypto.randomUUID(),
            text: payload.text.trim(),
            completed: false,
          },
        ];
        setItems(newItems);
        persistItems(newItems, title);
      }
    };

    const cleanupLeft = connectionFlow.registerInputHandler(id, "left-in", handler);
    const cleanupTop = connectionFlow.registerInputHandler(id, "top-in", handler);

    return () => {
      cleanupLeft();
      cleanupTop();
    };
  }, [id, connectionFlow, items, persistItems]);

  // Minimized view - only show when fully minimized (not during animation)
  if (isMinimized && !isAnimatingMinimize) {
    return (
      <MinimizedBlockView
        nodeId={id}
        selected={selected}
        icon={<CheckSquare className="w-14 h-14 text-[var(--accent-primary)]" />}
        label={`${title} (${completedCount}/${items.length})`}
        onExpand={handleExpand}
        connectorsVisible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
    );
  }

  return (
    <BlockWrapper
      selected={selected}
      className={cn("p-0 flex flex-col overflow-visible", expandAnimation)}
      includeHandles={false}
    >
      {/* All content fades during minimize */}
      <div className={cn("flex flex-col flex-1 overflow-hidden", isAnimatingMinimize && "animate-content-fade-out")}>
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] shrink-0">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="text-sm font-medium text-[var(--foreground)] bg-transparent focus:outline-none flex-1"
            title="Edit todo list title"
          />
          <div className="flex items-center gap-1">
            <Badge variant="secondary" size="sm" title={`${completedCount} of ${items.length} items completed`}>
              {completedCount}/{items.length}
            </Badge>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="nodrag h-5 w-5" title="Settings">
                  <Settings className="w-3 h-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="gap-2">
                    <span>Font Size</span>
                    <span className="ml-auto text-[10px] text-[var(--foreground-muted)]">
                      {FONT_SIZES[fontSizeSetting].label}
                    </span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup
                      value={fontSizeSetting}
                      onValueChange={handleFontSizeChange}
                    >
                      {Object.entries(FONT_SIZES).map(([key, { label }]) => (
                        <DropdownMenuRadioItem key={key} value={key}>{label}</DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => data.onDuplicate?.()} className="gap-2">
                  <Copy className="w-3 h-3" />
                  <span>Duplicate</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleMinimize}
              title="Minimize"
              className="nodrag h-5 w-5"
            >
              <Minimize2 className="w-3 h-3" />
            </Button>
          </div>
        </div>

        {/* Items */}
        <div className="p-2 space-y-1 flex-1 overflow-y-auto">
        {items.map((item) => (
          <div
            key={item.id}
            className="group flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--background-hover)]"
          >
            <button
              onClick={() => toggleItem(item.id)}
              className={cn(
                "w-4 h-4 rounded border flex items-center justify-center transition-colors",
                item.completed
                  ? "bg-[var(--status-success)] border-[var(--status-success)] text-white"
                  : "border-[var(--border-strong)] hover:border-[var(--accent-primary)]"
              )}
              title={item.completed ? "Mark as incomplete" : "Mark as complete"}
            >
              {item.completed && <Check className="w-3 h-3" />}
            </button>
            <span
              className={cn(
                "flex-1",
                FONT_SIZES[fontSizeSetting].className,
                item.completed
                  ? "text-[var(--foreground-subtle)] line-through"
                  : "text-[var(--foreground)]"
              )}
            >
              {item.text}
            </span>
            <button
              onClick={() => removeItem(item.id)}
              className="opacity-0 group-hover:opacity-100 p-1 hover:bg-[var(--background-hover)] rounded transition-opacity"
              title="Remove item"
            >
              <X className="w-3 h-3 text-[var(--foreground-subtle)]" />
            </button>
          </div>
        ))}

        {/* Add item input */}
        {isAdding ? (
          <div className="flex items-center gap-2 px-2 py-1.5">
            <div className="w-4 h-4" />
            <input
              autoFocus
              value={newItemText}
              onChange={(e) => setNewItemText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addItem();
                if (e.key === "Escape") {
                  setIsAdding(false);
                  setNewItemText("");
                }
              }}
              onBlur={() => {
                if (!newItemText.trim()) setIsAdding(false);
              }}
              placeholder="New item..."
              className={cn("flex-1 bg-transparent text-[var(--foreground)] placeholder:text-[var(--foreground-subtle)] focus:outline-none", FONT_SIZES[fontSizeSetting].className)}
            />
          </div>
        ) : (
          <button
            onClick={() => setIsAdding(true)}
            className={cn("flex items-center gap-2 w-full px-2 py-1.5 text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background-hover)] rounded transition-colors", FONT_SIZES[fontSizeSetting].className)}
            title="Add new todo item"
          >
            <Plus className="w-4 h-4" />
            Add item
          </button>
        )}
        </div>
      </div>
      <ConnectionHandles
        nodeId={id}
        visible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
    </BlockWrapper>
  );
}

export default TodoBlock;
