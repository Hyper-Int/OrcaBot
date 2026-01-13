"use client";

import * as React from "react";
import { createPortal } from "react-dom";
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
  PanelLeft,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { BlockWrapper } from "./BlockWrapper";
import { Button, Badge } from "@/components/ui";
import {
  Terminal as TerminalEmulator,
  type TerminalHandle,
} from "@/components/terminal";
import { useTerminal } from "@/hooks/useTerminal";
import { useAuthStore } from "@/stores/auth-store";
import { createSession } from "@/lib/api/cloudflare";
import { createSubagent, deleteSubagent, listSubagents, listSessionFiles, deleteSessionFile, type UserSubagent, type SessionFileEntry } from "@/lib/api/cloudflare";
import { API } from "@/config/env";
import type { Session } from "@/types/dashboard";
import { useTerminalOverlay } from "@/components/terminal";
import subagentCatalog from "@/data/claude-subagents.json";

interface TerminalData extends Record<string, unknown> {
  content: string; // Session ID or terminal name
  size: { width: number; height: number };
  dashboardId: string;
  // Session info (can be injected from parent or fetched)
  session?: Session;
  onRegisterTerminal?: (itemId: string, handle: TerminalHandle | null) => void;
  onItemChange?: (changes: Partial<{ content: string }>) => void;
  onCreateBrowserBlock?: (
    url: string,
    anchor?: { x: number; y: number },
    sourceId?: string
  ) => void;
}

type TerminalNode = Node<TerminalData, "terminal">;

type SubagentCatalogItem = {
  id: string;
  name: string;
  description: string;
  tools?: string[];
  prompt: string;
  sourcePath?: string;
};

type SubagentCatalogCategory = {
  id: string;
  title: string;
  items: SubagentCatalogItem[];
};

type TerminalContentState = {
  name: string;
  subagentIds: string[];
};

function parseTerminalContent(content: string | null | undefined): TerminalContentState {
  if (content) {
    try {
      const parsed = JSON.parse(content) as Partial<TerminalContentState & { subagents?: string[] }>;
      const name = typeof parsed.name === "string" ? parsed.name : content;
      const subagentIds = Array.isArray(parsed.subagentIds)
        ? parsed.subagentIds
        : Array.isArray(parsed.subagents)
          ? parsed.subagents
          : [];
      return { name, subagentIds };
    } catch {
      return { name: content, subagentIds: [] };
    }
  }
  return { name: "Terminal", subagentIds: [] };
}

export function TerminalBlock({
  id,
  data,
  selected,
  dragging,
  positionAbsoluteX,
  positionAbsoluteY,
  width,
  height,
}: NodeProps<TerminalNode>) {
  const baseFontSize = 12;
  const minFontSize = 8;
  const maxFontSize = 16;
  const minCols = 90;
  const growColsBuffer = 0;
  const shrinkColsBuffer = 0;
  const fontCooldownMs = 600;
  const overlay = useTerminalOverlay();
  const terminalRef = React.useRef<TerminalHandle>(null);
  const fitTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFontChangeRef = React.useRef(0);
  const [fontSize, setFontSize] = React.useState(baseFontSize);
  const stableFontRef = React.useRef(baseFontSize);
  const terminalMeta = React.useMemo(
    () => parseTerminalContent(data.content),
    [data.content]
  );
  const terminalName = terminalMeta.name;
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [isReady, setIsReady] = React.useState(false);
  const [isClaudeSession, setIsClaudeSession] = React.useState(false);
  const [showSubagents, setShowSubagents] = React.useState(false);
  const [activeSubagentTab, setActiveSubagentTab] = React.useState<"saved" | "browse">("saved");
  const [expandedCategories, setExpandedCategories] = React.useState<Record<string, boolean>>({});
  const [showAttachedList, setShowAttachedList] = React.useState(false);
  const [showWorkspace, setShowWorkspace] = React.useState(true);
  const [expandedPaths, setExpandedPaths] = React.useState<Set<string>>(new Set(["/"]));
  const [fileEntries, setFileEntries] = React.useState<Record<string, SessionFileEntry[]>>({});
  const [fileLoading, setFileLoading] = React.useState<Record<string, boolean>>({});
  const [fileError, setFileError] = React.useState<string | null>(null);
  const onRegisterTerminal = data.onRegisterTerminal;
  const setTerminalRef = React.useCallback(
    (handle: TerminalHandle | null) => {
      terminalRef.current = handle;
      onRegisterTerminal?.(id, handle);
    },
    [id, onRegisterTerminal]
  );

  // Session state
  const [session, setSession] = React.useState<Session | null>(
    data.session || null
  );

  const createdBrowserUrlsRef = React.useRef<Set<string>>(new Set());
  const outputBufferRef = React.useRef("");
  const browserScanTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileRefreshTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const catalog = subagentCatalog as { categories: SubagentCatalogCategory[] };

  React.useEffect(() => {
    createdBrowserUrlsRef.current.clear();
    outputBufferRef.current = "";
    if (browserScanTimeoutRef.current) {
      clearTimeout(browserScanTimeoutRef.current);
      browserScanTimeoutRef.current = null;
    }
    if (fileRefreshTimeoutRef.current) {
      clearTimeout(fileRefreshTimeoutRef.current);
      fileRefreshTimeoutRef.current = null;
    }
    setIsClaudeSession(false);
    setShowSubagents(false);
    setShowWorkspace(true);
    setExpandedPaths(new Set(["/"]));
    setFileEntries({});
    setFileLoading({});
    setFileError(null);
  }, [session?.id]);
  const [isCreatingSession, setIsCreatingSession] = React.useState(false);
  const [sessionError, setSessionError] = React.useState<string | null>(null);

  const subagentsQuery = useQuery({
    queryKey: ["subagents"],
    queryFn: () => listSubagents(),
    enabled: showSubagents,
    staleTime: 60000,
  });

  const createSubagentMutation = useMutation({
    mutationFn: createSubagent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subagents"] });
    },
  });

  const deleteSubagentMutation = useMutation({
    mutationFn: deleteSubagent,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subagents"] });
    },
  });

  const savedSubagents = subagentsQuery.data || [];
  const savedNames = React.useMemo(
    () => new Set(savedSubagents.map((item) => item.name)),
    [savedSubagents]
  );
  const savedByName = React.useMemo(() => {
    const map = new Map<string, UserSubagent>();
    savedSubagents.forEach((item) => map.set(item.name, item));
    return map;
  }, [savedSubagents]);
  const savedById = React.useMemo(() => {
    const map = new Map<string, UserSubagent>();
    savedSubagents.forEach((item) => map.set(item.id, item));
    return map;
  }, [savedSubagents]);

  const openIntegration = React.useCallback(
    (provider: "google-drive" | "github") => {
      if (!user) return;
      const path = provider === "google-drive"
        ? "/integrations/google/drive/connect"
        : "/integrations/github/connect";
      const url = new URL(`${API.cloudflare.baseUrl}${path}`);
      url.searchParams.set("user_id", user.id);
      url.searchParams.set("user_email", user.email);
      url.searchParams.set("user_name", user.name);
      window.open(url.toString(), "_blank", "noopener,noreferrer");
    },
    [user]
  );

  const handleSaveSubagent = React.useCallback(
    (item: SubagentCatalogItem) => {
      if (savedNames.has(item.name)) return;
      createSubagentMutation.mutate({
        name: item.name,
        description: item.description,
        prompt: item.prompt,
        tools: item.tools || [],
        source: "catalog",
      });
    },
    [createSubagentMutation, savedNames]
  );

  const handleAttachSubagent = React.useCallback(
    (subagentId: string) => {
      if (!data.onItemChange) return;
      if (terminalMeta.subagentIds.includes(subagentId)) return;
      const nextIds = [...terminalMeta.subagentIds, subagentId];
      data.onItemChange({
        content: JSON.stringify({ name: terminalMeta.name, subagentIds: nextIds }),
      });
    },
    [data, terminalMeta]
  );

  const handleDetachSubagent = React.useCallback(
    (subagentId: string) => {
      if (!data.onItemChange) return;
      const nextIds = terminalMeta.subagentIds.filter((id) => id !== subagentId);
      data.onItemChange({
        content: JSON.stringify({ name: terminalMeta.name, subagentIds: nextIds }),
      });
    },
    [data, terminalMeta]
  );

  const handleUseSavedSubagent = React.useCallback(
    (item: UserSubagent) => {
      handleAttachSubagent(item.id);
    },
    [handleAttachSubagent]
  );

  const handleUseBrowseSubagent = React.useCallback(
    async (item: SubagentCatalogItem) => {
      const existing = savedByName.get(item.name);
      if (existing) {
        handleAttachSubagent(existing.id);
        return;
      }
      const created = await createSubagentMutation.mutateAsync({
        name: item.name,
        description: item.description,
        prompt: item.prompt,
        tools: item.tools || [],
        source: "catalog",
      });
      handleAttachSubagent(created.id);
    },
    [createSubagentMutation, handleAttachSubagent, savedByName]
  );

  const attachedNames = React.useMemo(() => {
    return terminalMeta.subagentIds.map((id) => savedById.get(id)?.name || "Unknown");
  }, [terminalMeta.subagentIds, savedById]);

  const toggleCategory = React.useCallback((categoryId: string) => {
    setExpandedCategories((prev) => ({
      ...prev,
      [categoryId]: !prev[categoryId],
    }));
  }, []);

  const loadFiles = React.useCallback(
    async (path: string) => {
      if (!session?.id) return;
      setFileLoading((prev) => ({ ...prev, [path]: true }));
      try {
        const entries = await listSessionFiles(session.id, path);
        entries.sort((a, b) => {
          if (a.is_dir && !b.is_dir) return -1;
          if (!a.is_dir && b.is_dir) return 1;
          return a.name.localeCompare(b.name);
        });
        setFileEntries((prev) => ({ ...prev, [path]: entries }));
        setFileError(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to load files";
        setFileError(message);
      } finally {
        setFileLoading((prev) => ({ ...prev, [path]: false }));
      }
    },
    [session?.id]
  );

  React.useEffect(() => {
    if (session?.id) {
      loadFiles("/");
    }
  }, [session?.id, loadFiles]);

  const togglePath = React.useCallback(
    (path: string) => {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          if (!fileEntries[path]) {
            loadFiles(path);
          }
        }
        return next;
      });
    },
    [fileEntries, loadFiles]
  );

  const handleDeletePath = React.useCallback(
    async (path: string, parentPath: string) => {
      if (!session?.id) return;
      try {
        await deleteSessionFile(session.id, path);
        loadFiles(parentPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to delete";
        setFileError(message);
      }
    },
    [loadFiles, session?.id]
  );

  const renderFileTree = React.useCallback(
    (path: string, depth = 0) => {
      const entries = fileEntries[path] || [];
      return entries.map((entry) => {
        const isExpanded = expandedPaths.has(entry.path);
        const isDir = entry.is_dir;
        return (
          <div key={entry.path}>
            <div
              className="flex items-center justify-between gap-2 px-2 py-1 text-[11px] hover:bg-[var(--background-elevated)] rounded"
              style={{ paddingLeft: `${depth * 10 + 8}px` }}
            >
              <div className="flex items-center gap-1 min-w-0">
                {isDir ? (
                  <button
                    type="button"
                    onClick={() => togglePath(entry.path)}
                    className="text-[10px] text-[var(--foreground-muted)] nodrag"
                    aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
                  >
                    {isExpanded ? "▾" : "▸"}
                  </button>
                ) : (
                  <span className="text-[10px] text-[var(--foreground-subtle)]">—</span>
                )}
                <span className="truncate text-[var(--foreground)]">{entry.name}</span>
              </div>
              {!isDir && (
                <button
                  type="button"
                  onClick={() => handleDeletePath(entry.path, path)}
                  className="text-[10px] text-[var(--status-error)] hover:text-[var(--status-error)] nodrag"
                >
                  Delete
                </button>
              )}
            </div>
            {isDir && isExpanded && (
              <div>
                {renderFileTree(entry.path, depth + 1)}
              </div>
            )}
          </div>
        );
      });
    },
    [expandedPaths, fileEntries, fileLoading, handleDeletePath, togglePath]
  );

  const refreshVisiblePaths = React.useCallback(() => {
    const paths = Array.from(expandedPaths);
    paths.forEach((path) => loadFiles(path));
  }, [expandedPaths, loadFiles]);

  const maybeCreateBrowserBlock = React.useCallback(
    (lines: string[]) => {
      const urlRegex = /(https?:\/\/[^\s"'<>]+)/g;
      for (const line of lines) {
        const strippedLine = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
        const matches = strippedLine.match(urlRegex);
        if (!matches || matches.length === 0) {
          continue;
        }

        for (const rawUrl of matches) {
          const cleanedUrl = rawUrl.replace(/[)\],.;]+$/, "");
          if (createdBrowserUrlsRef.current.has(cleanedUrl)) {
            continue;
          }
          createdBrowserUrlsRef.current.add(cleanedUrl);
          data.onCreateBrowserBlock?.(cleanedUrl, {
            x: positionAbsoluteX + (width ?? data.size.width) + 24,
            y: positionAbsoluteY + 24,
          }, id);
          return;
        }
      }
    },
    [data, positionAbsoluteX, positionAbsoluteY, width]
  );

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
        terminalRef.current?.write(text);
        outputBufferRef.current = (outputBufferRef.current + text).slice(-2000);
        if (!isClaudeSession && /Claude Code v/i.test(outputBufferRef.current)) {
          setIsClaudeSession(true);
        }

        if (browserScanTimeoutRef.current) {
          clearTimeout(browserScanTimeoutRef.current);
        }

        browserScanTimeoutRef.current = setTimeout(() => {
          const buffer = outputBufferRef.current;
          const parts = buffer.split("\n");
          const pending = parts.pop() ?? "";
          if (parts.length > 0) {
            maybeCreateBrowserBlock(parts);
          }
          outputBufferRef.current = pending;
        }, 250);

        if (fileRefreshTimeoutRef.current) {
          clearTimeout(fileRefreshTimeoutRef.current);
        }
        fileRefreshTimeoutRef.current = setTimeout(() => {
          refreshVisiblePaths();
        }, 600);
      }, [isClaudeSession, maybeCreateBrowserBlock, refreshVisiblePaths]),
    }
  );

  const { connectionState, turnTaking, agentState, error: wsError } = terminalState;

  // Computed state
  const isConnected = connectionState === "connected";
  const isConnecting = connectionState === "connecting" || connectionState === "reconnecting";
  const isFailed = connectionState === "failed";
  const isAgentRunning = agentState === "running";
  const canType = turnTaking.isController && !isAgentRunning && isConnected;
  const canInsertPrompt = canType;

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

  // Calculate position and size for the overlay portal
  const zoom = overlay?.viewport.zoom ?? 1;
  const blockWidth = (width ?? data.size.width) * zoom;
  const blockHeight = (height ?? data.size.height) * zoom;
  const blockX = positionAbsoluteX * zoom + (overlay?.viewport.x ?? 0);
  const blockY = positionAbsoluteY * zoom + (overlay?.viewport.y ?? 0);

  // Selected or dragging terminal gets high z-index, others use tracked order
  const baseZIndex = overlay?.getZIndex(id) ?? 0;
  const zIndex = selected || dragging ? 9999 : baseZIndex;

  // Track z-order so last-selected/dragged stays on top
  const prevSelectedRef = React.useRef(false);
  const prevDraggingRef = React.useRef(false);
  React.useEffect(() => {
    // Bring to front when selection or dragging transitions from false to true
    const shouldBringToFront =
      (selected && !prevSelectedRef.current) ||
      (dragging && !prevDraggingRef.current);

    if (shouldBringToFront) {
      overlay?.bringToFront(id);
    }
    prevSelectedRef.current = selected;
    prevDraggingRef.current = dragging;
  }, [selected, dragging, id, overlay?.bringToFront]);

  const isTempId = id.startsWith("temp-");

  // Auto-connect when terminal is ready and no session exists
  const hasAutoConnectedRef = React.useRef(false);
  React.useEffect(() => {
    if (
      isReady &&
      !isTempId &&
      !session &&
      !isCreatingSession &&
      !hasAutoConnectedRef.current &&
      data.dashboardId
    ) {
      hasAutoConnectedRef.current = true;
      // Show connecting message
      terminalRef.current?.write("\x1b[90mConnecting...\x1b[0m\r\n");
      // Trigger connect
      handleConnect();
    }
  }, [isReady, isTempId, session, isCreatingSession, data.dashboardId]);

  // Create session handler
  const handleConnect = async () => {
    console.log(`[TerminalBlock] handleConnect called - dashboardId: ${data.dashboardId}, itemId: ${id}`);

    if (isTempId) {
      console.log("[TerminalBlock] Skipping connect for temporary item id.");
      return;
    }

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
        terminalRef.current?.write("\x1b[2J\x1b[H"); // Clear screen
        terminalRef.current?.write(
          "\x1b[32mConnecting to sandbox...\x1b[0m\r\n"
        );
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Failed to create session";
      setSessionError(errorMsg);
      if (isReady) {
        terminalRef.current?.write(`\x1b[31mError: ${errorMsg}\x1b[0m\r\n`);
      }
    } finally {
      setIsCreatingSession(false);
    }
  };

  // Show connected message when WebSocket connects
  React.useEffect(() => {
    if (isConnected && session && isReady) {
      if (fitTimeoutRef.current) {
        clearTimeout(fitTimeoutRef.current);
      }
      fitTimeoutRef.current = setTimeout(() => {
        terminalRef.current?.fit();
      }, 120);

      terminalRef.current?.write("\x1b[2J\x1b[H"); // Clear screen
      terminalRef.current?.write("\x1b[32m$ Connected to sandbox\x1b[0m\r\n");
      terminalRef.current?.write(
        `\x1b[90mSession: ${session.sandboxSessionId}\x1b[0m\r\n`
      );
      terminalRef.current?.write("\r\n");

      // NOTE: Do NOT auto-take control here.
      // Turn-taking requires explicit user action - control must be requested/granted.
      // The server will broadcast who has control via the control_state message.
    }
  }, [isConnected, session, isReady]);

  React.useEffect(() => {
    if (!session || !terminalRef.current) {
      return;
    }
    if (fitTimeoutRef.current) {
      clearTimeout(fitTimeoutRef.current);
    }
    fitTimeoutRef.current = setTimeout(() => {
      terminalRef.current?.fit();
      const dims = terminalRef.current?.getDimensions();
      if (!dims) {
        return;
      }

      const now = Date.now();
      if (now - lastFontChangeRef.current < fontCooldownMs) {
        return;
      }

      const targetCols = minCols + (dims.cols < minCols ? shrinkColsBuffer : growColsBuffer);
      const rawTarget = Math.floor((stableFontRef.current * dims.cols) / targetCols);
      const target = Math.max(minFontSize, Math.min(maxFontSize, rawTarget));

      if (target !== stableFontRef.current) {
        stableFontRef.current = target;
        lastFontChangeRef.current = now;
        setFontSize(target);
      }
    }, 140);
  }, [data.size.width, data.size.height, session, blockWidth]);

  React.useEffect(() => {
    return () => {
      if (fitTimeoutRef.current) {
        clearTimeout(fitTimeoutRef.current);
      }
    };
  }, []);

  React.useEffect(() => {
    return () => {
      onRegisterTerminal?.(id, null);
    };
  }, [id, onRegisterTerminal]);

  // Show error when WebSocket fails
  React.useEffect(() => {
    if (isFailed && isReady) {
      terminalRef.current?.write(
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

  // The visible terminal content - rendered in portal when overlay is available
  //
  // POINTER EVENTS PATTERN:
  // The portal wrapper has pointer-events: none so drag events pass through to
  // the invisible ReactFlow node underneath (which handles drag/resize).
  //
  // Interactive elements must explicitly set pointer-events: auto:
  // - Terminal body (for xterm.js input)
  // - Buttons (Reconnect, Take Control, agent controls, etc.)
  //
  // If you add new clickable elements to header/footer, add: style={{ pointerEvents: "auto" }}
  //
  const terminalContent = (
    <div
      className={cn(
        "relative flex flex-col rounded-[var(--radius-card)]",
        "bg-[var(--background-elevated)] border border-[var(--border)]",
        "shadow-sm",
        selected && "ring-2 ring-[var(--accent-primary)] shadow-lg"
      )}
      style={{
        width: "100%",
        height: "100%",
        borderColor: getBorderColor(),
        borderWidth: "2px",
        overflow: "visible",
      }}
    >
      {isClaudeSession && (showAttachedList || showSubagents) && (
        <div
          className="absolute left-0 right-0 bottom-full mb-2 flex flex-col gap-2"
          style={{ pointerEvents: "auto" }}
        >
          {showAttachedList && (
            <div className="rounded border border-[var(--border)] bg-[var(--background-elevated)] shadow-md">
              <div className="px-2 py-2 text-xs space-y-1">
                {attachedNames.length === 0 && (
                  <div className="text-[var(--foreground-muted)]">No subagents attached.</div>
                )}
                {terminalMeta.subagentIds.map((id) => (
                  <div
                    key={id}
                    className="flex items-center justify-between rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1"
                  >
                    <span className="text-[var(--foreground)]">
                      {savedById.get(id)?.name || "Unknown"}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDetachSubagent(id)}
                      className="text-[10px] h-5 px-2 nodrag"
                    >
                      Detach
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {showSubagents && (
            <div className="rounded border border-[var(--border)] bg-[var(--background-elevated)] shadow-md">
              <div className="flex items-center gap-1 px-2 py-1 border-b border-[var(--border)]">
                <Button
                  variant={activeSubagentTab === "saved" ? "primary" : "ghost"}
                  size="sm"
                  onClick={() => setActiveSubagentTab("saved")}
                  className="text-[10px] h-5 px-2 nodrag"
                >
                  Saved
                </Button>
                <Button
                  variant={activeSubagentTab === "browse" ? "primary" : "ghost"}
                  size="sm"
                  onClick={() => setActiveSubagentTab("browse")}
                  className="text-[10px] h-5 px-2 nodrag"
                >
                  Browse
                </Button>
              </div>
              <div className="max-h-56 overflow-auto px-2 pb-2 text-xs">
                {activeSubagentTab === "saved" ? (
                  <div className="space-y-2">
                    {!subagentsQuery.isLoading && savedSubagents.length === 0 && (
                      <div className="text-[var(--foreground-muted)]">
                        No saved subagents yet.
                      </div>
                    )}
                    {savedSubagents.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-start justify-between gap-2 rounded border border-[var(--border)] bg-[var(--background)] p-2"
                      >
                        <div>
                          <div className="font-medium text-[var(--foreground)]">
                            {item.name}
                          </div>
                          {item.description && (
                            <div className="text-[10px] text-[var(--foreground-muted)]">
                              {item.description}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleUseSavedSubagent(item)}
                            className="text-[10px] h-5 px-2 nodrag"
                          >
                            Attach
                          </Button>
                          {terminalMeta.subagentIds.includes(item.id) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDetachSubagent(item.id)}
                              className="text-[10px] h-5 px-2 nodrag"
                            >
                              Detach
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {catalog.categories.map((category) => (
                      <div key={category.id} className="rounded border border-[var(--border)]">
                        <button
                          type="button"
                          onClick={() => toggleCategory(category.id)}
                          className="w-full flex items-center justify-between px-2 py-1 text-[11px] font-semibold text-[var(--foreground)] bg-[var(--background)] nodrag"
                        >
                          <span>{category.title}</span>
                          <span className="text-[10px] text-[var(--foreground-muted)]">
                            {expandedCategories[category.id] ? "Hide" : "Show"}
                          </span>
                        </button>
                        {expandedCategories[category.id] && (
                          <div className="p-2 space-y-2">
                            {category.items.map((item) => (
                              <div
                                key={item.id}
                                className="flex items-start justify-between gap-2 rounded border border-[var(--border)] bg-[var(--background-elevated)] p-2"
                              >
                                <div>
                                  <div className="font-medium text-[var(--foreground)]">
                                    {item.name}
                                  </div>
                                  <div className="text-[10px] text-[var(--foreground-muted)]">
                                    {item.description}
                                  </div>
                                </div>
                                <div className="flex items-center gap-1">
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => handleUseBrowseSubagent(item)}
                                    className="text-[10px] h-5 px-2 nodrag"
                                  >
                                    Attach
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleSaveSubagent(item)}
                                    disabled={savedNames.has(item.name)}
                                    className="text-[10px] h-5 px-2 nodrag"
                                  >
                                    {savedNames.has(item.name) ? "Saved" : "Save"}
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {isClaudeSession && (
        <div
          className="flex items-center justify-between px-2 py-1 border-b border-[var(--border)] bg-[var(--background)] text-xs"
          style={{ pointerEvents: "none" }}
        >
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--foreground-muted)]">
            <span>Claude Code</span>
            <button
              type="button"
              onClick={() => setShowAttachedList((prev) => !prev)}
              className="flex items-center gap-1 text-[10px] font-medium text-[var(--foreground)] nodrag"
              style={{ pointerEvents: "auto" }}
            >
              <span className="truncate max-w-[180px]">
                {attachedNames.length > 0 ? attachedNames.join(" · ") : "No subagents"}
              </span>
              <span className="text-[10px] text-[var(--foreground-muted)]">
                ({attachedNames.length})
              </span>
            </button>
          </div>
          <Button
            variant={showSubagents ? "primary" : "ghost"}
            size="sm"
            onClick={() => setShowSubagents((prev) => !prev)}
            className="text-[10px] h-5 px-2"
            style={{ pointerEvents: "auto" }}
          >
            Subagents
          </Button>
        </div>
      )}

      {/* Header - compact, pointer-events: none to allow drag through to ReactFlow node */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--border)] bg-[var(--background)] shrink-0" style={{ pointerEvents: "none" }}>
        <div className="flex items-center gap-1.5">
          <Terminal className="w-3 h-3 text-[var(--foreground-muted)]" />
          <span className="text-[16px] font-medium text-[var(--foreground)]">
            {terminalName}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowWorkspace((prev) => !prev)}
            className="text-[10px] h-5 px-2"
            style={{ pointerEvents: "auto" }}
            title={showWorkspace ? "Hide workspace" : "Show workspace"}
          >
            <PanelLeft className="w-3 h-3" />
          </Button>
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

      {/* Terminal body - pointerEvents: auto for xterm.js interaction */}
      <div className="relative flex-1 min-h-0 nodrag bg-[#0a0a0b]" style={{ overflow: "visible", pointerEvents: "auto" }}>
        {showWorkspace ? (
          <div className="absolute inset-y-0 right-full mr-2 w-56 border border-[var(--border)] bg-white dark:bg-[var(--background-elevated)] text-xs overflow-hidden nodrag shadow-md flex flex-col">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--foreground-muted)] border-b border-[var(--border)] flex items-center justify-between">
              <span>Workspace</span>
              <button
                type="button"
                onClick={() => setShowWorkspace(false)}
                className="text-[10px] text-[var(--foreground-muted)]"
                title="Collapse workspace"
              >
                ▸
              </button>
            </div>
            <div className="flex-1 overflow-auto bg-white dark:bg-[var(--background)]">
              {fileError && (
                <div className="px-2 py-1 text-[10px] text-[var(--status-error)]">
                  {fileError}
                </div>
              )}
              {renderFileTree("/", 0)}
            </div>
            <div className="border-t border-[var(--border)] bg-white dark:bg-[var(--background-elevated)] px-2 py-2 flex flex-col gap-1">
              <button
                type="button"
                onClick={() => openIntegration("google-drive")}
                disabled={!user}
                className="w-full text-[10px] font-semibold uppercase tracking-wide text-[var(--foreground)] border border-[var(--border)] rounded px-2 py-1 bg-[var(--background)] hover:bg-[var(--background-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                title={user ? "Connect Google Drive" : "Sign in to connect Google Drive"}
              >
                Add Google Drive
              </button>
              <button
                type="button"
                onClick={() => openIntegration("github")}
                disabled={!user}
                className="w-full text-[10px] font-semibold uppercase tracking-wide text-[var(--foreground)] border border-[var(--border)] rounded px-2 py-1 bg-[var(--background)] hover:bg-[var(--background-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                title={user ? "Connect GitHub" : "Sign in to connect GitHub"}
              >
                Add GitHub Repo
              </button>
            </div>
          </div>
        ) : (
          <div className="absolute inset-y-0 right-full mr-2 w-3 border border-[var(--border)] bg-[var(--background-elevated)] flex items-center justify-center nodrag shadow-sm">
            <button
              type="button"
              onClick={() => setShowWorkspace(true)}
              className="text-[10px] text-[var(--foreground-muted)]"
              title="Show workspace"
            >
              ▸
            </button>
          </div>
        )}
        <div className="h-full w-full bg-[#0a0a0b]" style={{ contain: "layout" }}>
          <TerminalEmulator
            ref={setTerminalRef}
            onData={handleTerminalData}
            onResize={handleTerminalResize}
            onReady={handleTerminalReady}
            disabled={!canType}
            fontSize={fontSize}
            className="w-full h-full"
          />
        </div>

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
                style={{ pointerEvents: "auto" }}
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

      {/* Footer controls - compact, pointer-events: none to allow drag, buttons get pointer-events: auto */}
      <div className="flex items-center justify-between px-2 py-1 border-t border-[var(--border)] bg-[var(--background)] shrink-0" style={{ pointerEvents: "none" }}>
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
              style={{ pointerEvents: "auto" }}
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
              style={{ pointerEvents: "auto" }}
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
          <div className="flex items-center gap-1" style={{ pointerEvents: "auto" }}>
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
    </div>
  );

  return (
    <>
      {/* Invisible placeholder node in ReactFlow for drag/resize handling */}
      <BlockWrapper
        selected={selected}
        className="p-0 overflow-hidden"
        minWidth={300}
        minHeight={200}
        style={{
          borderColor: "transparent",
          borderWidth: "2px",
        }}
      >
        {/* Invisible content - same structure for sizing but not rendered visually */}
        <div style={{ opacity: 0, pointerEvents: "none" }} className="w-full h-full" />
      </BlockWrapper>

      {/* Portal the entire terminal to overlay for correct z-ordering and no CSS transform issues */}
      {/* pointerEvents: none on wrapper allows drag events to pass through to ReactFlow node */}
      {overlay?.root && blockWidth > 0 && blockHeight > 0
        ? createPortal(
            <div
              style={{
                position: "absolute",
                left: `${blockX}px`,
                top: `${blockY}px`,
                width: `${blockWidth}px`,
                height: `${blockHeight}px`,
                zIndex,
                pointerEvents: "none",
              }}
            >
              {terminalContent}
            </div>,
            overlay.root
          )
        : terminalContent}
    </>
  );
}

export default TerminalBlock;
