// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: chat-v3-history-race-fix

/**
 * useChat hook for Orcabot conversational interface
 * Manages chat state, streaming responses, and message history
 */

import * as React from "react";
import {
  sendChatMessage,
  getChatHistory,
  clearChatHistory,
  type ChatMessage,
  type ChatStreamEvent,
  type ChatToolCall,
  type ChatToolResult,
  type AnyUIGuidanceCommand,
} from "@/lib/api/cloudflare/chat";

const HOOK_REVISION = "chat-v3-history-race-fix";
console.log(`[useChat] REVISION: ${HOOK_REVISION} loaded at ${new Date().toISOString()}`);

export interface PendingToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: ChatToolResult;
  status: "pending" | "executing" | "completed" | "error";
}

export interface UseChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  isStreaming: boolean;
  streamingContent: string;
  pendingToolCalls: PendingToolCall[];
  error: string | null;
}

export interface UseChatActions {
  sendMessage: (message: string) => Promise<void>;
  clearHistory: () => Promise<void>;
  loadHistory: () => Promise<void>;
}

export interface UseChatOptions {
  /** Callback when a UI guidance command is received */
  onUICommand?: (command: AnyUIGuidanceCommand) => void;
}

export interface UseChatReturn extends UseChatState, UseChatActions {}

export function useChat(dashboardId?: string, options?: UseChatOptions): UseChatReturn {
  const onUICommand = options?.onUICommand;
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isStreaming, setIsStreaming] = React.useState(false);
  const [streamingContent, setStreamingContent] = React.useState("");
  const [pendingToolCalls, setPendingToolCalls] = React.useState<PendingToolCall[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  // Guard: don't let a stale history response overwrite optimistic messages
  const sendingRef = React.useRef(false);
  // Track whether a history load was skipped during a send, so we can re-fetch after
  const historySkippedRef = React.useRef(false);

  // Load history on mount or when dashboardId changes
  const loadHistory = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { messages: history } = await getChatHistory(dashboardId);
      // Only apply if we're not mid-send (avoids overwriting optimistic messages)
      if (!sendingRef.current) {
        setMessages(history);
        historySkippedRef.current = false;
      } else {
        historySkippedRef.current = true;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load chat history");
    } finally {
      setIsLoading(false);
    }
  }, [dashboardId]);

  React.useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Send a message
  const sendMessage = React.useCallback(async (message: string) => {
    if (!message.trim()) return;

    // Add user message to local state immediately
    const userMessage: ChatMessage = {
      id: `temp_${Date.now()}`,
      userId: "",
      dashboardId: dashboardId || null,
      role: "user",
      content: message,
      createdAt: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMessage]);

    sendingRef.current = true;
    setIsStreaming(true);
    setStreamingContent("");
    setPendingToolCalls([]);
    setError(null);

    let fullContent = "";
    const toolCalls: ChatToolCall[] = [];
    const toolResults: ChatToolResult[] = [];

    try {
      for await (const event of sendChatMessage(message, dashboardId)) {
        switch (event.type) {
          case "text":
            fullContent += event.content;
            setStreamingContent(fullContent);
            break;

          case "tool_call":
            const newToolCall: PendingToolCall = {
              id: event.id,
              name: event.name,
              args: event.args,
              status: "executing",
            };
            toolCalls.push({
              id: event.id,
              name: event.name,
              args: event.args,
            });
            setPendingToolCalls(prev => [...prev, newToolCall]);
            break;

          case "tool_result":
            const result: ChatToolResult = {
              toolCallId: event.toolCallId,
              name: event.name,
              result: event.result,
              isError: event.isError,
            };
            toolResults.push(result);
            setPendingToolCalls(prev =>
              prev.map(tc =>
                tc.id === event.toolCallId
                  ? { ...tc, result, status: event.isError ? "error" : "completed" }
                  : tc
              )
            );
            break;

          case "ui_command":
            // Forward UI command to callback
            if (onUICommand) {
              onUICommand(event.command);
            }
            break;

          case "error":
            setError(event.error);
            break;

          case "done":
            // Streaming complete
            break;
        }
      }

      // Add assistant message to local state
      if (fullContent || toolCalls.length > 0) {
        const assistantMessage: ChatMessage = {
          id: `temp_${Date.now()}_assistant`,
          userId: "",
          dashboardId: dashboardId || null,
          role: "assistant",
          content: fullContent,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          toolResults: toolResults.length > 0 ? toolResults : undefined,
          createdAt: new Date().toISOString(),
        };
        setMessages(prev => [...prev, assistantMessage]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      sendingRef.current = false;
      setIsStreaming(false);
      setStreamingContent("");
      // Mark any still-executing tool calls as errored so UI doesn't show infinite spinners
      setPendingToolCalls(prev =>
        prev.map(tc =>
          tc.status === "executing" || tc.status === "pending"
            ? { ...tc, status: "error" as const }
            : tc
        )
      );
      // If a history load was skipped while we were sending, re-fetch now
      if (historySkippedRef.current) {
        historySkippedRef.current = false;
        loadHistory();
      }
    }
  }, [dashboardId, onUICommand, loadHistory]);

  // Clear history
  const clearHistoryFn = React.useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      await clearChatHistory(dashboardId);
      setMessages([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear history");
    } finally {
      setIsLoading(false);
    }
  }, [dashboardId]);

  return {
    messages,
    isLoading,
    isStreaming,
    streamingContent,
    pendingToolCalls,
    error,
    sendMessage,
    clearHistory: clearHistoryFn,
    loadHistory,
  };
}
