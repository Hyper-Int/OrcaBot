// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: chat-v26-ring-border

"use client";

/**
 * ChatPanel - Orcabot Conversational Interface
 *
 * A centered floating chat panel with input on top and messages below.
 * Input bar stays at splash position during transition; messages grow downward.
 * Supports smooth handoff from splash page transition overlay.
 */

const CHAT_PANEL_REVISION = "chat-v26-ring-border";
console.log(`[ChatPanel] REVISION: ${CHAT_PANEL_REVISION} loaded at ${new Date().toISOString()}`);

// Fixed height for the input bar (py-2.5 = 20px padding + ~24px content = 44px).
// Using a constant avoids reading a DOM ref during render, which breaks HMR.
const INPUT_BAR_HEIGHT = 44;

import * as React from "react";
import Image from "next/image";
import Markdown from "react-markdown";
import { cn } from "@/lib/utils";
import {
  Send,
  Loader2,
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
import { useSplashTransitionStore } from "@/stores/splash-transition-store";

interface ChatPanelProps {
  dashboardId?: string;
  className?: string;
  /** Callback when a UI guidance command is received */
  onUICommand?: (command: AnyUIGuidanceCommand) => void;
}

export function ChatPanel({ dashboardId, className, onUICommand }: ChatPanelProps) {
  const [isExpanded, setIsExpanded] = React.useState(!!dashboardId);
  const [inputValue, setInputValue] = React.useState("");
  const inputBarRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const initialPromptConsumedRef = React.useRef(false);

  // Splash transition integration
  const transitionPhase = useSplashTransitionStore((s) => s.phase);
  const transitionPrompt = useSplashTransitionStore((s) => s.prompt);
  const transitionDashboardId = useSplashTransitionStore((s) => s.targetDashboardId);
  const setChatPanelReady = useSplashTransitionStore((s) => s.setChatPanelReady);

  // Is this ChatPanel the target of an active splash transition?
  const isTransitionTarget =
    transitionPhase !== "idle" &&
    transitionPhase !== "done" &&
    !!dashboardId &&
    dashboardId === transitionDashboardId;

  // Track fade-in state for handoff
  const [transitionVisible, setTransitionVisible] = React.useState(false);
  const startBottom = useSplashTransitionStore((s) => s.startBottom);
  // Initialize from isTransitionTarget so the splash layout is correct on the
  // very first render — no one-frame flash of the normal (small) layout.
  const [isAtSplashPosition, setIsAtSplashPosition] = React.useState(isTransitionTarget);

  // Signal ready to the overlay when this panel mounts as the transition target
  React.useEffect(() => {
    if (!isTransitionTarget) return;
    setIsAtSplashPosition(true);  // also covers late transitions
    setChatPanelReady();
  }, [isTransitionTarget, setChatPanelReady]);

  // Fade in when handing off
  React.useEffect(() => {
    if (isTransitionTarget && transitionPhase === "handing-off") {
      // Small delay so the opacity:0 render is committed before transitioning
      const t = setTimeout(() => setTransitionVisible(true), 50);
      return () => clearTimeout(t);
    }
  }, [isTransitionTarget, transitionPhase]);

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

  // Auto-scroll to top when new messages arrive (newest messages are at top)
  const messagesContainerRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (isExpanded && messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = 0;
    }
  }, [messages, streamingContent, pendingToolCalls, isExpanded]);

  // Auto-expand when streaming
  React.useEffect(() => {
    if (isStreaming) {
      setIsExpanded(true);
    }
  }, [isStreaming]);

  // Auto-send initial prompt from transition store or localStorage (splash chat bar flow)
  //
  // IMPORTANT: No cleanup (return clearTimeout) here! The loadHistory() call
  // in useChat synchronously sets isLoading=true after the initial false render,
  // which triggers an effect re-run. If we returned cleanup, the timer would be
  // cleared before it fires. The ref guard prevents any double-execution.
  React.useEffect(() => {
    if (!dashboardId || isLoading || isStreaming || initialPromptConsumedRef.current) return;

    // Prefer transition store prompt over localStorage
    const prompt = (isTransitionTarget && transitionPrompt)
      ? transitionPrompt
      : localStorage.getItem("orcabot_initial_prompt");

    if (!prompt) {
      initialPromptConsumedRef.current = true;
      return;
    }
    localStorage.removeItem("orcabot_initial_prompt");
    initialPromptConsumedRef.current = true;
    setInputValue(prompt);
    setIsExpanded(true);
    // Brief delay to show the prompt in the input before sending
    setTimeout(() => {
      setInputValue("");
      sendMessage(prompt);
    }, 1000);
  }, [dashboardId, isLoading, isStreaming, sendMessage, isTransitionTarget, transitionPrompt]);

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

  const hasMessages = messages.length > 0 || isStreaming;

  // Container positioning:
  // Splash position: set BOTH top and bottom so the container stretches from
  // the splash bar position down to the viewport bottom. The card inside uses
  // flex layout to fill this space (input bar on top, messages fill the rest).
  // Normal position: just bottom: 16px as before.
  const containerStyle: React.CSSProperties = {};
  if (isAtSplashPosition && startBottom > 0) {
    containerStyle.top = `calc(100vh - ${startBottom + INPUT_BAR_HEIGHT}px)`;
    containerStyle.bottom = 16;
  } else {
    containerStyle.bottom = 16;
  }
  // Opacity transitions for handoff
  if (isTransitionTarget && !transitionVisible) {
    containerStyle.opacity = 0;
    containerStyle.transition = "opacity 700ms cubic-bezier(0.4, 0, 0.2, 1)";
    containerStyle.willChange = "opacity";
  } else if (isTransitionTarget && transitionVisible) {
    containerStyle.opacity = 1;
    containerStyle.transition = "opacity 700ms cubic-bezier(0.4, 0, 0.2, 1)";
    containerStyle.willChange = "opacity";
  }

  return (
    <div
      className={cn("fixed left-1/2 -translate-x-1/2 z-50 w-full max-w-xl px-4", isAtSplashPosition && "flex flex-col", className)}
      style={containerStyle}
    >
      {/* Outer card: theme background for messages area */}
      <div className={cn(
        "bg-background/95 backdrop-blur-lg ring-2 ring-white/[0.30] rounded-2xl shadow-lg overflow-hidden",
        isAtSplashPosition && "flex flex-col flex-1 min-h-0"
      )}>
        {/* Input Bar — matches splash page dark blue glass style, on top */}
        <div
          ref={inputBarRef}
          className="flex items-center gap-2 px-4 py-2.5 rounded-t-2xl"
          style={{
            background: "var(--chat-input-bg)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
            borderBottom: isExpanded ? "1px solid rgba(0, 229, 255, 0.15)" : undefined,
          }}
        >
          <input
            ref={inputRef}
            type="text"
            name="orcabot-prompt-nofill"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsExpanded(true)}
            placeholder="Ask Orcabot..."
            disabled={isStreaming}
            autoComplete="one-time-code"
            data-form-type="other"
            data-lpignore="true"
            data-1p-ignore
            className={cn(
              "flex-1 border-0 outline-none chat-input-splash focus-visible:outline-none",
              "text-sm",
              "disabled:opacity-50",
              "placeholder:text-[#5a7a9e]"
            )}
            style={{ color: "#e8edf5", caretColor: "#00e5ff", backgroundColor: "transparent", outline: "none" }}
          />

          {/* Trash button (when has messages) */}
          {hasMessages && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => clearHistory()}
              disabled={isLoading || isStreaming || messages.length === 0}
              className="h-7 w-7 p-0 rounded-full hover:bg-white/10"
              style={{ color: "#8ba3c4" }}
              title="Clear history"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}

          {/* Expand/Collapse chevron */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (isExpanded && isAtSplashPosition) setIsAtSplashPosition(false);
              setIsExpanded(!isExpanded);
            }}
            className="h-7 w-7 p-0 rounded-full hover:bg-white/10"
            style={{ color: "#8ba3c4" }}
          >
            {isExpanded ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronUp className="w-4 h-4" />
            )}
          </Button>

          {/* Send Button */}
          <Button
            onClick={handleSend}
            disabled={!inputValue.trim() || isStreaming}
            size="sm"
            className="h-7 w-7 p-0 rounded-full text-white"
            style={{ background: "#3b82f6", boxShadow: "0 2px 8px rgba(59, 130, 246, 0.3)" }}
          >
            {isStreaming ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Send className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>

        {/* Messages area (when expanded, below input) — newest at top */}
        {isExpanded && (
          <div
            ref={messagesContainerRef}
            className={cn(
              "overflow-y-auto p-4",
              isAtSplashPosition ? "flex-1 min-h-0" : "max-h-[50vh]"
            )}
          >
            {/* Loading spinner */}
            {isLoading && messages.length === 0 && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {/* Error message — show friendly text, log raw for debugging */}
            {error && (
              <div className="p-3 rounded-xl bg-destructive/10 text-destructive text-sm mb-2">
                Something went wrong — please try again.
              </div>
            )}

            {/* Streaming response — newest content, shown at top */}
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

            {/* Completed messages — reversed so newest is at top */}
            {messages.filter(m => m.role !== "tool").slice().reverse().map(renderMessage)}

            {/* Empty state placeholder — only when NOT at splash position */}
            {!hasMessages && !isLoading && !isAtSplashPosition && (
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
            )}
          </div>
        )}
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
