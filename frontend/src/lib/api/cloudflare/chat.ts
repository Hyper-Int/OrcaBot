// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: chat-v3-sse-flush

/**
 * Chat API client for Orcabot conversational interface
 */

import { API } from "@/config/env";
import { apiGet, apiDelete } from "../client";
import { getAuthHeaders } from "@/stores/auth-store";

// ===== Types =====

export interface ChatMessage {
  id: string;
  userId: string;
  dashboardId: string | null;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ChatToolCall[];
  toolResults?: ChatToolResult[];
  createdAt: string;
}

export interface ChatToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatToolResult {
  toolCallId: string;
  name: string;
  result: Record<string, unknown>;
  isError?: boolean;
}

// UI Guidance command types
export type UIGuidanceCommandType =
  | "highlight"
  | "tooltip"
  | "open_panel"
  | "scroll_to"
  | "dismiss_guidance";

export interface UIGuidanceCommand {
  type: UIGuidanceCommandType;
  command_id: string;
  target?: string;
  target_description?: string;
}

export interface UIHighlightCommand extends UIGuidanceCommand {
  type: "highlight";
  duration?: number;
  style?: "pulse" | "glow" | "ring";
}

export interface UITooltipCommand extends UIGuidanceCommand {
  type: "tooltip";
  text: string;
  position?: "top" | "bottom" | "left" | "right";
  duration?: number;
}

export interface UIOpenPanelCommand extends UIGuidanceCommand {
  type: "open_panel";
  panel: string;
}

export interface UIScrollToCommand extends UIGuidanceCommand {
  type: "scroll_to";
  behavior?: "smooth" | "instant";
}

export interface UIDismissGuidanceCommand extends UIGuidanceCommand {
  type: "dismiss_guidance";
  all?: boolean;
}

export type AnyUIGuidanceCommand =
  | UIHighlightCommand
  | UITooltipCommand
  | UIOpenPanelCommand
  | UIScrollToCommand
  | UIDismissGuidanceCommand;

export type ChatStreamEvent =
  | { type: "text"; content: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; toolCallId: string; name: string; result: Record<string, unknown>; isError?: boolean }
  | { type: "ui_command"; command: AnyUIGuidanceCommand }
  | { type: "done" }
  | { type: "error"; error: string };

export interface ChatHistoryResponse {
  messages: ChatMessage[];
  hasMore: boolean;
}

// ===== API Functions =====

/**
 * Send a message and receive a streaming response
 * Returns an async generator that yields ChatStreamEvents
 */
export async function* sendChatMessage(
  message: string,
  dashboardId?: string
): AsyncGenerator<ChatStreamEvent> {
  const authHeaders = getAuthHeaders();

  const response = await fetch(API.cloudflare.chatMessage, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
    },
    credentials: "include",
    body: JSON.stringify({ message, dashboardId }),
  });

  if (!response.ok) {
    let errorMessage = `Chat request failed: ${response.status}`;
    try {
      const errorData = await response.json();
      if (errorData && typeof errorData === "object" && "error" in errorData) {
        errorMessage = String(errorData.error);
      }
    } catch {
      // Ignore JSON parse errors
    }
    yield { type: "error", error: errorMessage };
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    yield { type: "error", error: "No response body" };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process SSE events
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (!data) continue;

          try {
            const event = JSON.parse(data) as ChatStreamEvent;
            yield event;
          } catch {
            // Ignore JSON parse errors for partial data
          }
        }
      }
    }

    // Flush any remaining data in the buffer (stream may not end with \n)
    if (buffer.trim()) {
      const remaining = buffer.trim();
      if (remaining.startsWith("data: ")) {
        const data = remaining.slice(6).trim();
        if (data) {
          try {
            const event = JSON.parse(data) as ChatStreamEvent;
            yield event;
          } catch {
            // Ignore parse errors for incomplete data
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Get chat history
 */
export async function getChatHistory(
  dashboardId?: string,
  limit: number = 50
): Promise<ChatHistoryResponse> {
  const params = new URLSearchParams();
  if (dashboardId) params.set("dashboard_id", dashboardId);
  params.set("limit", String(limit));

  const url = `${API.cloudflare.chatHistory}?${params.toString()}`;
  return apiGet<ChatHistoryResponse>(url);
}

/**
 * Clear chat history
 */
export async function clearChatHistory(dashboardId?: string): Promise<void> {
  const params = new URLSearchParams();
  if (dashboardId) params.set("dashboard_id", dashboardId);

  const url = `${API.cloudflare.chatHistory}?${params.toString()}`;
  await apiDelete(url);
}
