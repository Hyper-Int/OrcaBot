"use client";

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import { Plus, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";
import { Badge } from "@/components/ui";
import { useDebouncedCallback } from "@/hooks/useDebounce";

interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
}

interface TodoData extends Record<string, unknown> {
  content: string; // JSON stringified array of TodoItem
  title?: string;
  size: { width: number; height: number };
  onContentChange?: (content: string) => void;
  connectorMode?: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
}

type TodoNode = Node<TodoData, "todo">;

export function TodoBlock({ id, data, selected }: NodeProps<TodoNode>) {
  const [title, setTitle] = React.useState(data.title || "Todo List");
  const [items, setItems] = React.useState<TodoItem[]>(() => {
    try {
      return JSON.parse(data.content || "[]");
    } catch {
      return [];
    }
  });
  const [newItemText, setNewItemText] = React.useState("");
  const [isAdding, setIsAdding] = React.useState(false);
  const connectorsVisible = selected || Boolean(data.connectorMode);

  // Sync content from server
  React.useEffect(() => {
    try {
      const serverItems = JSON.parse(data.content || "[]");
      setItems(serverItems);
    } catch {
      // Ignore parse errors
    }
  }, [data.content]);

  // Persist items to server (debounced)
  const persistItems = useDebouncedCallback(
    (newItems: TodoItem[]) => {
      data.onContentChange?.(JSON.stringify(newItems));
    },
    500
  );

  const completedCount = items.filter((item) => item.completed).length;

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
      persistItems(newItems);
      setNewItemText("");
      setIsAdding(false);
    }
  };

  const toggleItem = (id: string) => {
    const newItems = items.map((item) =>
      item.id === id ? { ...item, completed: !item.completed } : item
    );
    setItems(newItems);
    persistItems(newItems);
  };

  const removeItem = (id: string) => {
    const newItems = items.filter((item) => item.id !== id);
    setItems(newItems);
    persistItems(newItems);
  };

  return (
    <BlockWrapper
      selected={selected}
      className="p-0 flex flex-col overflow-visible"
      includeHandles={false}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] shrink-0">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="text-sm font-medium text-[var(--foreground)] bg-transparent focus:outline-none flex-1"
          title="Edit todo list title"
        />
        <Badge variant="secondary" size="sm" title={`${completedCount} of ${items.length} items completed`}>
          {completedCount}/{items.length}
        </Badge>
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
                "flex-1 text-sm",
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
              className="flex-1 text-sm bg-transparent text-[var(--foreground)] placeholder:text-[var(--foreground-subtle)] focus:outline-none"
            />
          </div>
        ) : (
          <button
            onClick={() => setIsAdding(true)}
            className="flex items-center gap-2 w-full px-2 py-1.5 text-sm text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background-hover)] rounded transition-colors"
            title="Add new todo item"
          >
            <Plus className="w-4 h-4" />
            Add item
          </button>
        )}
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
