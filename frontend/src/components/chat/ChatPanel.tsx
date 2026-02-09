// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: chat-v5-markdown

"use client";

/**
 * ChatPanel - Orcabot Conversational Interface
 *
 * A centered floating chat input with orca avatar.
 * Messages appear in a popover above the input.
 */

const CHAT_PANEL_REVISION = "chat-v5-markdown";
console.log(`[ChatPanel] REVISION: ${CHAT_PANEL_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import Image from "next/image";
import Markdown from "react-markdown";
import { cn } from "@/lib/utils";
import {
  Send,
  Loader2,
  X,
  Trash2,
  ChevronDown,
  ChevronUp,
  Wrench,
  CheckCircle,
  XCircle,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useChat, type PendingToolCall } from "@/hooks/useChat";
import type { ChatMessage, AnyUIGuidanceCommand } from "@/lib/api/cloudflare/chat";

interface ChatPanelProps {
  dashboardId?: string;
  className?: string;
  /** Callback when a UI guidance command is received */
  onUICommand?: (command: AnyUIGuidanceCommand) => void;
}

export function ChatPanel({ dashboardId, className, onUICommand }: ChatPanelProps) {
  const [isExpanded, setIsExpanded] = React.useState(false);
  const [inputValue, setInputValue] = React.useState("");
  const messagesEndRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const {
    messages,
    isLoading,
    isStreaming,
    streamingContent,
    pendingToolCalls,
    error,
    sendMessage,
    clearHistory,
  } = useChat(dashboardId, { onUICommand });

  // Auto-scroll to bottom when new messages arrive
  React.useEffect(() => {
    if (isExpanded) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, streamingContent, pendingToolCalls, isExpanded]);

  // Auto-expand when streaming
  React.useEffect(() => {
    if (isStreaming) {
      setIsExpanded(true);
    }
  }, [isStreaming]);

  // Handle send message
  const handleSend = async () => {
    const message = inputValue.trim();
    if (!message || isStreaming) return;

    setInputValue("");
    setIsExpanded(true);
    await sendMessage(message);
  };

  // Handle key press (Enter to send)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Render a single message
  const renderMessage = (msg: ChatMessage) => {
    const isUser = msg.role === "user";
    const isAssistant = msg.role === "assistant";

    return (
      <div
        key={msg.id}
        className={cn(
          "flex gap-3 py-2",
          isUser ? "justify-end" : "justify-start"
        )}
      >
        {!isUser && (
          <div className="flex-shrink-0 w-8 h-8 rounded-full overflow-hidden bg-gradient-to-br from-cyan-400 to-blue-500">
            <Image
              src="/orca.png"
              alt="Orcabot"
              width={32}
              height={32}
              className="w-full h-full object-cover"
            />
          </div>
        )}
        <div
          className={cn(
            "max-w-[80%] rounded-2xl px-4 py-2",
            isUser
              ? "bg-primary text-primary-foreground"
              : "bg-muted"
          )}
        >
          <div className="text-sm max-w-none [&_p]:my-1 [&_h1]:my-2 [&_h2]:my-2 [&_h3]:my-2 [&_code]:bg-background-surface [&_code]:px-1 [&_code]:rounded" style={{ color: 'var(--foreground)' }}>
            <Markdown>{msg.content}</Markdown>
          </div>
          {/* Render tool calls for assistant messages */}
          {isAssistant && msg.toolCalls && msg.toolCalls.length > 0 && (
            <div className="mt-2 space-y-1">
              {msg.toolCalls.map((tc) => {
                const result = msg.toolResults?.find(
                  (tr) => tr.toolCallId === tc.id
                );
                return (
                  <ToolCallDisplay
                    key={tc.id}
                    name={tc.name}
                    result={result?.result}
                    isError={result?.isError}
                    status="completed"
                  />
                );
              })}
            </div>
          )}
        </div>
        {isUser && (
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center">
            <User className="w-4 h-4 text-muted-foreground" />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={cn("fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-xl px-4", className)}>
      {/* Messages Panel */}
      {isExpanded && (
        <div className="mb-3 bg-background/95 backdrop-blur-lg border rounded-2xl shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
            <span className="text-sm font-medium">Orcabot</span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => clearHistory()}
                disabled={isLoading || isStreaming || messages.length === 0}
                className="h-7 w-7 p-0"
                title="Clear history"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsExpanded(false)}
                className="h-7 w-7 p-0"
              >
                <ChevronDown className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {/* Messages */}
          <div className="max-h-[50vh] overflow-y-auto p-4">
            {isLoading && messages.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : messages.length === 0 && !isStreaming ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <div className="w-16 h-16 rounded-full overflow-hidden mb-4 ring-4 ring-primary/20">
                  <Image
                    src="/orca.png"
                    alt="Orcabot"
                    width={64}
                    height={64}
                    className="w-full h-full object-cover"
                  />
                </div>
                <p className="text-sm text-muted-foreground">
                  Ask me to set up dashboards, terminals, or integrations.
                </p>
              </div>
            ) : (
              <>
                {messages.filter(m => m.role !== "tool").map(renderMessage)}

                {/* Streaming response */}
                {isStreaming && (
                  <div className="flex gap-3 py-2">
                    <div className="flex-shrink-0 w-8 h-8 rounded-full overflow-hidden bg-gradient-to-br from-cyan-400 to-blue-500">
                      <Image
                        src="/orca.png"
                        alt="Orcabot"
                        width={32}
                        height={32}
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <div className="max-w-[80%] rounded-2xl px-4 py-2 bg-muted">
                      {streamingContent ? (
                        <div className="text-sm max-w-none [&_p]:my-1 [&_code]:bg-background-surface [&_code]:px-1 [&_code]:rounded" style={{ color: 'var(--foreground)' }}>
                          <Markdown>{streamingContent}</Markdown>
                          <span className="inline-block w-1.5 h-4 bg-primary/60 animate-pulse ml-0.5 rounded-sm" />
                        </div>
                      ) : pendingToolCalls.length > 0 ? (
                        <div className="space-y-1">
                          {pendingToolCalls.map((tc) => (
                            <ToolCallDisplay
                              key={tc.id}
                              name={tc.name}
                              result={tc.result?.result}
                              isError={tc.result?.isError}
                              status={tc.status}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>Thinking...</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Error message */}
            {error && (
              <div className="p-3 rounded-xl bg-destructive/10 text-destructive text-sm mt-2">
                {error}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>
      )}

      {/* Input Bar */}
      <div className="relative">
        <div
          className={cn(
            "flex items-center gap-2 bg-background/95 backdrop-blur-lg",
            "border rounded-full shadow-lg px-3 py-1",
            "ring-1 ring-black/5 dark:ring-white/10"
          )}
        >
          {/* Input */}
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => messages.length > 0 && setIsExpanded(true)}
            placeholder="Ask Orcabot..."
            disabled={isStreaming}
            className={cn(
              "flex-1 bg-transparent border-0 outline-none",
              "text-xs placeholder:text-muted-foreground",
              "disabled:opacity-50"
            )}
          />

          {/* Expand/Collapse button (when has messages) */}
          {messages.length > 0 && !isExpanded && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsExpanded(true)}
              className="h-6 w-6 p-0 rounded-full"
            >
              <ChevronUp className="w-3.5 h-3.5" />
            </Button>
          )}

          {/* Send Button */}
          <Button
            onClick={handleSend}
            disabled={!inputValue.trim() || isStreaming}
            size="sm"
            className="h-6 w-6 p-0 rounded-full"
          >
            {isStreaming ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Send className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Minimal tool call display
interface ToolCallDisplayProps {
  name: string;
  result?: Record<string, unknown>;
  isError?: boolean;
  status: "pending" | "executing" | "completed" | "error";
}

function ToolCallDisplay({ name, result, isError, status }: ToolCallDisplayProps) {
  // Format tool name for display
  const displayName = name.replace(/_/g, " ");

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs",
        isError
          ? "bg-destructive/20 text-destructive"
          : status === "completed"
          ? "bg-green-500/20 text-green-700 dark:text-green-400"
          : "bg-muted-foreground/20"
      )}
    >
      {status === "executing" ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : status === "completed" && !isError ? (
        <CheckCircle className="w-3 h-3" />
      ) : status === "error" || isError ? (
        <XCircle className="w-3 h-3" />
      ) : (
        <Wrench className="w-3 h-3" />
      )}
      <span className="capitalize">{displayName}</span>
    </div>
  );
}

export default ChatPanel;
