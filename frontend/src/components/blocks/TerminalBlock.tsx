// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { type NodeProps, type Node, useReactFlow } from "@xyflow/react";
import {
  Terminal,
  Bot,
  Pause,
  Play,
  Square,
  Lock,
  Plug,
  Loader2,
  AlertCircle,
  Settings,
  Key,
  Wand2,
  Wrench,
  Volume2,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  X,
  RefreshCw,
  Pencil,
  Eye,
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
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
import { createSession, stopSession, updateSessionEnv } from "@/lib/api/cloudflare";
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

type ActivePanel = "secrets" | "subagents" | "agent-skills" | "mcp-tools" | "tts-voice" | null;

type TerminalContentState = {
  name: string;
  subagentIds: string[];
  agentic?: boolean;
  bootCommand?: string;
  terminalTheme?: "system" | "light" | "dark";
};

type CatalogCategory<TItem> = {
  id: string;
  title: string;
  items: TItem[];
};

type CatalogPanelProps<TSaved, TBrowse> = {
  title: string;
  activeTab: "saved" | "browse";
  onTabChange: (tab: "saved" | "browse") => void;
  onClose: () => void;
  savedItems: TSaved[];
  savedLoading: boolean;
  savedEmptyText: string;
  renderSavedItem: (item: TSaved) => React.ReactNode;
  categories: CatalogCategory<TBrowse>[];
  categoryPrefix: string;
  expandedCategories: Record<string, boolean>;
  onToggleCategory: (id: string) => void;
  renderBrowseItem: (item: TBrowse) => React.ReactNode;
  browseTabLabel?: string;
};

function CatalogPanel<TSaved, TBrowse>({
  title,
  activeTab,
  onTabChange,
  onClose,
  savedItems,
  savedLoading,
  savedEmptyText,
  renderSavedItem,
  categories,
  categoryPrefix,
  expandedCategories,
  onToggleCategory,
  renderBrowseItem,
  browseTabLabel = "Public",
}: CatalogPanelProps<TSaved, TBrowse>) {
  return (
    <div className="rounded border border-[var(--border)] bg-[var(--background-elevated)] shadow-md min-w-80">
      <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[var(--foreground)]">{title}</span>
          <div className="flex items-center gap-1">
            <Button
              variant={activeTab === "saved" ? "primary" : "ghost"}
              size="sm"
              onClick={() => onTabChange("saved")}
              className="text-[10px] h-5 px-2 nodrag"
            >
              Saved
            </Button>
            <Button
              variant={activeTab === "browse" ? "primary" : "ghost"}
              size="sm"
              onClick={() => onTabChange("browse")}
              className="text-[10px] h-5 px-2 nodrag"
            >
              {browseTabLabel}
            </Button>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          className="h-5 w-5 nodrag"
        >
          <X className="w-3 h-3" />
        </Button>
      </div>
      <div className="max-h-56 overflow-auto px-2 pb-2 text-xs">
        {activeTab === "saved" ? (
          <div className="space-y-2 pt-2">
            {!savedLoading && savedItems.length === 0 && (
              <div className="text-[var(--foreground-muted)]">{savedEmptyText}</div>
            )}
            {savedItems.map((item) => renderSavedItem(item))}
          </div>
        ) : (
          <div className="space-y-3 pt-2">
            {categories.map((category) => {
              const categoryKey = `${categoryPrefix}-${category.id}`;
              return (
                <div key={category.id} className="rounded border border-[var(--border)]">
                  <button
                    type="button"
                    onClick={() => onToggleCategory(categoryKey)}
                    className="w-full flex items-center justify-between px-2 py-1 text-[11px] font-semibold text-[var(--foreground)] bg-[var(--background)] nodrag"
                  >
                    <span>{category.title}</span>
                    {expandedCategories[categoryKey] ? (
                      <ChevronDown className="w-3 h-3 text-[var(--foreground-muted)]" />
                    ) : (
                      <ChevronRight className="w-3 h-3 text-[var(--foreground-muted)]" />
                    )}
                  </button>
                  {expandedCategories[categoryKey] && (
                    <div className="p-2 space-y-2">
                      {category.items.map((item) => renderBrowseItem(item))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

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
        terminalTheme: parsed.terminalTheme,
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
  const { deleteElements } = useReactFlow();
  const [isReady, setIsReady] = React.useState(false);
  const [isClaudeSession, setIsClaudeSession] = React.useState(false);
  const [activePanel, setActivePanel] = React.useState<ActivePanel>(null);
  const [activeSubagentTab, setActiveSubagentTab] = React.useState<"saved" | "browse">("saved");
  const [activeSkillsTab, setActiveSkillsTab] = React.useState<"saved" | "browse">("saved");
  const [activeMcpTab, setActiveMcpTab] = React.useState<"saved" | "browse">("saved");
  const [expandedCategories, setExpandedCategories] = React.useState<Record<string, boolean>>({});
  const [showAttachedList, setShowAttachedList] = React.useState(false);
  const [showSavedSkills, setShowSavedSkills] = React.useState(false);
  const [showSavedMcp, setShowSavedMcp] = React.useState(false);
  const [newSecretName, setNewSecretName] = React.useState("");
  const [newSecretValue, setNewSecretValue] = React.useState("");
  const [pendingSecretApply, setPendingSecretApply] = React.useState<{ name: string; value: string } | null>(null);
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
  const upsertDashboardSession = React.useCallback(
    (nextSession: Session) => {
      if (!data.dashboardId) return;
      queryClient.setQueryData(
        ["dashboard", data.dashboardId],
        (oldData:
          | { sessions: Session[]; [key: string]: unknown }
          | undefined) => {
          if (!oldData) return oldData;
          const sessions = Array.isArray(oldData.sessions) ? oldData.sessions : [];
          const hasSession = sessions.some((entry) => entry.id === nextSession.id);
          return {
            ...oldData,
            sessions: hasSession
              ? sessions.map((entry) => (entry.id === nextSession.id ? nextSession : entry))
              : [...sessions, nextSession],
          };
        }
      );
    },
    [data.dashboardId, queryClient]
  );
  const autoControlRequestedRef = React.useRef(false);

  const createdBrowserUrlsRef = React.useRef<Set<string>>(new Set());
  const outputBufferRef = React.useRef("");
  const oscBufferRef = React.useRef("");
  const catalog = subagentCatalog as { categories: SubagentCatalogCategory[] };
  const skillsCatalog = agentSkillsCatalog as { categories: AgentSkillCatalogCategory[] };
  const mcpCatalog = mcpToolsCatalog as { categories: McpToolCatalogCategory[] };

  React.useEffect(() => {
    createdBrowserUrlsRef.current.clear();
    outputBufferRef.current = "";
    setIsClaudeSession(false);
    setActivePanel(null);
    autoControlRequestedRef.current = false;
  }, [session?.id]);
  const [isCreatingSession, setIsCreatingSession] = React.useState(false);
  const [sessionError, setSessionError] = React.useState<string | null>(null);

  // Secrets queries and mutations
  const secretsQuery = useQuery({
    queryKey: ["secrets", data.dashboardId],
    queryFn: () => listSecrets(data.dashboardId),
    enabled: activePanel === "secrets" && Boolean(data.dashboardId),
    staleTime: 60000,
  });

  const createSecretMutation = useMutation({
    mutationFn: createSecret,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["secrets", data.dashboardId] });
      setNewSecretName("");
      setNewSecretValue("");
    },
  });

  const deleteSecretMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => deleteSecret(id, data.dashboardId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["secrets", data.dashboardId] });
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
        content: JSON.stringify({
          name: terminalMeta.name,
          subagentIds: nextIds,
          agentic: terminalMeta.agentic,
          bootCommand: terminalMeta.bootCommand,
          terminalTheme: terminalMeta.terminalTheme,
        }),
      });
    },
    [data, terminalMeta]
  );

  const handleDetachSubagent = React.useCallback(
    (subagentId: string) => {
      if (!data.onItemChange) return;
      const nextIds = terminalMeta.subagentIds.filter((id) => id !== subagentId);
      data.onItemChange({
        content: JSON.stringify({
          name: terminalMeta.name,
          subagentIds: nextIds,
          agentic: terminalMeta.agentic,
          bootCommand: terminalMeta.bootCommand,
          terminalTheme: terminalMeta.terminalTheme,
        }),
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

  const handleTerminalThemeChange = React.useCallback(
    (nextTheme: "system" | "light" | "dark") => {
      if (!data.onItemChange) return;
      data.onItemChange({
        content: JSON.stringify({
          name: terminalMeta.name,
          subagentIds: terminalMeta.subagentIds,
          agentic: terminalMeta.agentic,
          bootCommand: terminalMeta.bootCommand,
          terminalTheme: nextTheme,
        }),
      });
    },
    [data, terminalMeta]
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

  const toggleCategory = React.useCallback((categoryId: string) => {
    setExpandedCategories((prev) => ({
      ...prev,
      [categoryId]: !prev[categoryId],
    }));
  }, []);

  const maybeCreateBrowserBlock = React.useCallback(
    (url: string) => {
      if (createdBrowserUrlsRef.current.has(url)) {
        return;
      }
      createdBrowserUrlsRef.current.add(url);
      data.onCreateBrowserBlock?.(url, {
        x: positionAbsoluteX + (width ?? data.size.width) + 24,
        y: positionAbsoluteY + 24,
      }, id);
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
        const text = new TextDecoder().decode(dataBytes);
        const markerStart = "\u001b]9;orcabot-open;";
        const markerEnd = "\u001b\\";
        const buffer = oscBufferRef.current + text;
        let output = "";
        let searchIndex = 0;
        let incompleteIndex = -1;

        while (true) {
          const start = buffer.indexOf(markerStart, searchIndex);
          if (start === -1) {
            output += buffer.slice(searchIndex);
            break;
          }
          const end = buffer.indexOf(markerEnd, start + markerStart.length);
          if (end === -1) {
            incompleteIndex = start;
            output += buffer.slice(searchIndex, start);
            break;
          }
          output += buffer.slice(searchIndex, start);
          const url = buffer.slice(start + markerStart.length, end).trim();
          if (url) {
            maybeCreateBrowserBlock(url);
          }
          searchIndex = end + markerEnd.length;
        }

        oscBufferRef.current = incompleteIndex >= 0 ? buffer.slice(incompleteIndex) : "";
        const cleaned = output;

        terminalRef.current?.write(cleaned);
        outputBufferRef.current = (outputBufferRef.current + cleaned).slice(-2000);
        if (!isClaudeSession && /Claude Code v/i.test(outputBufferRef.current)) {
          setIsClaudeSession(true);
        }
      }, [isClaudeSession, maybeCreateBrowserBlock]),
    }
  );

  const { connectionState, turnTaking, agentState, ptyClosed, error: wsError } = terminalState;

  // Track if we were ever connected (to distinguish initial disconnected from lost connection)
  const wasConnectedRef = React.useRef(false);
  React.useEffect(() => {
    if (connectionState === "connected") {
      wasConnectedRef.current = true;
    }
  }, [connectionState]);

  // Reset wasConnected when session changes (new session created)
  React.useEffect(() => {
    wasConnectedRef.current = false;
  }, [session?.id]);

  // Computed state
  const isConnected = connectionState === "connected";
  const isConnecting = connectionState === "connecting" || connectionState === "reconnecting";
  const isFailed = connectionState === "failed";
  const isDisconnected = connectionState === "disconnected" && wasConnectedRef.current;
  const isAgentRunning = agentState === "running";
  const isOwner = !!session && user?.id === session.ownerUserId;
  const isAgentic = terminalMeta.agentic === true;
  const canType = isOwner && turnTaking.isController && !isAgentRunning && isConnected;
  const canInsertPrompt = canType;
  const terminalThemeSetting = terminalMeta.terminalTheme ?? "system";
  const resolvedTerminalTheme = terminalThemeSetting === "system" ? theme : terminalThemeSetting;
  const terminalTheme = React.useMemo(
    () =>
      resolvedTerminalTheme === "dark"
        ? {
            background: "#0a0a0b",
            foreground: "#e6e6e6",
            cursor: "#e6e6e6",
            selection: "rgba(255,255,255,0.2)",
            selectionBackground: "rgba(255,255,255,0.2)",
            selectionInactiveBackground: "rgba(255,255,255,0.12)",
          }
        : {
            background: "#ffffff",
            foreground: "#0f172a",
            cursor: "#0f172a",
            selection: "rgba(15,23,42,0.2)",
            selectionBackground: "rgba(15,23,42,0.2)",
            selectionInactiveBackground: "rgba(15,23,42,0.12)",
          },
    [resolvedTerminalTheme]
  );
  const canApplySecretsNow = isOwner && Boolean(session?.id);
  const needsRestartForSecrets = isClaudeSession || isAgentic;

  // Secrets handlers
  const handleAddSecret = React.useCallback(async () => {
    const name = newSecretName.trim();
    const value = newSecretValue.trim();
    if (!name || !value) return;
    setNewSecretName("");
    setNewSecretValue("");
    try {
      await createSecretMutation.mutateAsync({
        dashboardId: data.dashboardId,
        name,
        value,
      });
      setPendingSecretApply({ name, value });
      if (isOwner && session?.id) {
        await updateSessionEnv(session.id, { set: { [name]: value }, applyNow: false });
      }
    } catch {
      setNewSecretName(name);
      setNewSecretValue(value);
    }
  }, [createSecretMutation, data.dashboardId, newSecretName, newSecretValue, isOwner, session?.id]);

  const handleDeleteSecret = React.useCallback(
    async (secret: UserSecret) => {
      await deleteSecretMutation.mutateAsync({ id: secret.id });
      if (isOwner && session?.id) {
        await updateSessionEnv(session.id, { unset: [secret.name], applyNow: false });
      }
      setPendingSecretApply((current) =>
        current?.name === secret.name ? null : current
      );
    },
    [deleteSecretMutation, isOwner, session?.id]
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
      upsertDashboardSession(newSession);

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

  // Delete terminal block handler
  const handleDeleteBlock = React.useCallback(() => {
    deleteElements({ nodes: [{ id }] });
  }, [deleteElements, id]);

  // Reopen terminal - stops old session and creates new one
  const handleReopen = React.useCallback(async () => {
    if (!data.dashboardId) {
      setSessionError("Dashboard ID not found");
      return;
    }

    setIsCreatingSession(true);
    setSessionError(null);

    try {
      // Stop the old session if it exists
      if (session) {
        console.log(`[TerminalBlock] Stopping old session ${session.id}...`);
        try {
          await stopSession(session.id);
        } catch (e) {
          // Ignore errors - session might already be stopped
          console.log(`[TerminalBlock] Failed to stop session (may already be stopped):`, e);
        }
        setSession(null);
      }

      // Clear terminal
      if (isReady) {
        terminalRef.current?.write("\x1b[2J\x1b[H"); // Clear screen
        terminalRef.current?.write("\x1b[32mReconnecting...\x1b[0m\r\n");
      }

      // Create new session
      console.log(`[TerminalBlock] Creating new session...`);
      const newSession = await createSession(data.dashboardId, id);
      console.log(`[TerminalBlock] New session created:`, newSession);
      setSession(newSession);
      upsertDashboardSession(newSession);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Failed to create session";
      setSessionError(errorMsg);
      if (isReady) {
        terminalRef.current?.write(`\x1b[31mError: ${errorMsg}\x1b[0m\r\n`);
      }
    } finally {
      setIsCreatingSession(false);
    }
  }, [data.dashboardId, isReady, session, id, stopSession, upsertDashboardSession]);

  const handleApplySecretNow = React.useCallback(async () => {
    if (!pendingSecretApply || !canApplySecretsNow) {
      return;
    }
    if (needsRestartForSecrets) {
      setPendingSecretApply(null);
      await handleReopen();
      return;
    }
    if (!session?.id) {
      return;
    }
    await updateSessionEnv(session.id, {
      set: { [pendingSecretApply.name]: pendingSecretApply.value },
      applyNow: true,
    });
    setPendingSecretApply(null);
  }, [
    pendingSecretApply,
    canApplySecretsNow,
    needsRestartForSecrets,
    handleReopen,
    session?.id,
  ]);

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

  const autoReopenAttemptedRef = React.useRef(false);
  React.useEffect(() => {
    if (isConnected) {
      autoReopenAttemptedRef.current = false;
    }
  }, [isConnected, session?.id]);

  React.useEffect(() => {
    if (!session || !isOwner) {
      return;
    }
    if (!isFailed && !isDisconnected && !ptyClosed) {
      return;
    }
    if (session.status !== "stopped") {
      return;
    }
    if (isCreatingSession || autoReopenAttemptedRef.current) {
      return;
    }
    autoReopenAttemptedRef.current = true;
    terminalRef.current?.write("\x1b[90mReconnecting to a fresh session...\x1b[0m\r\n");
    void handleReopen();
  }, [
    session,
    isOwner,
    isFailed,
    isDisconnected,
    ptyClosed,
    isCreatingSession,
    handleReopen,
  ]);

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
      {/* Panel overlay - shows to the right of terminal when a panel is open */}
      {(activePanel !== null || showAttachedList || showSavedSkills || showSavedMcp) && (
        <div
          className="absolute top-0 left-full ml-2 flex flex-col gap-2"
          style={{ pointerEvents: "auto" }}
        >
          {/* Attached Subagents List */}
          {(showAttachedList || activePanel === "subagents") && (isClaudeSession || isAgentic) && (
            <div className="rounded border border-[var(--border)] bg-[var(--background-elevated)] shadow-md min-w-80">
              <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--border)]">
                <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--foreground)]">
                  <Bot className="w-3 h-3" />
                  <span>Attached Subagents</span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant={activePanel === "subagents" ? "primary" : "ghost"}
                    size="sm"
                    onClick={() => {
                      setActivePanel(activePanel === "subagents" ? null : "subagents");
                    }}
                    className="text-[10px] h-5 px-2 nodrag"
                  >
                    Add
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => {
                      setShowAttachedList(false);
                      if (activePanel === "subagents") {
                        setActivePanel(null);
                      }
                    }}
                    className="h-5 w-5 nodrag"
                  >
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              </div>
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

          {/* Saved Skills List */}
          {(showSavedSkills || activePanel === "agent-skills") && (isClaudeSession || isAgentic) && (
            <div className="rounded border border-[var(--border)] bg-[var(--background-elevated)] shadow-md min-w-80">
              <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--border)]">
                <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--foreground)]">
                  <Wand2 className="w-3 h-3" />
                  <span>Saved Skills</span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant={activePanel === "agent-skills" ? "primary" : "ghost"}
                    size="sm"
                    onClick={() => {
                      setActivePanel(activePanel === "agent-skills" ? null : "agent-skills");
                    }}
                    className="text-[10px] h-5 px-2 nodrag"
                  >
                    Add
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => {
                      setShowSavedSkills(false);
                      if (activePanel === "agent-skills") {
                        setActivePanel(null);
                      }
                    }}
                    className="h-5 w-5 nodrag"
                  >
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              </div>
              <div className="px-2 py-2 text-xs space-y-1">
                {savedSkills.length === 0 && (
                  <div className="text-[var(--foreground-muted)]">No skills saved.</div>
                )}
                {savedSkills.map((skill) => (
                  <div
                    key={skill.id}
                    className="flex items-center justify-between rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1"
                  >
                    <span className="text-[var(--foreground)]">{skill.name}</span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => deleteAgentSkillMutation.mutate(skill.id)}
                      className="h-5 w-5 text-[var(--status-error)] nodrag"
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Saved MCP Tools List */}
          {(showSavedMcp || activePanel === "mcp-tools") && (isClaudeSession || isAgentic) && (
            <div className="rounded border border-[var(--border)] bg-[var(--background-elevated)] shadow-md min-w-80">
              <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--border)]">
                <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--foreground)]">
                  <Wrench className="w-3 h-3" />
                  <span>Saved MCP Tools</span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant={activePanel === "mcp-tools" ? "primary" : "ghost"}
                    size="sm"
                    onClick={() => {
                      setActivePanel(activePanel === "mcp-tools" ? null : "mcp-tools");
                    }}
                    className="text-[10px] h-5 px-2 nodrag"
                  >
                    Add
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => {
                      setShowSavedMcp(false);
                      if (activePanel === "mcp-tools") {
                        setActivePanel(null);
                      }
                    }}
                    className="h-5 w-5 nodrag"
                  >
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              </div>
              <div className="px-2 py-2 text-xs space-y-1">
                {savedMcpTools.length === 0 && (
                  <div className="text-[var(--foreground-muted)]">No MCP tools saved.</div>
                )}
                {savedMcpTools.map((tool) => (
                  <div
                    key={tool.id}
                    className="flex items-center justify-between rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1"
                  >
                    <span className="text-[var(--foreground)]">{tool.name}</span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => deleteMcpToolMutation.mutate(tool.id)}
                      className="h-5 w-5 text-[var(--status-error)] nodrag"
                    >
                      <Trash2 className="w-3 h-3" />
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
                {pendingSecretApply && (
                  <div className="flex items-center justify-between gap-2 rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1">
                    <div className="text-[10px] text-[var(--foreground-muted)]">
                      Saved {pendingSecretApply.name}. {needsRestartForSecrets ? "Restart to apply now?" : "Apply to running terminal?"}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleApplySecretNow}
                        disabled={!canApplySecretsNow}
                        className="h-5 px-2 text-[10px] nodrag"
                      >
                        {needsRestartForSecrets ? `Restart ${terminalName || "terminal"}` : "Apply now"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setPendingSecretApply(null)}
                        className="h-5 w-5 nodrag"
                      >
                        <X className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                )}
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
                        onClick={() => handleDeleteSecret(secret)}
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
            <CatalogPanel
              title="Add subagents"
              activeTab={activeSubagentTab}
              onTabChange={setActiveSubagentTab}
              onClose={() => setActivePanel(null)}
              savedItems={savedSubagents}
              savedLoading={subagentsQuery.isLoading}
              savedEmptyText="No saved subagents yet."
              renderSavedItem={(item) => (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium text-[var(--foreground)]">{item.name}</div>
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
                  {item.description && (
                    <div className="text-[10px] text-[var(--foreground-muted)] mt-1">
                      {item.description}
                    </div>
                  )}
                </>
              )}
              categories={catalog.categories}
              categoryPrefix="subagent"
              expandedCategories={expandedCategories}
              onToggleCategory={toggleCategory}
              renderBrowseItem={(item) => (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium text-[var(--foreground)]">{item.name}</div>
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
                  <div className="text-[10px] text-[var(--foreground-muted)] mt-1">
                    {item.description}
                  </div>
                </>
              )}
            />
          )}

          {/* Agent Skills Panel */}
          {activePanel === "agent-skills" && (
            <CatalogPanel
              title="Add skills"
              activeTab={activeSkillsTab}
              onTabChange={setActiveSkillsTab}
              onClose={() => setActivePanel(null)}
              savedItems={savedSkills}
              savedLoading={agentSkillsQuery.isLoading}
              savedEmptyText="No saved skills yet."
              renderSavedItem={(item) => (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium text-[var(--foreground)]">{item.name}</div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => deleteAgentSkillMutation.mutate(item.id)}
                      className="h-5 w-5 text-[var(--status-error)] nodrag"
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                  {item.description && (
                    <div className="text-[10px] text-[var(--foreground-muted)] mt-1">
                      {item.description}
                    </div>
                  )}
                  <div className="text-[10px] text-[var(--accent-primary)] font-mono mt-1">
                    {item.command}
                  </div>
                </>
              )}
              categories={skillsCatalog.categories}
              categoryPrefix="skill"
              expandedCategories={expandedCategories}
              onToggleCategory={toggleCategory}
              renderBrowseItem={(item) => (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium text-[var(--foreground)]">{item.name}</div>
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
                  <div className="text-[10px] text-[var(--foreground-muted)] mt-1">
                    {item.description}
                  </div>
                  <div className="text-[10px] text-[var(--accent-primary)] font-mono mt-1">
                    {item.command}
                  </div>
                </>
              )}
            />
          )}

          {/* MCP Tools Panel */}
          {activePanel === "mcp-tools" && (
            <CatalogPanel
              title="Add MCP tools"
              activeTab={activeMcpTab}
              onTabChange={setActiveMcpTab}
              onClose={() => setActivePanel(null)}
              savedItems={savedMcpTools}
              savedLoading={mcpToolsQuery.isLoading}
              savedEmptyText="No saved MCP tools yet."
              renderSavedItem={(item) => (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium text-[var(--foreground)]">{item.name}</div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => deleteMcpToolMutation.mutate(item.id)}
                      className="h-5 w-5 text-[var(--status-error)] nodrag"
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                  {item.description && (
                    <div className="text-[10px] text-[var(--foreground-muted)] mt-1">
                      {item.description}
                    </div>
                  )}
                  <div className="text-[10px] text-[var(--accent-primary)] font-mono mt-1">
                    {item.transport}
                  </div>
                </>
              )}
              categories={mcpCatalog.categories}
              categoryPrefix="mcp"
              expandedCategories={expandedCategories}
              onToggleCategory={toggleCategory}
              renderBrowseItem={(item) => (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium text-[var(--foreground)]">{item.name}</div>
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
                  <div className="text-[10px] text-[var(--foreground-muted)] mt-1">
                    {item.description}
                  </div>
                  <div className="text-[10px] text-[var(--accent-primary)] font-mono mt-1">
                    {item.transport}
                  </div>
                </>
              )}
            />
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

      {/* Header - compact, pointer-events: none to allow drag through to ReactFlow node */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--border)] bg-[var(--background)] shrink-0" style={{ pointerEvents: "none" }}>
        <div className="flex items-center gap-1.5" style={{ pointerEvents: "auto" }}>
          {terminalName === "Claude Code" ? (
            <img src="/icons/claude.ico" alt="Claude Code icon" title="Claude Code icon" className="w-4 h-4" />
          ) : terminalName === "Gemini CLI" ? (
            <img src="/icons/gemini.ico" alt="Gemini CLI icon" title="Gemini CLI icon" className="w-4 h-4" />
          ) : terminalName === "Codex" ? (
            <img src="/icons/codex.png" alt="Codex icon" title="Codex icon" className="w-4 h-4" />
          ) : terminalName === "OpenCode" ? (
            <img src="/icons/opencode.ico" alt="OpenCode icon" title="OpenCode icon" className="w-4 h-4" />
          ) : terminalName === "GitHub Copilot CLI" ? (
            <img src="/icons/github.png" alt="GitHub Copilot icon" title="GitHub Copilot icon" className="w-4 h-4" />
          ) : terminalName === "Droid" ? (
            <img src="/icons/droid.png" alt="Droid icon" title="Droid icon" className="w-4 h-4" />
          ) : (
            <span title="Terminal icon">
              <Terminal className="w-4 h-4 text-[var(--foreground-muted)]" />
            </span>
          )}
          <span className="text-[16px] font-medium text-[var(--foreground)]" title={terminalName}>
            {terminalName}
          </span>
        </div>

        <div className="flex items-center gap-1.5" style={{ pointerEvents: "auto" }}>
          {/* Connection status - colored dot + edit/view icon */}
          {session && (
            <span
              title={
                isConnecting
                  ? "Connecting..."
                  : isConnected
                    ? "Connected - you can edit"
                    : isFailed
                      ? "Connection failed"
                      : "Disconnected"
              }
              className="flex items-center gap-1"
            >
              <div
                className={cn(
                  "w-2 h-2 rounded-full",
                  isConnected
                    ? "bg-green-500"
                    : isConnecting
                      ? "bg-yellow-500 animate-pulse"
                      : isFailed
                        ? "bg-red-500"
                        : "bg-gray-400"
                )}
              />
              {isConnected ? (
                <Pencil className="w-3 h-3 text-[var(--foreground-muted)]" />
              ) : (
                <Eye className="w-3 h-3 text-[var(--foreground-muted)]" />
              )}
            </span>
          )}

          {/* Subagents, Skills, MCP Tools buttons - only shown in agentic mode */}
          {(isClaudeSession || isAgentic) && (
            <>
              {/* Subagents button - hidden for Gemini and Codex */}
              {terminalName !== "Gemini CLI" && terminalName !== "Codex" && (
                <button
                  type="button"
                  onClick={() => setShowAttachedList((prev) => !prev)}
                  title={
                    attachedNames.length > 0
                      ? `Subagents: ${attachedNames.join(", ")}`
                      : "No subagents attached - click to manage"
                  }
                  className={cn(
                    "flex items-center gap-0.5 px-1 py-0.5 rounded text-xs nodrag",
                    showAttachedList || activePanel === "subagents"
                      ? "text-[var(--foreground)] bg-[var(--background-hover)]"
                      : "text-[var(--foreground-muted)] hover:bg-[var(--background-hover)]"
                  )}
                >
                  <Bot className="w-3.5 h-3.5" />
                  <span className="text-[10px] font-medium">{attachedNames.length}</span>
                </button>
              )}

              {/* Skills button */}
              <button
                type="button"
                onClick={() => setShowSavedSkills((prev) => !prev)}
                title={
                  savedSkills.length > 0
                    ? `Skills: ${savedSkills.map(s => s.name).join(", ")}`
                    : "No skills saved - click to manage"
                }
                className={cn(
                  "flex items-center gap-0.5 px-1 py-0.5 rounded text-xs nodrag",
                  showSavedSkills || activePanel === "agent-skills"
                    ? "text-[var(--foreground)] bg-[var(--background-hover)]"
                    : "text-[var(--foreground-muted)] hover:bg-[var(--background-hover)]"
                )}
              >
                <Wand2 className="w-3.5 h-3.5" />
                <span className="text-[10px] font-medium">{savedSkills.length}</span>
              </button>

              {/* MCP Tools button */}
              <button
                type="button"
                onClick={() => setShowSavedMcp((prev) => !prev)}
                title={
                  savedMcpTools.length > 0
                    ? `MCP Tools: ${savedMcpTools.map(t => t.name).join(", ")}`
                    : "No MCP tools saved - click to manage"
                }
                className={cn(
                  "flex items-center gap-0.5 px-1 py-0.5 rounded text-xs nodrag",
                  showSavedMcp || activePanel === "mcp-tools"
                    ? "text-[var(--foreground)] bg-[var(--background-hover)]"
                    : "text-[var(--foreground-muted)] hover:bg-[var(--background-hover)]"
                )}
              >
                <Wrench className="w-3.5 h-3.5" />
                <span className="text-[10px] font-medium">{savedMcpTools.length}</span>
              </button>
            </>
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
              title={agentState === "running" ? "Agent is running" : agentState === "paused" ? "Agent is paused" : "Agent stopped"}
            >
              <Bot className="w-2 h-2 mr-0.5" />
              {agentState === "running" ? "Agent" : agentState}
            </Badge>
          )}

          {/* Settings menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant={activePanel !== null ? "primary" : "ghost"}
                size="icon-sm"
                className="h-7 w-7 nodrag"
                style={{ pointerEvents: "auto" }}
                title="Terminal settings"
              >
                <Settings className="w-5 h-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onClick={() => setActivePanel("secrets")} className="gap-2">
                <Key className="w-3 h-3" />
                <span>Secrets</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="gap-2">
                  <span>Theme</span>
                  <span className="ml-auto text-[10px] text-[var(--foreground-muted)] capitalize">
                    {terminalThemeSetting}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={terminalThemeSetting}
                    onValueChange={(value) => handleTerminalThemeChange(value as "system" | "light" | "dark")}
                  >
                    <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              {terminalName !== "Gemini CLI" && terminalName !== "Codex" && (
                <DropdownMenuItem onClick={() => setActivePanel("subagents")} className="gap-2" disabled={!isClaudeSession && !isAgentic}>
                  <Bot className="w-3 h-3" />
                  <span>Subagents</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setActivePanel("agent-skills")} className="gap-2" disabled={!isClaudeSession && !isAgentic}>
                <Wand2 className="w-3 h-3" />
                <span>Skills</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setActivePanel("mcp-tools")} className="gap-2" disabled={!isClaudeSession && !isAgentic}>
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

        {/* Disconnected overlay - show when session exists but connection lost or PTY closed */}
        {session && (isFailed || isDisconnected || ptyClosed) && (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
            <div className="bg-[var(--background-elevated)] px-6 py-4 rounded-lg border border-[var(--border)] flex flex-col items-center gap-3">
              <AlertCircle className="w-8 h-8 text-[var(--foreground-muted)]" />
              <span className="text-sm text-[var(--foreground)]">
                Session ended
              </span>
              {isOwner && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleReopen}
                    isLoading={isCreatingSession}
                    leftIcon={<RefreshCw className="w-4 h-4" />}
                    style={{ pointerEvents: "auto" }}
                  >
                    Reopen
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={handleDeleteBlock}
                    leftIcon={<Trash2 className="w-4 h-4" />}
                    style={{ pointerEvents: "auto" }}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </div>
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
