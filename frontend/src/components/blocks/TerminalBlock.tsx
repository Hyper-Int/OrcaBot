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
  Menu,
  Key,
  Wand2,
  Puzzle,
  Wrench,
  Volume2,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { BlockWrapper } from "./BlockWrapper";
import {
  Button,
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from "@/components/ui";
import { ConnectionHandles } from "./ConnectionHandles";
import { ConnectionMarkers } from "./ConnectionMarkers";
import {
  Terminal as TerminalEmulator,
  type TerminalHandle,
} from "@/components/terminal";
import { useTerminal } from "@/hooks/useTerminal";
import { useAuthStore } from "@/stores/auth-store";
import { useThemeStore } from "@/stores/theme-store";
import { createSession } from "@/lib/api/cloudflare";
import {
  createSubagent,
  deleteSubagent,
  listSubagents,
  type UserSubagent,
  createSecret,
  deleteSecret,
  listSecrets,
  type UserSecret,
  createAgentSkill,
  deleteAgentSkill,
  listAgentSkills,
  type UserAgentSkill,
  createMcpTool,
  deleteMcpTool,
  listMcpTools,
  type UserMcpTool,
} from "@/lib/api/cloudflare";
import type { Session } from "@/types/dashboard";
import { useTerminalOverlay } from "@/components/terminal";
import subagentCatalog from "@/data/claude-subagents.json";
import agentSkillsCatalog from "@/data/claude-agent-skills.json";
import mcpToolsCatalog from "@/data/claude-mcp-tools.json";

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
  connectorMode?: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
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

type AgentSkillCatalogItem = {
  id: string;
  name: string;
  description: string;
  command: string;
  args?: string[];
};

type AgentSkillCatalogCategory = {
  id: string;
  title: string;
  items: AgentSkillCatalogItem[];
};

type McpToolCatalogItem = {
  id: string;
  name: string;
  description: string;
  serverUrl: string;
  transport: "stdio" | "sse" | "streamable-http";
  config?: Record<string, unknown>;
};

type McpToolCatalogCategory = {
  id: string;
  title: string;
  items: McpToolCatalogItem[];
};

type ActivePanel = "secrets" | "subagents" | "agent-skills" | "plugins" | "mcp-tools" | "tts-voice" | null;

type TerminalContentState = {
  name: string;
  subagentIds: string[];
  agentic?: boolean;
  bootCommand?: string;
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
      return {
        name,
        subagentIds,
        agentic: parsed.agentic,
        bootCommand: parsed.bootCommand,
      };
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
  const { theme } = useThemeStore();
  const queryClient = useQueryClient();
  const [isReady, setIsReady] = React.useState(false);
  const [isClaudeSession, setIsClaudeSession] = React.useState(false);
  const [activePanel, setActivePanel] = React.useState<ActivePanel>(null);
  const [activeSubagentTab, setActiveSubagentTab] = React.useState<"saved" | "browse">("saved");
  const [activeSkillsTab, setActiveSkillsTab] = React.useState<"saved" | "browse">("saved");
  const [activeMcpTab, setActiveMcpTab] = React.useState<"saved" | "browse">("saved");
  const [expandedCategories, setExpandedCategories] = React.useState<Record<string, boolean>>({});
  const [showAttachedList, setShowAttachedList] = React.useState(false);
  const [newSecretName, setNewSecretName] = React.useState("");
  const [newSecretValue, setNewSecretValue] = React.useState("");
  const onRegisterTerminal = data.onRegisterTerminal;
  const connectorsVisible = selected || Boolean(data.connectorMode);
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
  const autoControlRequestedRef = React.useRef(false);

  const createdBrowserUrlsRef = React.useRef<Set<string>>(new Set());
  const outputBufferRef = React.useRef("");
  const browserScanTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const catalog = subagentCatalog as { categories: SubagentCatalogCategory[] };
  const skillsCatalog = agentSkillsCatalog as { categories: AgentSkillCatalogCategory[] };
  const mcpCatalog = mcpToolsCatalog as { categories: McpToolCatalogCategory[] };

  React.useEffect(() => {
    createdBrowserUrlsRef.current.clear();
    outputBufferRef.current = "";
    if (browserScanTimeoutRef.current) {
      clearTimeout(browserScanTimeoutRef.current);
      browserScanTimeoutRef.current = null;
    }
    setIsClaudeSession(false);
    setActivePanel(null);
    autoControlRequestedRef.current = false;
  }, [session?.id]);
  const [isCreatingSession, setIsCreatingSession] = React.useState(false);
  const [sessionError, setSessionError] = React.useState<string | null>(null);

  // Secrets queries and mutations
  const secretsQuery = useQuery({
    queryKey: ["secrets"],
    queryFn: () => listSecrets(),
    enabled: activePanel === "secrets",
    staleTime: 60000,
  });

  const createSecretMutation = useMutation({
    mutationFn: createSecret,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["secrets"] });
      setNewSecretName("");
      setNewSecretValue("");
    },
  });

  const deleteSecretMutation = useMutation({
    mutationFn: deleteSecret,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["secrets"] });
    },
  });

  // Subagents queries and mutations
  const subagentsQuery = useQuery({
    queryKey: ["subagents"],
    queryFn: () => listSubagents(),
    enabled: activePanel === "subagents",
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

  // Agent Skills queries and mutations
  const agentSkillsQuery = useQuery({
    queryKey: ["agent-skills"],
    queryFn: () => listAgentSkills(),
    enabled: activePanel === "agent-skills",
    staleTime: 60000,
  });

  const createAgentSkillMutation = useMutation({
    mutationFn: createAgentSkill,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-skills"] });
    },
  });

  const deleteAgentSkillMutation = useMutation({
    mutationFn: deleteAgentSkill,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-skills"] });
    },
  });

  // MCP Tools queries and mutations
  const mcpToolsQuery = useQuery({
    queryKey: ["mcp-tools"],
    queryFn: () => listMcpTools(),
    enabled: activePanel === "mcp-tools",
    staleTime: 60000,
  });

  const createMcpToolMutation = useMutation({
    mutationFn: createMcpTool,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-tools"] });
    },
  });

  const deleteMcpToolMutation = useMutation({
    mutationFn: deleteMcpTool,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-tools"] });
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

  // Agent Skills computed values
  const savedSkills = agentSkillsQuery.data || [];
  const savedSkillNames = React.useMemo(
    () => new Set(savedSkills.map((item) => item.name)),
    [savedSkills]
  );
  const savedSkillByName = React.useMemo(() => {
    const map = new Map<string, UserAgentSkill>();
    savedSkills.forEach((item) => map.set(item.name, item));
    return map;
  }, [savedSkills]);

  // MCP Tools computed values
  const savedMcpTools = mcpToolsQuery.data || [];
  const savedMcpNames = React.useMemo(
    () => new Set(savedMcpTools.map((item) => item.name)),
    [savedMcpTools]
  );
  const savedMcpByName = React.useMemo(() => {
    const map = new Map<string, UserMcpTool>();
    savedMcpTools.forEach((item) => map.set(item.name, item));
    return map;
  }, [savedMcpTools]);

  // Secrets computed values
  const savedSecrets = secretsQuery.data || [];

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

  // Agent Skills handlers
  const handleSaveAgentSkill = React.useCallback(
    (item: AgentSkillCatalogItem) => {
      if (savedSkillNames.has(item.name)) return;
      createAgentSkillMutation.mutate({
        name: item.name,
        description: item.description,
        command: item.command,
        args: item.args || [],
        source: "catalog",
      });
    },
    [createAgentSkillMutation, savedSkillNames]
  );

  // MCP Tools handlers
  const handleSaveMcpTool = React.useCallback(
    (item: McpToolCatalogItem) => {
      if (savedMcpNames.has(item.name)) return;
      createMcpToolMutation.mutate({
        name: item.name,
        description: item.description,
        serverUrl: item.serverUrl,
        transport: item.transport,
        config: item.config,
        source: "catalog",
      });
    },
    [createMcpToolMutation, savedMcpNames]
  );

  // Secrets handlers
  const handleAddSecret = React.useCallback(() => {
    if (!newSecretName.trim() || !newSecretValue.trim()) return;
    createSecretMutation.mutate({
      name: newSecretName.trim(),
      value: newSecretValue.trim(),
    });
  }, [createSecretMutation, newSecretName, newSecretValue]);

  const toggleCategory = React.useCallback((categoryId: string) => {
    setExpandedCategories((prev) => ({
      ...prev,
      [categoryId]: !prev[categoryId],
    }));
  }, []);

  const maybeCreateBrowserBlock = React.useCallback(
    (text: string) => {
      const urlRegex = /(https?:\/\/[^\s"'<>]+(?:\n[^\s"'<>]+)*)/g;
      const strippedText = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
      const matches = strippedText.match(urlRegex);
      if (!matches || matches.length === 0) {
        return;
      }

      for (const rawUrl of matches) {
        const flattened = rawUrl.replace(/\n/g, "");
        const cleanedUrl = flattened.replace(/[)\],.;]+$/, "");
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
            maybeCreateBrowserBlock(parts.join("\n"));
          }
          outputBufferRef.current = pending;
        }, 250);

      }, [isClaudeSession, maybeCreateBrowserBlock]),
    }
  );

  const { connectionState, turnTaking, agentState, error: wsError } = terminalState;

  // Computed state
  const isConnected = connectionState === "connected";
  const isConnecting = connectionState === "connecting" || connectionState === "reconnecting";
  const isFailed = connectionState === "failed";
  const isAgentRunning = agentState === "running";
  const isOwner = !!session && user?.id === session.ownerUserId;
  const isAgentic = terminalMeta.agentic === true;
  const canType = isOwner && turnTaking.isController && !isAgentRunning && isConnected;
  const canInsertPrompt = canType;
  const terminalTheme = React.useMemo(
    () =>
      theme === "dark"
        ? {
            background: "#0a0a0b",
            foreground: "#e6e6e6",
            cursor: "#e6e6e6",
            selection: "rgba(255,255,255,0.2)",
          }
        : {
            background: "#ffffff",
            foreground: "#0f172a",
            cursor: "#0f172a",
            selection: "rgba(15,23,42,0.2)",
          },
    [theme]
  );

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

  // Terminals always sit above other blocks; order is tracked by z-index map.
  const baseZIndex = overlay?.getZIndex(id) ?? 0;
  const zIndex = baseZIndex + 10000;

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

      // Control is requested separately once connected.
    }
  }, [isConnected, session, isReady]);

  React.useEffect(() => {
    if (!isConnected) {
      autoControlRequestedRef.current = false;
      return;
    }
    if (!session || !isOwner || isAgentRunning || turnTaking.isController) {
      return;
    }
    if (autoControlRequestedRef.current) {
      return;
    }
    autoControlRequestedRef.current = true;
    terminalActions.takeControl();
  }, [isConnected, session, isOwner, isAgentRunning, turnTaking.isController, terminalActions]);


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
        "relative flex flex-col rounded-[var(--radius-card)] group",
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
      {/* Panel overlay - shows above terminal when a panel is open */}
      {(isClaudeSession || isAgentic) && (showAttachedList || activePanel !== null) && (
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
                {terminalMeta.subagentIds.map((subId) => (
                  <div
                    key={subId}
                    className="flex items-center justify-between rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1"
                  >
                    <span className="text-[var(--foreground)]">
                      {savedById.get(subId)?.name || "Unknown"}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDetachSubagent(subId)}
                      className="text-[10px] h-5 px-2 nodrag"
                    >
                      Detach
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Secrets Panel */}
          {activePanel === "secrets" && (
            <div className="rounded border border-[var(--border)] bg-[var(--background-elevated)] shadow-md w-80">
              <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--border)]">
                <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--foreground)]">
                  <Key className="w-3 h-3" />
                  <span>Secrets</span>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setActivePanel(null)}
                  className="h-5 w-5 nodrag"
                >
                  <X className="w-3 h-3" />
                </Button>
              </div>
              <div className="p-2 space-y-2 text-xs">
                <div className="flex gap-1">
                  <Input
                    placeholder="Name"
                    value={newSecretName}
                    onChange={(e) => setNewSecretName(e.target.value)}
                    className="h-6 text-xs flex-1 nodrag"
                  />
                  <Input
                    type="password"
                    placeholder="Value"
                    value={newSecretValue}
                    onChange={(e) => setNewSecretValue(e.target.value)}
                    className="h-6 text-xs flex-1 nodrag"
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleAddSecret}
                    disabled={!newSecretName.trim() || !newSecretValue.trim()}
                    className="h-6 px-2 nodrag"
                  >
                    <Plus className="w-3 h-3" />
                  </Button>
                </div>
                <div className="max-h-40 overflow-auto space-y-1">
                  {secretsQuery.isLoading && (
                    <div className="text-[var(--foreground-muted)]">Loading...</div>
                  )}
                  {!secretsQuery.isLoading && savedSecrets.length === 0 && (
                    <div className="text-[var(--foreground-muted)]">No secrets configured.</div>
                  )}
                  {savedSecrets.map((secret) => (
                    <div
                      key={secret.id}
                      className="flex items-center justify-between rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1"
                    >
                      <span className="text-[var(--foreground)] font-mono">{secret.name}</span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => deleteSecretMutation.mutate(secret.id)}
                        className="h-5 w-5 text-[var(--status-error)] nodrag"
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Subagents Panel */}
          {activePanel === "subagents" && (
            <div className="rounded border border-[var(--border)] bg-[var(--background-elevated)] shadow-md">
              <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--border)]">
                <div className="flex items-center gap-1">
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
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setActivePanel(null)}
                  className="h-5 w-5 nodrag"
                >
                  <X className="w-3 h-3" />
                </Button>
              </div>
              <div className="max-h-56 overflow-auto px-2 pb-2 text-xs">
                {activeSubagentTab === "saved" ? (
                  <div className="space-y-2 pt-2">
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
                  <div className="space-y-3 pt-2">
                    {catalog.categories.map((category) => (
                      <div key={category.id} className="rounded border border-[var(--border)]">
                        <button
                          type="button"
                          onClick={() => toggleCategory(`subagent-${category.id}`)}
                          className="w-full flex items-center justify-between px-2 py-1 text-[11px] font-semibold text-[var(--foreground)] bg-[var(--background)] nodrag"
                        >
                          <span>{category.title}</span>
                          {expandedCategories[`subagent-${category.id}`] ? (
                            <ChevronDown className="w-3 h-3 text-[var(--foreground-muted)]" />
                          ) : (
                            <ChevronRight className="w-3 h-3 text-[var(--foreground-muted)]" />
                          )}
                        </button>
                        {expandedCategories[`subagent-${category.id}`] && (
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

          {/* Agent Skills Panel */}
          {activePanel === "agent-skills" && (
            <div className="rounded border border-[var(--border)] bg-[var(--background-elevated)] shadow-md">
              <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--border)]">
                <div className="flex items-center gap-1">
                  <Button
                    variant={activeSkillsTab === "saved" ? "primary" : "ghost"}
                    size="sm"
                    onClick={() => setActiveSkillsTab("saved")}
                    className="text-[10px] h-5 px-2 nodrag"
                  >
                    Saved
                  </Button>
                  <Button
                    variant={activeSkillsTab === "browse" ? "primary" : "ghost"}
                    size="sm"
                    onClick={() => setActiveSkillsTab("browse")}
                    className="text-[10px] h-5 px-2 nodrag"
                  >
                    Browse
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setActivePanel(null)}
                  className="h-5 w-5 nodrag"
                >
                  <X className="w-3 h-3" />
                </Button>
              </div>
              <div className="max-h-56 overflow-auto px-2 pb-2 text-xs">
                {activeSkillsTab === "saved" ? (
                  <div className="space-y-2 pt-2">
                    {!agentSkillsQuery.isLoading && savedSkills.length === 0 && (
                      <div className="text-[var(--foreground-muted)]">
                        No saved skills yet.
                      </div>
                    )}
                    {savedSkills.map((item) => (
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
                          <div className="text-[10px] text-[var(--accent-primary)] font-mono">
                            {item.command}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => deleteAgentSkillMutation.mutate(item.id)}
                          className="h-5 w-5 text-[var(--status-error)] nodrag"
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-3 pt-2">
                    {skillsCatalog.categories.map((category) => (
                      <div key={category.id} className="rounded border border-[var(--border)]">
                        <button
                          type="button"
                          onClick={() => toggleCategory(`skill-${category.id}`)}
                          className="w-full flex items-center justify-between px-2 py-1 text-[11px] font-semibold text-[var(--foreground)] bg-[var(--background)] nodrag"
                        >
                          <span>{category.title}</span>
                          {expandedCategories[`skill-${category.id}`] ? (
                            <ChevronDown className="w-3 h-3 text-[var(--foreground-muted)]" />
                          ) : (
                            <ChevronRight className="w-3 h-3 text-[var(--foreground-muted)]" />
                          )}
                        </button>
                        {expandedCategories[`skill-${category.id}`] && (
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
                                  <div className="text-[10px] text-[var(--accent-primary)] font-mono">
                                    {item.command}
                                  </div>
                                </div>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleSaveAgentSkill(item)}
                                  disabled={savedSkillNames.has(item.name)}
                                  className="text-[10px] h-5 px-2 nodrag"
                                >
                                  {savedSkillNames.has(item.name) ? "Saved" : "Save"}
                                </Button>
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

          {/* Plugins Panel (Placeholder) */}
          {activePanel === "plugins" && (
            <div className="rounded border border-[var(--border)] bg-[var(--background-elevated)] shadow-md w-64">
              <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--border)]">
                <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--foreground)]">
                  <Puzzle className="w-3 h-3" />
                  <span>Plugins</span>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setActivePanel(null)}
                  className="h-5 w-5 nodrag"
                >
                  <X className="w-3 h-3" />
                </Button>
              </div>
              <div className="p-3 text-xs text-[var(--foreground-muted)] text-center">
                Plugins coming soon...
              </div>
            </div>
          )}

          {/* MCP Tools Panel */}
          {activePanel === "mcp-tools" && (
            <div className="rounded border border-[var(--border)] bg-[var(--background-elevated)] shadow-md">
              <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--border)]">
                <div className="flex items-center gap-1">
                  <Button
                    variant={activeMcpTab === "saved" ? "primary" : "ghost"}
                    size="sm"
                    onClick={() => setActiveMcpTab("saved")}
                    className="text-[10px] h-5 px-2 nodrag"
                  >
                    Saved
                  </Button>
                  <Button
                    variant={activeMcpTab === "browse" ? "primary" : "ghost"}
                    size="sm"
                    onClick={() => setActiveMcpTab("browse")}
                    className="text-[10px] h-5 px-2 nodrag"
                  >
                    Browse
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setActivePanel(null)}
                  className="h-5 w-5 nodrag"
                >
                  <X className="w-3 h-3" />
                </Button>
              </div>
              <div className="max-h-56 overflow-auto px-2 pb-2 text-xs">
                {activeMcpTab === "saved" ? (
                  <div className="space-y-2 pt-2">
                    {!mcpToolsQuery.isLoading && savedMcpTools.length === 0 && (
                      <div className="text-[var(--foreground-muted)]">
                        No saved MCP tools yet.
                      </div>
                    )}
                    {savedMcpTools.map((item) => (
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
                          <div className="text-[10px] text-[var(--accent-primary)] font-mono">
                            {item.transport}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => deleteMcpToolMutation.mutate(item.id)}
                          className="h-5 w-5 text-[var(--status-error)] nodrag"
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-3 pt-2">
                    {mcpCatalog.categories.map((category) => (
                      <div key={category.id} className="rounded border border-[var(--border)]">
                        <button
                          type="button"
                          onClick={() => toggleCategory(`mcp-${category.id}`)}
                          className="w-full flex items-center justify-between px-2 py-1 text-[11px] font-semibold text-[var(--foreground)] bg-[var(--background)] nodrag"
                        >
                          <span>{category.title}</span>
                          {expandedCategories[`mcp-${category.id}`] ? (
                            <ChevronDown className="w-3 h-3 text-[var(--foreground-muted)]" />
                          ) : (
                            <ChevronRight className="w-3 h-3 text-[var(--foreground-muted)]" />
                          )}
                        </button>
                        {expandedCategories[`mcp-${category.id}`] && (
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
                                  <div className="text-[10px] text-[var(--accent-primary)] font-mono">
                                    {item.transport}
                                  </div>
                                </div>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleSaveMcpTool(item)}
                                  disabled={savedMcpNames.has(item.name)}
                                  className="text-[10px] h-5 px-2 nodrag"
                                >
                                  {savedMcpNames.has(item.name) ? "Saved" : "Save"}
                                </Button>
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

          {/* TTS Voice Panel (Placeholder) */}
          {activePanel === "tts-voice" && (
            <div className="rounded border border-[var(--border)] bg-[var(--background-elevated)] shadow-md w-64">
              <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--border)]">
                <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--foreground)]">
                  <Volume2 className="w-3 h-3" />
                  <span>TTS Voice</span>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setActivePanel(null)}
                  className="h-5 w-5 nodrag"
                >
                  <X className="w-3 h-3" />
                </Button>
              </div>
              <div className="p-3 text-xs text-[var(--foreground-muted)] text-center">
                Text-to-speech coming soon...
              </div>
            </div>
          )}
        </div>
      )}

      {(isClaudeSession || isAgentic) && (
        <div
          className="flex items-center justify-between px-2 py-1 border-b border-[var(--border)] bg-[var(--background)] text-xs"
          style={{ pointerEvents: "none" }}
        >
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--foreground-muted)]">
            <span>{terminalMeta.name}</span>
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant={activePanel !== null ? "primary" : "ghost"}
                size="icon-sm"
                className="h-5 w-5 nodrag"
                style={{ pointerEvents: "auto" }}
              >
                <Menu className="w-3 h-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onClick={() => setActivePanel("secrets")} className="gap-2">
                <Key className="w-3 h-3" />
                <span>Secrets</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setActivePanel("subagents")} className="gap-2">
                <Bot className="w-3 h-3" />
                <span>Subagents</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setActivePanel("agent-skills")} className="gap-2">
                <Wand2 className="w-3 h-3" />
                <span>Agent Skills</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setActivePanel("plugins")} className="gap-2">
                <Puzzle className="w-3 h-3" />
                <span>Plugins</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setActivePanel("mcp-tools")} className="gap-2">
                <Wrench className="w-3 h-3" />
                <span>MCP Tools</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setActivePanel("tts-voice")} className="gap-2">
                <Volume2 className="w-3 h-3" />
                <span>TTS Voice</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
      <div
        className="relative flex-1 min-h-0 nodrag"
        style={{ overflow: "visible", pointerEvents: "auto", backgroundColor: terminalTheme.background }}
      >
        <div className="h-full w-full" style={{ contain: "layout", backgroundColor: terminalTheme.background }}>
          <TerminalEmulator
            ref={setTerminalRef}
            onData={handleTerminalData}
            onResize={handleTerminalResize}
            onReady={handleTerminalReady}
            disabled={!canType}
            fontSize={fontSize}
            theme={terminalTheme}
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
        {session && isConnected && !canType && (isAgentRunning || !isOwner) && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
            <div className="bg-[var(--background-elevated)] px-4 py-2 rounded-lg border border-[var(--border)] flex items-center gap-2">
              <Lock className="w-4 h-4 text-[var(--foreground-muted)]" />
              <span className="text-sm text-[var(--foreground-muted)]">
                {isAgentRunning
                  ? "Agent is running"
                  : "View-only session"}
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

          {session && isConnected && turnTaking.isController && (
            <div className="flex items-center gap-1 text-[10px] text-[var(--foreground-subtle)]">
              <div className="w-1.5 h-1.5 rounded-full bg-[var(--status-success)] animate-pulse" />
              Control active
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 text-[10px] text-[var(--foreground-subtle)]">
          {session && (
            <div>
              Owner: {session.ownerName || "—"}
            </div>
          )}

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
        includeHandles={false}
        style={{
          borderColor: "transparent",
          borderWidth: "2px",
        }}
      >
        {/* Invisible content - same structure for sizing but not rendered visually */}
        <div style={{ opacity: 0, pointerEvents: "none" }} className="w-full h-full" />
        <ConnectionHandles
          nodeId={id}
          visible={false}
          onConnectorClick={data.onConnectorClick}
          topMode="none"
          bottomMode="both"
        />
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
              className="group"
            >
              {terminalContent}
              <ConnectionMarkers
                nodeId={id}
                visible={connectorsVisible}
                onConnectorClick={data.onConnectorClick}
                topMode="none"
                bottomMode="both"
                bottomVariant="single"
              />
            </div>,
            overlay.root
          )
        : terminalContent}
    </>
  );
}

export default TerminalBlock;
