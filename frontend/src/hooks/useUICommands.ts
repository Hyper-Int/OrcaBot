// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Hook for executing UI commands from agents
 *
 * Listens to the dashboard WebSocket for UI commands and executes them
 * by calling the appropriate item creation/update/delete functions.
 */

import * as React from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { DashboardItem, DashboardEdge } from "@/types/dashboard";
import type {
  UICommand,
  UICommandResultMessage,
  CreateBrowserCommand,
  CreateTodoCommand,
  CreateNoteCommand,
  CreateTerminalCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  ConnectNodesCommand,
  DisconnectNodesCommand,
  NavigateBrowserCommand,
  AddTodoItemCommand,
  ToggleTodoItemCommand,
} from "@/types/collaboration";
import { generateId } from "@/lib/utils";

interface TodoContent {
  title: string;
  items: Array<{ id: string; text: string; completed: boolean }>;
}

interface TerminalContent {
  name: string;
  agentic: boolean;
  bootCommand: string;
}

// Default sizes for different block types
const defaultSizes: Record<string, { width: number; height: number }> = {
  note: { width: 200, height: 120 },
  todo: { width: 280, height: 160 },
  terminal: { width: 360, height: 400 },
  browser: { width: 520, height: 360 },
};

interface UseUICommandsOptions {
  dashboardId: string;
  items: DashboardItem[];
  edges: DashboardEdge[];
  createItemMutation: UseMutationResult<
    DashboardItem,
    Error,
    {
      type: DashboardItem["type"];
      content: string;
      position: { x: number; y: number };
      size: { width: number; height: number };
      metadata?: Record<string, unknown>;
      sourceId?: string;
      sourceHandle?: string;
      targetHandle?: string;
    }
  >;
  updateItemMutation: UseMutationResult<
    DashboardItem,
    Error,
    { itemId: string; changes: Partial<DashboardItem> }
  >;
  deleteItemMutation: UseMutationResult<void, Error, string>;
  createEdgeFn?: (edge: {
    sourceItemId: string;
    targetItemId: string;
    sourceHandle?: string;
    targetHandle?: string;
  }) => Promise<void>;
  deleteEdgeFn?: (edgeId: string) => Promise<void>;
  onCommandExecuted?: (result: UICommandResultMessage) => void;
}

export function useUICommands({
  dashboardId,
  items,
  edges,
  createItemMutation,
  updateItemMutation,
  deleteItemMutation,
  createEdgeFn,
  deleteEdgeFn,
  onCommandExecuted,
}: UseUICommandsOptions) {
  // Track pending commands to avoid duplicates
  const pendingCommandsRef = React.useRef<Set<string>>(new Set());

  // Place MCP-created items at a fixed center position
  const getNextPosition = React.useCallback((): { x: number; y: number } => {
    // Fixed center position - visible on most screen sizes
    return { x: 400, y: 300 };
  }, []);

  // Send command result back to the WebSocket
  const sendResult = React.useCallback(
    (result: UICommandResultMessage) => {
      onCommandExecuted?.(result);
    },
    [onCommandExecuted]
  );

  // Execute a UI command
  const executeCommand = React.useCallback(
    async (command: UICommand) => {
      // Check for duplicate command
      if (pendingCommandsRef.current.has(command.command_id)) {
        console.warn(`Duplicate UI command ignored: ${command.command_id}`);
        return;
      }
      pendingCommandsRef.current.add(command.command_id);

      try {
        switch (command.type) {
          case "create_browser": {
            const cmd = command as CreateBrowserCommand;
            const position = cmd.position || getNextPosition();
            const size = cmd.size || defaultSizes.browser;

            createItemMutation.mutate(
              {
                type: "browser",
                content: cmd.url,
                position,
                size,
              },
              {
                onSuccess: (item) => {
                  sendResult({
                    type: "ui_command_result",
                    command_id: command.command_id,
                    success: true,
                    created_item_id: item.id,
                  });
                },
                onError: (error) => {
                  sendResult({
                    type: "ui_command_result",
                    command_id: command.command_id,
                    success: false,
                    error: error.message,
                  });
                },
              }
            );
            break;
          }

          case "create_todo": {
            const cmd = command as CreateTodoCommand;
            const position = cmd.position || getNextPosition();
            const size = cmd.size || defaultSizes.todo;

            const todoContent: TodoContent = {
              title: cmd.title,
              items: (cmd.items || []).map((item) => ({
                id: generateId(),
                text: item.text,
                completed: item.completed ?? false,
              })),
            };

            createItemMutation.mutate(
              {
                type: "todo",
                content: JSON.stringify(todoContent),
                position,
                size,
              },
              {
                onSuccess: (item) => {
                  sendResult({
                    type: "ui_command_result",
                    command_id: command.command_id,
                    success: true,
                    created_item_id: item.id,
                  });
                },
                onError: (error) => {
                  sendResult({
                    type: "ui_command_result",
                    command_id: command.command_id,
                    success: false,
                    error: error.message,
                  });
                },
              }
            );
            break;
          }

          case "create_note": {
            const cmd = command as CreateNoteCommand;
            const position = cmd.position || getNextPosition();
            const size = cmd.size || defaultSizes.note;

            // Pass color via metadata for NoteBlock to consume
            const metadata = cmd.color ? { color: cmd.color } : undefined;
            createItemMutation.mutate(
              {
                type: "note",
                content: cmd.text,
                position,
                size,
                metadata,
              },
              {
                onSuccess: (item) => {
                  sendResult({
                    type: "ui_command_result",
                    command_id: command.command_id,
                    success: true,
                    created_item_id: item.id,
                  });
                },
                onError: (error) => {
                  sendResult({
                    type: "ui_command_result",
                    command_id: command.command_id,
                    success: false,
                    error: error.message,
                  });
                },
              }
            );
            break;
          }

          case "create_terminal": {
            const cmd = command as CreateTerminalCommand;
            const position = cmd.position || getNextPosition();
            const size = cmd.size || defaultSizes.terminal;

            const terminalContent: TerminalContent = {
              name: cmd.name || "Terminal",
              agentic: false,
              bootCommand: "",
            };

            createItemMutation.mutate(
              {
                type: "terminal",
                content: JSON.stringify(terminalContent),
                position,
                size,
              },
              {
                onSuccess: (item) => {
                  sendResult({
                    type: "ui_command_result",
                    command_id: command.command_id,
                    success: true,
                    created_item_id: item.id,
                  });
                },
                onError: (error) => {
                  sendResult({
                    type: "ui_command_result",
                    command_id: command.command_id,
                    success: false,
                    error: error.message,
                  });
                },
              }
            );
            break;
          }

          case "update_item": {
            const cmd = command as UpdateItemCommand;

            const changes: Partial<DashboardItem> = {};
            if (cmd.content !== undefined) {
              changes.content = cmd.content;
            }
            if (cmd.position !== undefined) {
              changes.position = cmd.position;
            }
            if (cmd.size !== undefined) {
              changes.size = cmd.size;
            }

            updateItemMutation.mutate(
              { itemId: cmd.item_id, changes },
              {
                onSuccess: () => {
                  sendResult({
                    type: "ui_command_result",
                    command_id: command.command_id,
                    success: true,
                  });
                },
                onError: (error) => {
                  sendResult({
                    type: "ui_command_result",
                    command_id: command.command_id,
                    success: false,
                    error: error.message,
                  });
                },
              }
            );
            break;
          }

          case "delete_item": {
            const cmd = command as DeleteItemCommand;

            deleteItemMutation.mutate(cmd.item_id, {
              onSuccess: () => {
                sendResult({
                  type: "ui_command_result",
                  command_id: command.command_id,
                  success: true,
                });
              },
              onError: (error) => {
                sendResult({
                  type: "ui_command_result",
                  command_id: command.command_id,
                  success: false,
                  error: error.message,
                });
              },
            });
            break;
          }

          case "connect_nodes": {
            const cmd = command as ConnectNodesCommand;

            if (!createEdgeFn) {
              sendResult({
                type: "ui_command_result",
                command_id: command.command_id,
                success: false,
                error: "Edge creation not supported",
              });
              break;
            }

            try {
              await createEdgeFn({
                sourceItemId: cmd.source_item_id,
                targetItemId: cmd.target_item_id,
                sourceHandle: cmd.source_handle,
                targetHandle: cmd.target_handle,
              });
              sendResult({
                type: "ui_command_result",
                command_id: command.command_id,
                success: true,
              });
            } catch (error) {
              sendResult({
                type: "ui_command_result",
                command_id: command.command_id,
                success: false,
                error: error instanceof Error ? error.message : "Failed to create edge",
              });
            }
            break;
          }

          case "disconnect_nodes": {
            const cmd = command as DisconnectNodesCommand;

            if (!deleteEdgeFn) {
              sendResult({
                type: "ui_command_result",
                command_id: command.command_id,
                success: false,
                error: "Edge deletion not supported",
              });
              break;
            }

            // Find the edge connecting these nodes (match handles if provided)
            const edge = edges.find(
              (e) =>
                e.sourceItemId === cmd.source_item_id &&
                e.targetItemId === cmd.target_item_id &&
                (cmd.source_handle === undefined || e.sourceHandle === cmd.source_handle) &&
                (cmd.target_handle === undefined || e.targetHandle === cmd.target_handle)
            );

            if (!edge) {
              sendResult({
                type: "ui_command_result",
                command_id: command.command_id,
                success: false,
                error: "Edge not found",
              });
              break;
            }

            try {
              await deleteEdgeFn(edge.id);
              sendResult({
                type: "ui_command_result",
                command_id: command.command_id,
                success: true,
              });
            } catch (error) {
              sendResult({
                type: "ui_command_result",
                command_id: command.command_id,
                success: false,
                error: error instanceof Error ? error.message : "Failed to delete edge",
              });
            }
            break;
          }

          case "navigate_browser": {
            const cmd = command as NavigateBrowserCommand;

            // Find the browser item and update its content
            const browserItem = items.find((i) => i.id === cmd.item_id);
            if (!browserItem || browserItem.type !== "browser") {
              sendResult({
                type: "ui_command_result",
                command_id: command.command_id,
                success: false,
                error: "Browser item not found",
              });
              break;
            }

            updateItemMutation.mutate(
              { itemId: cmd.item_id, changes: { content: cmd.url } },
              {
                onSuccess: () => {
                  sendResult({
                    type: "ui_command_result",
                    command_id: command.command_id,
                    success: true,
                  });
                },
                onError: (error) => {
                  sendResult({
                    type: "ui_command_result",
                    command_id: command.command_id,
                    success: false,
                    error: error.message,
                  });
                },
              }
            );
            break;
          }

          case "add_todo_item": {
            const cmd = command as AddTodoItemCommand;

            // Find the todo item
            const todoItem = items.find((i) => i.id === cmd.item_id);
            if (!todoItem || todoItem.type !== "todo") {
              sendResult({
                type: "ui_command_result",
                command_id: command.command_id,
                success: false,
                error: "Todo item not found",
              });
              break;
            }

            // Parse current content and add new item
            let todoContent: TodoContent;
            try {
              todoContent = JSON.parse(todoItem.content);
            } catch {
              todoContent = { title: "Todo", items: [] };
            }

            todoContent.items.push({
              id: generateId(),
              text: cmd.text,
              completed: cmd.completed ?? false,
            });

            updateItemMutation.mutate(
              { itemId: cmd.item_id, changes: { content: JSON.stringify(todoContent) } },
              {
                onSuccess: () => {
                  sendResult({
                    type: "ui_command_result",
                    command_id: command.command_id,
                    success: true,
                  });
                },
                onError: (error) => {
                  sendResult({
                    type: "ui_command_result",
                    command_id: command.command_id,
                    success: false,
                    error: error.message,
                  });
                },
              }
            );
            break;
          }

          case "toggle_todo_item": {
            const cmd = command as ToggleTodoItemCommand;

            // Find the todo item
            const todoItem = items.find((i) => i.id === cmd.item_id);
            if (!todoItem || todoItem.type !== "todo") {
              sendResult({
                type: "ui_command_result",
                command_id: command.command_id,
                success: false,
                error: "Todo item not found",
              });
              break;
            }

            // Parse current content and toggle the item
            let todoContent: TodoContent;
            try {
              todoContent = JSON.parse(todoItem.content);
            } catch {
              sendResult({
                type: "ui_command_result",
                command_id: command.command_id,
                success: false,
                error: "Invalid todo content",
              });
              break;
            }

            const todoItemIndex = todoContent.items.findIndex(
              (i) => i.id === cmd.todo_item_id
            );
            if (todoItemIndex === -1) {
              sendResult({
                type: "ui_command_result",
                command_id: command.command_id,
                success: false,
                error: "Todo sub-item not found",
              });
              break;
            }

            todoContent.items[todoItemIndex].completed =
              !todoContent.items[todoItemIndex].completed;

            updateItemMutation.mutate(
              { itemId: cmd.item_id, changes: { content: JSON.stringify(todoContent) } },
              {
                onSuccess: () => {
                  sendResult({
                    type: "ui_command_result",
                    command_id: command.command_id,
                    success: true,
                  });
                },
                onError: (error) => {
                  sendResult({
                    type: "ui_command_result",
                    command_id: command.command_id,
                    success: false,
                    error: error.message,
                  });
                },
              }
            );
            break;
          }

          default: {
            // This should never happen if all command types are handled
            const unknownCommand = command as UICommand;
            sendResult({
              type: "ui_command_result",
              command_id: unknownCommand.command_id,
              success: false,
              error: `Unknown command type: ${unknownCommand.type}`,
            });
          }
        }
      } finally {
        // Remove from pending after a delay to prevent immediate re-execution
        setTimeout(() => {
          pendingCommandsRef.current.delete(command.command_id);
        }, 5000);
      }
    },
    [
      items,
      edges,
      getNextPosition,
      createItemMutation,
      updateItemMutation,
      deleteItemMutation,
      createEdgeFn,
      deleteEdgeFn,
      sendResult,
    ]
  );

  return {
    executeCommand,
  };
}
