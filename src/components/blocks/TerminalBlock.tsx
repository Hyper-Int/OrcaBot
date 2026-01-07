"use client";

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import {
  Terminal,
  User,
  Bot,
  Pause,
  Play,
  Square,
  Lock,
  Plug,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { BlockWrapper } from "./BlockWrapper";
import { Button, Badge } from "@/components/ui";
import {
  GhosttyTerminal,
  type GhosttyTerminalHandle,
} from "@/components/terminal";
import { useTerminal } from "@/hooks/useTerminal";
import { useAuthStore } from "@/stores/auth-store";
import { createSession } from "@/lib/api/cloudflare";
import type { Session } from "@/types/dashboard";

interface TerminalData extends Record<string, unknown> {
  content: string; // Session ID or terminal name
  size: { width: number; height: number };
  dashboardId: string;
  // Session info (can be injected from parent or fetched)
  session?: Session;
}

type TerminalNode = Node<TerminalData, "terminal">;

export function TerminalBlock({ id, data, selected }: NodeProps<TerminalNode>) {
  const ghosttyRef = React.useRef<GhosttyTerminalHandle>(null);
  const [terminalName] = React.useState(data.content || "Terminal");
  const { user } = useAuthStore();
  const [isReady, setIsReady] = React.useState(false);

  // Session state
  const [session, setSession] = React.useState<Session | null>(
    data.session || null
  );
  const [isCreatingSession, setIsCreatingSession] = React.useState(false);
  const [sessionError, setSessionError] = React.useState<string | null>(null);

  // Use terminal hook for WebSocket connection
  const [terminalState, terminalActions] = useTerminal(
    {
      sessionId: session?.id || "",
      ptyId: session?.ptyId || "",
      userId: user?.id || "",
      userName: user?.name || "",
      enabled: !!session && session.status === "active",
    },
    {
      onData: React.useCallback((dataBytes: Uint8Array) => {
        // Write received data to the terminal
        const text = new TextDecoder().decode(dataBytes);
        ghosttyRef.current?.write(text);
      }, []),
    }
  );

  const { connectionState, turnTaking, agentState, error: wsError } = terminalState;

  // Computed state
  const isConnected = connectionState === "connected";
  const isConnecting = connectionState === "connecting" || connectionState === "reconnecting";
  const isFailed = connectionState === "failed";
  const isAgentRunning = agentState === "running";
  const canType = turnTaking.isController && !isAgentRunning && isConnected;

  // Border color based on state
  const getBorderColor = () => {
    if (!session || !isConnected) {
      return "var(--border)";
    }
    if (isAgentRunning) {
      return "var(--status-control-agent)"; // Amber
    }
    if (turnTaking.isController) {
      return "var(--status-control-active)"; // Green
    }
    return "var(--border)"; // Gray for observing
  };

  // Handle terminal data (user input)
  const handleTerminalData = React.useCallback(
    (inputData: string) => {
      if (!canType) {
        console.log("Input blocked");
        return;
      }

      // Send through WebSocket
      terminalActions.sendInput(inputData);
    },
    [canType, terminalActions]
  );

  // Handle terminal resize
  const handleTerminalResize = React.useCallback(
    (cols: number, rows: number) => {
      terminalActions.sendResize(cols, rows);
    },
    [terminalActions]
  );

  // Handle terminal ready - auto-connect when terminal is ready
  const handleTerminalReady = React.useCallback(() => {
    setIsReady(true);
  }, []);

  // Auto-connect when terminal is ready and no session exists
  const hasAutoConnectedRef = React.useRef(false);
  React.useEffect(() => {
    if (isReady && !session && !isCreatingSession && !hasAutoConnectedRef.current && data.dashboardId) {
      hasAutoConnectedRef.current = true;
      // Show connecting message
      ghosttyRef.current?.write("\x1b[90mConnecting...\x1b[0m\r\n");
      // Trigger connect
      handleConnect();
    }
  }, [isReady, session, isCreatingSession, data.dashboardId]);

  // Create session handler
  const handleConnect = async () => {
    console.log(`[TerminalBlock] handleConnect called - dashboardId: ${data.dashboardId}, itemId: ${id}`);

    if (!data.dashboardId) {
      setSessionError("Dashboard ID not found");
      return;
    }

    setIsCreatingSession(true);
    setSessionError(null);

    try {
      console.log(`[TerminalBlock] Creating session...`);
      const newSession = await createSession(data.dashboardId, id);
      console.log(`[TerminalBlock] Session created:`, newSession);
      setSession(newSession);

      // Clear terminal and show connecting message
      if (isReady) {
        ghosttyRef.current?.write("\x1b[2J\x1b[H"); // Clear screen
        ghosttyRef.current?.write(
          "\x1b[32mConnecting to sandbox...\x1b[0m\r\n"
        );
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Failed to create session";
      setSessionError(errorMsg);
      if (isReady) {
        ghosttyRef.current?.write(`\x1b[31mError: ${errorMsg}\x1b[0m\r\n`);
      }
    } finally {
      setIsCreatingSession(false);
    }
  };

  // Show connected message when WebSocket connects
  React.useEffect(() => {
    if (isConnected && session && isReady) {
      ghosttyRef.current?.write("\x1b[2J\x1b[H"); // Clear screen
      ghosttyRef.current?.write("\x1b[32m$ Connected to sandbox\x1b[0m\r\n");
      ghosttyRef.current?.write(
        `\x1b[90mSession: ${session.sandboxSessionId}\x1b[0m\r\n`
      );
      ghosttyRef.current?.write("\r\n");

      // NOTE: Do NOT auto-take control here.
      // Turn-taking requires explicit user action - control must be requested/granted.
      // The server will broadcast who has control via the control_state message.
    }
  }, [isConnected, session, isReady]);

  // Show error when WebSocket fails
  React.useEffect(() => {
    if (isFailed && isReady) {
      ghosttyRef.current?.write(
        `\x1b[31mConnection failed: ${wsError?.message || "Unable to connect to sandbox"}\x1b[0m\r\n`
      );
    }
  }, [isFailed, wsError, isReady]);

  // Control handlers
  const handleRequestControl = () => {
    terminalActions.requestControl();
  };

  const handlePauseAgent = () => {
    console.log("Pausing agent...");
  };

  const handleResumeAgent = () => {
    console.log("Resuming agent...");
  };

  const handleStopAgent = () => {
    console.log("Stopping agent...");
  };

  return (
    <BlockWrapper
      selected={selected}
      className="p-0 overflow-hidden flex flex-col"
      minWidth={300}
      minHeight={200}
      style={{
        borderColor: getBorderColor(),
        borderWidth: "2px",
      }}
    >
      {/* Header - compact */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--border)] bg-[var(--background)] shrink-0">
        <div className="flex items-center gap-1.5">
          <Terminal className="w-3 h-3 text-[var(--foreground-muted)]" />
          <span className="text-[10px] font-medium text-[var(--foreground)]">
            {terminalName}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {/* Connection status */}
          {session && (
            <Badge
              variant={isConnected ? "success" : isFailed ? "error" : "secondary"}
              size="sm"
            >
              <div
                className={cn(
                  "w-1.5 h-1.5 rounded-full mr-1",
                  isConnected
                    ? "bg-[var(--status-success)] animate-pulse"
                    : isFailed
                      ? "bg-[var(--status-error)]"
                      : "bg-[var(--foreground-subtle)]"
                )}
              />
              {isConnecting
                ? "..."
                : isConnected
                  ? "Live"
                  : isFailed
                    ? "Err"
                    : "Off"}
            </Badge>
          )}

          {/* Controller badge */}
          {isConnected && (
            <Badge variant={turnTaking.isController ? "success" : "secondary"} size="sm">
              <User className="w-2 h-2 mr-0.5" />
              {turnTaking.isController ? "You" : (turnTaking.controllerName || "—")}
            </Badge>
          )}

          {/* Agent status badge */}
          {agentState !== "idle" && agentState !== null && (
            <Badge
              variant={
                isAgentRunning
                  ? "warning"
                  : agentState === "paused"
                    ? "secondary"
                    : "error"
              }
              size="sm"
            >
              <Bot className="w-2 h-2 mr-0.5" />
              {agentState === "running" ? "Agent" : agentState}
            </Badge>
          )}
        </div>
      </div>

      {/* Terminal body - Ghostty-web */}
      <div className="relative flex-1 min-h-0" style={{ contain: "strict", overflow: "hidden" }}>
        <GhosttyTerminal
          ref={ghosttyRef}
          onData={handleTerminalData}
          onResize={handleTerminalResize}
          onReady={handleTerminalReady}
          disabled={!canType}
          fontSize={9}
          className="w-full h-full"
        />

        {/* Error overlay - only show if session creation failed */}
        {!session && sessionError && (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
            <div className="bg-[var(--background-elevated)] px-6 py-4 rounded-lg border border-[var(--border)] flex flex-col items-center gap-3">
              <AlertCircle className="w-8 h-8 text-[var(--status-error)]" />
              <span className="text-sm text-[var(--foreground)]">
                Connection failed
              </span>
              <div className="flex items-center gap-2 text-xs text-[var(--status-error)]">
                {sessionError}
              </div>
              <Button
                variant="primary"
                size="sm"
                onClick={handleConnect}
                isLoading={isCreatingSession}
                leftIcon={<Plug className="w-4 h-4" />}
              >
                Retry
              </Button>
            </div>
          </div>
        )}

        {/* Connecting overlay */}
        {session && isConnecting && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
            <div className="bg-[var(--background-elevated)] px-4 py-2 rounded-lg border border-[var(--border)] flex items-center gap-2">
              <Loader2 className="w-4 h-4 text-[var(--foreground-muted)] animate-spin" />
              <span className="text-sm text-[var(--foreground-muted)]">
                Connecting to sandbox...
              </span>
            </div>
          </div>
        )}

        {/* Input blocked overlay (when connected but can't type) */}
        {session && isConnected && !canType && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
            <div className="bg-[var(--background-elevated)] px-4 py-2 rounded-lg border border-[var(--border)] flex items-center gap-2">
              <Lock className="w-4 h-4 text-[var(--foreground-muted)]" />
              <span className="text-sm text-[var(--foreground-muted)]">
                {isAgentRunning
                  ? "Agent is running"
                  : "Click below to request control"}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Footer controls - compact */}
      <div className="flex items-center justify-between px-2 py-1 border-t border-[var(--border)] bg-[var(--background)] shrink-0">
        {/* Control actions */}
        <div>
          {!session && (
            <div className="text-[10px] text-[var(--foreground-subtle)]">
              Connecting...
            </div>
          )}

          {session && !isConnected && !isConnecting && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => terminalActions.reconnect()}
              className="text-[10px] h-5 px-2"
            >
              Reconnect
            </Button>
          )}

          {session && isConnected && !turnTaking.isController && !isAgentRunning && (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleRequestControl}
              disabled={turnTaking.hasPendingRequest}
              className="text-[10px] h-5 px-2"
            >
              {turnTaking.hasPendingRequest ? "Pending..." : "Take Control"}
            </Button>
          )}

          {session && isConnected && turnTaking.isController && (
            <div className="flex items-center gap-1 text-[10px] text-[var(--foreground-subtle)]">
              <div className="w-1.5 h-1.5 rounded-full bg-[var(--status-success)] animate-pulse" />
              Control active
            </div>
          )}
        </div>

        {/* Agent controls */}
        {agentState !== "idle" && agentState !== null && (
          <div className="flex items-center gap-1">
            {isAgentRunning && (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={handlePauseAgent}
                  title="Pause agent"
                  className="h-5 w-5"
                >
                  <Pause className="w-3 h-3" />
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={handleStopAgent}
                  className="text-[10px] h-5 px-2"
                >
                  Stop
                </Button>
              </>
            )}
            {agentState === "paused" && (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleResumeAgent}
                  title="Resume agent"
                  className="h-5 w-5"
                >
                  <Play className="w-3 h-3" />
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={handleStopAgent}
                  className="text-[10px] h-5 px-2"
                >
                  Stop
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </BlockWrapper>
  );
}

export default TerminalBlock;
