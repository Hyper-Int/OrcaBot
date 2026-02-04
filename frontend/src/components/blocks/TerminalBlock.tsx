// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: reconnect-liveness-v2-auto-restart-on-fail

"use client";

const TERMINAL_BLOCK_REVISION = "reconnect-liveness-v2-auto-restart-on-fail";
console.log(`[TerminalBlock] REVISION: ${TERMINAL_BLOCK_REVISION} loaded at ${new Date().toISOString()}`);

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
  Minimize2,
  Shield,
  ShieldOff,
  Copy,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { BlockWrapper } from "./BlockWrapper";
import { MinimizedBlockView, MINIMIZED_SIZE } from "./MinimizedBlockView";
import {
  Button,
  Badge,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { useTerminalAudio } from "@/hooks/useTerminalAudio";
import { useAuthStore } from "@/stores/auth-store";
import { useThemeStore } from "@/stores/theme-store";
import { attachSessionResources, createSession, stopSession, updateSessionEnv, applySessionSecrets } from "@/lib/api/cloudflare";
import {
  createSubagent,
  deleteSubagent,
  listSubagents,
  type UserSubagent,
  createSecret,
  createEnvVar,
  deleteSecret,
  listSecrets,
  updateSecretProtection,
  listPendingApprovals,
  approveSecretDomain,
  dismissPendingApproval,
  type UserSecret,
  type PendingApproval,
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
import { useConnectionDataFlow } from "@/contexts/ConnectionDataFlowContext";
import { IntegrationsPanel } from "./IntegrationsPanel";
import type { IntegrationProvider, SecurityLevel } from "@/lib/api/cloudflare/integration-policies";

interface TerminalData extends Record<string, unknown> {
  content: string; // Session ID or terminal name
  size: { width: number; height: number };
  dashboardId: string;
  itemId: string; // Actual database item ID (different from React Flow node ID when using _stableKey)
  metadata?: { minimized?: boolean; [key: string]: unknown };
  // Session info (can be injected from parent or fetched)
  session?: Session;
  onRegisterTerminal?: (itemId: string, handle: TerminalHandle | null) => void;
  onItemChange?: (changes: Partial<{ content: string; metadata?: Record<string, unknown>; size?: { width: number; height: number } }>) => void;
  onCreateBrowserBlock?: (
    url: string,
    anchor?: { x: number; y: number },
    sourceId?: string
  ) => void;
  connectorMode?: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
  /** Called when integration policy is updated, for syncing edge data */
  onPolicyUpdate?: (provider: IntegrationProvider, securityLevel: SecurityLevel) => void;
  /** Called after attaching integration, to create integration block on canvas if needed */
  onIntegrationAttached?: (provider: IntegrationProvider, securityLevel: SecurityLevel) => void;
  /** Called after detaching integration, to remove integration block + edge from canvas */
  onIntegrationDetached?: (provider: IntegrationProvider) => void;
  onDuplicate?: () => void;
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
  sourceUrl?: string;
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

type ActivePanel = "secrets" | "subagents" | "agent-skills" | "mcp-tools" | "tts-voice" | "integrations" | null;

type TerminalContentState = {
  name: string;
  subagentIds: string[];
  skillIds: string[];
  mcpToolIds: string[];
  agentic?: boolean;
  bootCommand?: string;
  terminalTheme?: "system" | "light" | "dark";
  terminalFontSize?: "auto" | "small" | "medium" | "large" | "xlarge";
  ttsProvider?: string;
  ttsVoice?: string;
};

// Font size presets - "auto" means dynamic resizing based on terminal width
const FONT_SIZE_PRESETS = {
  auto: { label: "Auto", size: 12 },
  small: { label: "Small", size: 10 },
  medium: { label: "Medium", size: 12 },
  large: { label: "Large", size: 14 },
  xlarge: { label: "Extra Large", size: 16 },
} as const;

type FontSizeSetting = keyof typeof FONT_SIZE_PRESETS;

// TTS provider configurations
const TTS_PROVIDERS: Record<string, { label: string; envKey: string | null; voices: string[] }> = {
  none: { label: "None", envKey: null, voices: [] },
  openai: {
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    voices: ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse"],
  },
  elevenlabs: {
    label: "ElevenLabs",
    envKey: "ELEVENLABS_API_KEY",
    voices: ["Rachel", "Domi", "Bella", "Antoni", "Elli", "Josh", "Arnold", "Adam", "Sam"],
  },
  deepgram: {
    label: "Deepgram",
    envKey: "DEEPGRAM_API_KEY",
    voices: ["asteria", "luna", "stella", "athena", "hera", "orion", "arcas", "perseus", "angus", "orpheus"],
  },
  azure: {
    label: "Azure",
    envKey: "AZURE_SPEECH_KEY",
    voices: ["en-US-AriaNeural", "en-US-GuyNeural", "en-US-JennyNeural", "en-GB-LibbyNeural", "en-GB-RyanNeural"],
  },
  gcloud: {
    label: "Google Cloud",
    envKey: "GOOGLE_APPLICATION_CREDENTIALS",
    voices: ["en-US-Standard-A", "en-US-Standard-B", "en-US-Standard-C", "en-US-Standard-D", "en-US-Wavenet-A", "en-US-Wavenet-B"],
  },
  aws: {
    label: "AWS Polly",
    envKey: "AWS_ACCESS_KEY_ID",
    voices: ["Joanna", "Matthew", "Ivy", "Kendra", "Kimberly", "Salli", "Joey", "Justin", "Amy", "Brian", "Emma"],
  },
};

type SessionAttachmentSpec = {
  name: string;
  sourceUrl?: string;
  content?: string;
};

type McpToolAttachmentSpec = {
  name: string;
  serverUrl: string;
  transport: string;
  config?: Record<string, unknown>;
};

// Virtual OrcaBot MCP tool - built into the sandbox via mcp-bridge
const ORCABOT_TOOL_ID = "orcabot-builtin";
const ORCABOT_TOOL: McpToolAttachmentSpec = {
  name: "OrcaBot",
  serverUrl: "builtin://mcp-bridge",
  transport: "stdio",
};

// Virtual OrcaBot entry for the saved tools list
const ORCABOT_SAVED_TOOL: UserMcpTool = {
  id: ORCABOT_TOOL_ID,
  name: "OrcaBot",
  description: "Built-in MCP server providing dashboard tools and integrations",
  serverUrl: "builtin://mcp-bridge",
  transport: "stdio",
  source: "builtin",
  createdAt: "",
  updatedAt: "",
};

type SessionAttachmentRequest = {
  terminalType: string;
  attach?: {
    agents?: SessionAttachmentSpec[];
    skills?: SessionAttachmentSpec[];
  };
  detach?: {
    agents?: string[];
    skills?: string[];
  };
  mcpTools?: McpToolAttachmentSpec[];
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
  // Default mcpToolIds includes OrcaBot (built-in)
  const defaultMcpToolIds = [ORCABOT_TOOL_ID];

  if (content) {
    try {
      const parsed = JSON.parse(content) as Partial<TerminalContentState & { subagents?: string[]; skills?: string[] }>;
      const name = typeof parsed.name === "string" ? parsed.name : content;
      const subagentIds = Array.isArray(parsed.subagentIds)
        ? parsed.subagentIds
        : Array.isArray(parsed.subagents)
          ? parsed.subagents
          : [];
      const skillIds = Array.isArray(parsed.skillIds)
        ? parsed.skillIds
        : Array.isArray(parsed.skills)
          ? parsed.skills
          : [];
      // If mcpToolIds is explicitly set (even empty), use it; otherwise default to OrcaBot
      const mcpToolIds = Array.isArray(parsed.mcpToolIds) ? parsed.mcpToolIds : defaultMcpToolIds;
      return {
        name,
        subagentIds,
        skillIds,
        mcpToolIds,
        agentic: parsed.agentic,
        bootCommand: parsed.bootCommand,
        terminalTheme: parsed.terminalTheme,
        terminalFontSize: parsed.terminalFontSize,
        ttsProvider: parsed.ttsProvider,
        ttsVoice: parsed.ttsVoice,
      };
    } catch {
      return { name: content, subagentIds: [], skillIds: [], mcpToolIds: defaultMcpToolIds };
    }
  }
  return { name: "Terminal", subagentIds: [], skillIds: [], mcpToolIds: defaultMcpToolIds };
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
  const minFontSize = 8;
  const maxFontSize = 18;
  const minCols = 90;
  const growColsBuffer = 0;
  const shrinkColsBuffer = 0;
  const fontCooldownMs = 600;
  const overlay = useTerminalOverlay();
  const terminalRef = React.useRef<TerminalHandle>(null);
  const fitTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFontChangeRef = React.useRef(0);
  const terminalMeta = React.useMemo(
    () => parseTerminalContent(data.content),
    [data.content]
  );
  const fontSizeSetting = terminalMeta.terminalFontSize ?? "auto";
  const isAutoFontSize = fontSizeSetting === "auto";
  const baseFontSize: number = FONT_SIZE_PRESETS[fontSizeSetting].size;
  const [fontSize, setFontSize] = React.useState<number>(baseFontSize);
  const stableFontRef = React.useRef<number>(baseFontSize);

  // Update font size when setting changes
  React.useEffect(() => {
    setFontSize(baseFontSize);
    stableFontRef.current = baseFontSize;
    lastFontChangeRef.current = Date.now();
  }, [baseFontSize]);
  const terminalName = terminalMeta.name;
  const terminalType = React.useMemo(() => {
    const command = (terminalMeta.bootCommand || "").toLowerCase();
    if (command.includes("claude")) return "claude";
    if (command.includes("gemini")) return "gemini";
    if (command.includes("codex")) return "codex";
    if (command.includes("opencode")) return "opencode";
    if (command.includes("copilot")) return "copilot";
    if (command.includes("droid")) return "droid";
    if (command.includes("openclaw") || command.includes("moltbot")) return "moltbot";
    const name = terminalName.toLowerCase();
    if (name.includes("claude")) return "claude";
    if (name.includes("gemini")) return "gemini";
    if (name.includes("codex")) return "codex";
    if (name.includes("opencode")) return "opencode";
    if (name.includes("copilot")) return "copilot";
    if (name.includes("droid")) return "droid";
    if (name.includes("openclaw") || name.includes("moltbot")) return "moltbot";
    return "shell";
  }, [terminalMeta.bootCommand, terminalName]);
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
  const [newEnvVarName, setNewEnvVarName] = React.useState("");
  const [newEnvVarValue, setNewEnvVarValue] = React.useState("");
  const [secretsSectionExpanded, setSecretsSectionExpanded] = React.useState(true);
  const [envVarsSectionExpanded, setEnvVarsSectionExpanded] = React.useState(true);
  const secretValueInputRef = React.useRef<HTMLInputElement>(null);
  const [pendingSecretApply, setPendingSecretApply] = React.useState<{ name: string; value: string } | null>(null);
  // Track if MCP tools, skills, or agents have changed since session started
  const [pendingConfigRestart, setPendingConfigRestart] = React.useState(false);
  const onRegisterTerminal = data.onRegisterTerminal;
  const connectorsVisible = selected || Boolean(data.connectorMode);
  const isMinimized = data.metadata?.minimized === true;
  const [expandAnimation, setExpandAnimation] = React.useState<string | null>(null);
  const [isAnimatingMinimize, setIsAnimatingMinimize] = React.useState(false);
  const minimizeTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (minimizeTimeoutRef.current) clearTimeout(minimizeTimeoutRef.current);
    };
  }, []);

  // Auto-dismiss the env apply hint after 10 seconds
  React.useEffect(() => {
    if (!pendingSecretApply) return;
    const timer = setTimeout(() => {
      setPendingSecretApply(null);
    }, 10000);
    return () => clearTimeout(timer);
  }, [pendingSecretApply]);

  const handleMinimize = React.useCallback(() => {
    const expandedSize = data.size;
    setIsAnimatingMinimize(true);
    data.onItemChange?.({
      metadata: { ...data.metadata, expandedSize },
      size: MINIMIZED_SIZE,
    });
    minimizeTimeoutRef.current = setTimeout(() => {
      setIsAnimatingMinimize(false);
      data.onItemChange?.({
        metadata: { ...data.metadata, minimized: true, expandedSize },
      });
    }, 350);
  }, [data]);

  const handleExpand = React.useCallback(() => {
    const savedSize = data.metadata?.expandedSize as { width: number; height: number } | undefined;
    setExpandAnimation("animate-expand-bounce");
    setTimeout(() => setExpandAnimation(null), 300);
    data.onItemChange?.({
      metadata: { ...data.metadata, minimized: false },
      size: savedSize || { width: 700, height: 500 },
    });
  }, [data]);

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
  const isOwner = !!session && user?.id === session.ownerUserId;
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
  const catalog = subagentCatalog as { categories: SubagentCatalogCategory[]; source?: string };
  const skillsCatalog = agentSkillsCatalog as { categories: AgentSkillCatalogCategory[] };
  const subagentSourceByName = React.useMemo(() => {
    const map = new Map<string, string>();
    catalog.categories.forEach((category) => {
      category.items.forEach((item) => {
        if (item.sourcePath) {
          map.set(item.name, item.sourcePath);
        }
      });
    });
    return map;
  }, [catalog.categories]);
  const skillSourceByName = React.useMemo(() => {
    const map = new Map<string, string>();
    skillsCatalog.categories.forEach((category) => {
      category.items.forEach((item) => {
        if (item.sourceUrl) {
          map.set(item.name, item.sourceUrl);
        }
      });
    });
    return map;
  }, [skillsCatalog.categories]);

  const buildGithubRawUrl = React.useCallback((repoUrl: string, sourcePath: string) => {
    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) return null;
    const owner = match[1];
    const repo = match[2].replace(/\.git$/, "");
    return `https://raw.githubusercontent.com/${owner}/${repo}/refs/heads/main/${sourcePath}`;
  }, []);
  const mcpCatalog = mcpToolsCatalog as { categories: McpToolCatalogCategory[] };

  React.useEffect(() => {
    createdBrowserUrlsRef.current.clear();
    outputBufferRef.current = "";
    setIsClaudeSession(false);
    setActivePanel(null);
    autoControlRequestedRef.current = false;
    // Reset pending config restart when session changes (new session picks up current config)
    setPendingConfigRestart(false);
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

  const createEnvVarMutation = useMutation({
    mutationFn: createEnvVar,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["secrets", data.dashboardId] });
      setNewEnvVarName("");
      setNewEnvVarValue("");
    },
  });

  const deleteSecretMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => deleteSecret(id, data.dashboardId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["secrets", data.dashboardId] });
    },
  });

  const updateProtectionMutation = useMutation({
    mutationFn: ({ id, brokerProtected }: { id: string; brokerProtected: boolean }) =>
      updateSecretProtection(id, data.dashboardId, brokerProtected),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["secrets", data.dashboardId] });
    },
  });

  // State for disable protection dialog
  const [secretToDisableProtection, setSecretToDisableProtection] = React.useState<UserSecret | null>(null);

  // Pending domain approvals query (primary updates via WebSocket push, long poll as fallback)
  const pendingApprovalsQuery = useQuery({
    queryKey: ["pending-approvals", data.dashboardId],
    queryFn: () => listPendingApprovals(data.dashboardId),
    enabled: activePanel === "secrets",
    refetchInterval: 300000, // 5 min fallback (primary updates via WebSocket push)
    staleTime: 60000,
  });

  // State for domain approval dialog
  const [approvalToShow, setApprovalToShow] = React.useState<PendingApproval | null>(null);
  const [approvalHeaderName, setApprovalHeaderName] = React.useState("Authorization");
  const [approvalHeaderFormat, setApprovalHeaderFormat] = React.useState("Bearer %s");

  // Approve domain mutation
  const approveDomainMutation = useMutation({
    mutationFn: ({ secretId, domain, headerName, headerFormat }: {
      secretId: string;
      domain: string;
      headerName: string;
      headerFormat: string;
    }) => approveSecretDomain(secretId, data.dashboardId, { domain, headerName, headerFormat }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["pending-approvals", data.dashboardId] });
      setApprovalToShow(null);
      toast.success(`Domain approved: ${variables.domain}`, {
        description: "Future requests to this domain will now succeed. Retry your previous request.",
      });
    },
  });

  // Dismiss approval mutation
  const dismissApprovalMutation = useMutation({
    mutationFn: (approvalId: string) => dismissPendingApproval(approvalId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pending-approvals", data.dashboardId] });
      setApprovalToShow(null);
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
  const savedSkillById = React.useMemo(() => {
    const map = new Map<string, UserAgentSkill>();
    savedSkills.forEach((item) => map.set(item.id, item));
    return map;
  }, [savedSkills]);

  // MCP Tools computed values - include virtual OrcaBot at the start
  const savedMcpTools = React.useMemo(
    () => [ORCABOT_SAVED_TOOL, ...(mcpToolsQuery.data || [])],
    [mcpToolsQuery.data]
  );
  const savedMcpNames = React.useMemo(
    () => new Set(savedMcpTools.map((item) => item.name)),
    [savedMcpTools]
  );
  const savedMcpByName = React.useMemo(() => {
    const map = new Map<string, UserMcpTool>();
    savedMcpTools.forEach((item) => map.set(item.name, item));
    return map;
  }, [savedMcpTools]);
  const savedMcpById = React.useMemo(() => {
    const map = new Map<string, UserMcpTool>();
    savedMcpTools.forEach((item) => map.set(item.id, item));
    return map;
  }, [savedMcpTools]);

  // Secrets computed values
  const allSecrets = secretsQuery.data || [];
  // Split into secrets (brokered) and env vars (non-brokered)
  const savedSecrets = allSecrets.filter(s => s.type === 'secret' || !s.type); // Default to secret for backwards compat
  const savedEnvVars = allSecrets.filter(s => s.type === 'env_var');

  // Helper to detect secret-like names for warning
  const looksLikeSecret = (name: string): boolean => {
    const patterns = ['_KEY', '_TOKEN', '_SECRET', 'API_KEY', 'ACCESS_KEY', 'PASSWORD', 'CREDENTIAL', 'AUTH_'];
    return patterns.some(pattern => name.toUpperCase().includes(pattern));
  };

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
          skillIds: terminalMeta.skillIds,
          mcpToolIds: terminalMeta.mcpToolIds,
          agentic: terminalMeta.agentic,
          bootCommand: terminalMeta.bootCommand,
          terminalTheme: terminalMeta.terminalTheme,
          terminalFontSize: terminalMeta.terminalFontSize,
          ttsProvider: terminalMeta.ttsProvider,
          ttsVoice: terminalMeta.ttsVoice,
        }),
      });
      // Mark that config changed - restart needed to apply
      if (session?.id) {
        setPendingConfigRestart(true);
      }
    },
    [data, terminalMeta, session?.id]
  );

  const buildAgentAttachmentSpec = React.useCallback((item: UserSubagent): SessionAttachmentSpec => {
    const sourcePath = subagentSourceByName.get(item.name);
    if (sourcePath && catalog.source) {
      const sourceUrl = buildGithubRawUrl(catalog.source, sourcePath);
      if (sourceUrl) {
        return { name: item.name, sourceUrl };
      }
    }
    const tools = item.tools && item.tools.length > 0 ? `\ntools: ${item.tools.join(", ")}` : "";
    const description = item.description ? `\ndescription: ${item.description}` : "";
    const content = `---\nname: ${item.name}${description}${tools}\n---\n\n${item.prompt || ""}\n`;
    return { name: item.name, content };
  }, [buildGithubRawUrl, catalog.source, subagentSourceByName]);

  const buildSkillAttachmentSpec = React.useCallback((item: UserAgentSkill): SessionAttachmentSpec => {
    if (item.source === "catalog") {
      const sourceUrl = skillSourceByName.get(item.name);
      if (sourceUrl) {
        return { name: item.name, sourceUrl };
      }
    }
    const args = item.args && item.args.length > 0 ? ` ${item.args.join(" ")}` : "";
    const description = item.description ? item.description : "No description provided.";
    const content = `# ${item.name}\n\n${description}\n\nCommand: ${item.command}${args}\n`;
    return { name: item.name, content };
  }, [skillSourceByName]);

  const buildSkillAttachmentFromCatalog = React.useCallback((item: AgentSkillCatalogItem): SessionAttachmentSpec => {
    if (item.sourceUrl) {
      return { name: item.name, sourceUrl: item.sourceUrl };
    }
    const args = item.args && item.args.length > 0 ? ` ${item.args.join(" ")}` : "";
    const description = item.description ? item.description : "No description provided.";
    const content = `# ${item.name}\n\n${description}\n\nCommand: ${item.command}${args}\n`;
    return { name: item.name, content };
  }, []);

  const syncSessionAttachments = React.useCallback(
    async (payload: SessionAttachmentRequest) => {
      if (!session?.id || !isOwner) return;
      if (payload.terminalType === "shell") return;
      try {
        await attachSessionResources(session.id, payload);
      } catch (error) {
        console.error("[TerminalBlock] Failed to sync attachments:", error);
      }
    },
    [isOwner, session?.id]
  );

  const handleDetachSubagent = React.useCallback(
    (subagentId: string) => {
      if (!data.onItemChange) return;
      const nextIds = terminalMeta.subagentIds.filter((id) => id !== subagentId);
      const subagentName = savedById.get(subagentId)?.name;
      data.onItemChange({
        content: JSON.stringify({
          name: terminalMeta.name,
          subagentIds: nextIds,
          skillIds: terminalMeta.skillIds,
          mcpToolIds: terminalMeta.mcpToolIds,
          agentic: terminalMeta.agentic,
          bootCommand: terminalMeta.bootCommand,
          terminalTheme: terminalMeta.terminalTheme,
          terminalFontSize: terminalMeta.terminalFontSize,
          ttsProvider: terminalMeta.ttsProvider,
          ttsVoice: terminalMeta.ttsVoice,
        }),
      });
      if (subagentName) {
        syncSessionAttachments({
          terminalType,
          detach: { agents: [subagentName] },
        });
      }
      // Mark that config changed - restart needed to apply
      if (session?.id) {
        setPendingConfigRestart(true);
      }
    },
    [data, savedById, syncSessionAttachments, terminalMeta, terminalType, session?.id]
  );

  const handleUseSavedSubagent = React.useCallback(
    (item: UserSubagent) => {
      handleAttachSubagent(item.id);
      syncSessionAttachments({
        terminalType,
        attach: { agents: [buildAgentAttachmentSpec(item)] },
      });
    },
    [buildAgentAttachmentSpec, handleAttachSubagent, syncSessionAttachments, terminalType]
  );

  const handleUseBrowseSubagent = React.useCallback(
    async (item: SubagentCatalogItem) => {
      const existing = savedByName.get(item.name);
      if (existing) {
        handleAttachSubagent(existing.id);
        syncSessionAttachments({
          terminalType,
          attach: { agents: [buildAgentAttachmentSpec(existing)] },
        });
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
      syncSessionAttachments({
        terminalType,
        attach: { agents: [buildAgentAttachmentSpec(created)] },
      });
    },
    [buildAgentAttachmentSpec, createSubagentMutation, handleAttachSubagent, savedByName, syncSessionAttachments, terminalType]
  );

  const handleTerminalThemeChange = React.useCallback(
    (nextTheme: "system" | "light" | "dark") => {
      if (!data.onItemChange) return;
      data.onItemChange({
        content: JSON.stringify({
          name: terminalMeta.name,
          subagentIds: terminalMeta.subagentIds,
          skillIds: terminalMeta.skillIds,
          mcpToolIds: terminalMeta.mcpToolIds,
          agentic: terminalMeta.agentic,
          bootCommand: terminalMeta.bootCommand,
          terminalTheme: nextTheme,
          terminalFontSize: terminalMeta.terminalFontSize,
          ttsProvider: terminalMeta.ttsProvider,
          ttsVoice: terminalMeta.ttsVoice,
        }),
      });
    },
    [data, terminalMeta]
  );

  const handleFontSizeChange = React.useCallback(
    (nextSize: FontSizeSetting) => {
      if (!data.onItemChange) return;
      data.onItemChange({
        content: JSON.stringify({
          name: terminalMeta.name,
          subagentIds: terminalMeta.subagentIds,
          skillIds: terminalMeta.skillIds,
          mcpToolIds: terminalMeta.mcpToolIds,
          agentic: terminalMeta.agentic,
          bootCommand: terminalMeta.bootCommand,
          terminalTheme: terminalMeta.terminalTheme,
          terminalFontSize: nextSize,
          ttsProvider: terminalMeta.ttsProvider,
          ttsVoice: terminalMeta.ttsVoice,
        }),
      });
    },
    [data, terminalMeta]
  );

  const handleTtsChange = React.useCallback(
    (provider: string, voice: string) => {
      if (!data.onItemChange) return;
      const newProvider = provider === "none" ? undefined : provider;
      const newVoice = provider === "none" ? undefined : voice;

      // Only trigger restart bar if TTS settings actually changed
      const providerChanged = terminalMeta.ttsProvider !== newProvider;
      const voiceChanged = terminalMeta.ttsVoice !== newVoice;

      if (providerChanged || voiceChanged) {
        setPendingConfigRestart(true);
      }

      data.onItemChange({
        content: JSON.stringify({
          name: terminalMeta.name,
          subagentIds: terminalMeta.subagentIds,
          skillIds: terminalMeta.skillIds,
          mcpToolIds: terminalMeta.mcpToolIds,
          agentic: terminalMeta.agentic,
          bootCommand: terminalMeta.bootCommand,
          terminalTheme: terminalMeta.terminalTheme,
          terminalFontSize: terminalMeta.terminalFontSize,
          ttsProvider: newProvider,
          ttsVoice: newVoice,
        }),
      });
    },
    [data, terminalMeta]
  );

  const attachedNames = React.useMemo(() => {
    return terminalMeta.subagentIds.map((id) => savedById.get(id)?.name || "Unknown");
  }, [terminalMeta.subagentIds, savedById]);

  const attachedSkillNames = React.useMemo(() => {
    return terminalMeta.skillIds.map((id) => savedSkillById.get(id)?.name || "Unknown");
  }, [terminalMeta.skillIds, savedSkillById]);

  const attachedMcpToolNames = React.useMemo(() => {
    return terminalMeta.mcpToolIds.map((id) => savedMcpById.get(id)?.name || "Unknown");
  }, [terminalMeta.mcpToolIds, savedMcpById]);

  const buildMcpToolsPayload = React.useCallback((toolIds?: string[]): McpToolAttachmentSpec[] => {
    const ids = toolIds ?? terminalMeta.mcpToolIds;
    return ids
      .map((id) => savedMcpById.get(id))
      .filter((tool): tool is UserMcpTool => tool !== undefined)
      .map((tool) => ({
        name: tool.name,
        serverUrl: tool.serverUrl,
        transport: tool.transport,
        config: tool.config,
      }));
  }, [terminalMeta.mcpToolIds, savedMcpById]);

  const syncSignatureRef = React.useRef<string>("");
  const syncAllAttachments = React.useCallback(() => {
    if (!session?.id || !isOwner) return;
    if (subagentsQuery.isLoading || agentSkillsQuery.isLoading || mcpToolsQuery.isLoading) return;
    if (terminalType === "shell") return;

    const attachedAgents: SessionAttachmentSpec[] = terminalMeta.subagentIds
      .map((id) => savedById.get(id))
      .filter(Boolean)
      .map((item) => buildAgentAttachmentSpec(item as UserSubagent));
    const attachedSkills: SessionAttachmentSpec[] = terminalMeta.skillIds
      .map((id) => savedSkillById.get(id))
      .filter(Boolean)
      .map((item) => buildSkillAttachmentSpec(item as UserAgentSkill));
    const attachedMcp = buildMcpToolsPayload();

    if (attachedAgents.length === 0 && attachedSkills.length === 0 && attachedMcp.length === 0) return;
    syncSessionAttachments({
      terminalType,
      attach: {
        agents: attachedAgents.length > 0 ? attachedAgents : undefined,
        skills: attachedSkills.length > 0 ? attachedSkills : undefined,
      },
      mcpTools: attachedMcp.length > 0 ? attachedMcp : undefined,
    });
  }, [
    agentSkillsQuery.isLoading,
    buildAgentAttachmentSpec,
    buildMcpToolsPayload,
    buildSkillAttachmentSpec,
    isOwner,
    mcpToolsQuery.isLoading,
    savedById,
    savedSkillById,
    session?.id,
    subagentsQuery.isLoading,
    syncSessionAttachments,
    terminalMeta.mcpToolIds,
    terminalMeta.skillIds,
    terminalMeta.subagentIds,
    terminalType,
  ]);

  React.useEffect(() => {
    if (!session?.id || !isOwner) return;
    const signature = [
      session.id,
      terminalType,
      terminalMeta.subagentIds.join(","),
      terminalMeta.skillIds.join(","),
      terminalMeta.mcpToolIds.join(","),
    ].join("|");
    if (signature === syncSignatureRef.current) return;
    syncSignatureRef.current = signature;
    syncAllAttachments();
  }, [
    isOwner,
    session?.id,
    syncAllAttachments,
    terminalMeta.mcpToolIds,
    terminalMeta.skillIds,
    terminalMeta.subagentIds,
    terminalType,
  ]);

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

  const handleAttachSkill = React.useCallback(
    (skillId: string) => {
      if (!data.onItemChange) return;
      if (terminalMeta.skillIds.includes(skillId)) return;
      const nextIds = [...terminalMeta.skillIds, skillId];
      data.onItemChange({
        content: JSON.stringify({
          name: terminalMeta.name,
          subagentIds: terminalMeta.subagentIds,
          skillIds: nextIds,
          mcpToolIds: terminalMeta.mcpToolIds,
          agentic: terminalMeta.agentic,
          bootCommand: terminalMeta.bootCommand,
          terminalTheme: terminalMeta.terminalTheme,
          terminalFontSize: terminalMeta.terminalFontSize,
          ttsProvider: terminalMeta.ttsProvider,
          ttsVoice: terminalMeta.ttsVoice,
        }),
      });
      // Mark that config changed - restart needed to apply
      if (session?.id) {
        setPendingConfigRestart(true);
      }
    },
    [data, terminalMeta, session?.id]
  );

  const handleDetachSkill = React.useCallback(
    (skillId: string) => {
      if (!data.onItemChange) return;
      const nextIds = terminalMeta.skillIds.filter((id) => id !== skillId);
      const skillName = savedSkillById.get(skillId)?.name;
      data.onItemChange({
        content: JSON.stringify({
          name: terminalMeta.name,
          subagentIds: terminalMeta.subagentIds,
          skillIds: nextIds,
          mcpToolIds: terminalMeta.mcpToolIds,
          agentic: terminalMeta.agentic,
          bootCommand: terminalMeta.bootCommand,
          terminalTheme: terminalMeta.terminalTheme,
          terminalFontSize: terminalMeta.terminalFontSize,
          ttsProvider: terminalMeta.ttsProvider,
          ttsVoice: terminalMeta.ttsVoice,
        }),
      });
      if (skillName) {
        syncSessionAttachments({
          terminalType,
          detach: { skills: [skillName] },
        });
      }
      // Mark that config changed - restart needed to apply
      if (session?.id) {
        setPendingConfigRestart(true);
      }
    },
    [data, savedSkillById, syncSessionAttachments, terminalMeta, terminalType, session?.id]
  );

  const handleUseSavedSkill = React.useCallback(
    (item: UserAgentSkill) => {
      handleAttachSkill(item.id);
      syncSessionAttachments({
        terminalType,
        attach: { skills: [buildSkillAttachmentSpec(item)] },
      });
    },
    [buildSkillAttachmentSpec, handleAttachSkill, syncSessionAttachments, terminalType]
  );

  const handleUseBrowseSkill = React.useCallback(
    async (item: AgentSkillCatalogItem) => {
      const existing = savedSkillByName.get(item.name);
      if (existing) {
        handleAttachSkill(existing.id);
        syncSessionAttachments({
          terminalType,
          attach: { skills: [buildSkillAttachmentSpec(existing)] },
        });
        return;
      }
      const created = await createAgentSkillMutation.mutateAsync({
        name: item.name,
        description: item.description,
        command: item.command,
        args: item.args || [],
        source: "catalog",
      });
      handleAttachSkill(created.id);
      syncSessionAttachments({
        terminalType,
        attach: { skills: [buildSkillAttachmentFromCatalog(item)] },
      });
    },
    [buildSkillAttachmentFromCatalog, buildSkillAttachmentSpec, createAgentSkillMutation, handleAttachSkill, savedSkillByName, syncSessionAttachments, terminalType]
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

  const handleAttachMcpTool = React.useCallback(
    (toolId: string) => {
      if (!data.onItemChange) return;
      if (terminalMeta.mcpToolIds.includes(toolId)) return;
      const nextIds = [...terminalMeta.mcpToolIds, toolId];
      data.onItemChange({
        content: JSON.stringify({
          name: terminalMeta.name,
          subagentIds: terminalMeta.subagentIds,
          skillIds: terminalMeta.skillIds,
          mcpToolIds: nextIds,
          agentic: terminalMeta.agentic,
          bootCommand: terminalMeta.bootCommand,
          terminalTheme: terminalMeta.terminalTheme,
          terminalFontSize: terminalMeta.terminalFontSize,
          ttsProvider: terminalMeta.ttsProvider,
          ttsVoice: terminalMeta.ttsVoice,
        }),
      });
      // Mark that config changed - restart needed to apply
      if (session?.id) {
        setPendingConfigRestart(true);
      }
    },
    [data, terminalMeta, session?.id]
  );

  const handleDetachMcpTool = React.useCallback(
    (toolId: string) => {
      if (!data.onItemChange) return;
      const nextIds = terminalMeta.mcpToolIds.filter((id) => id !== toolId);
      data.onItemChange({
        content: JSON.stringify({
          name: terminalMeta.name,
          subagentIds: terminalMeta.subagentIds,
          skillIds: terminalMeta.skillIds,
          mcpToolIds: nextIds,
          agentic: terminalMeta.agentic,
          bootCommand: terminalMeta.bootCommand,
          terminalTheme: terminalMeta.terminalTheme,
          terminalFontSize: terminalMeta.terminalFontSize,
          ttsProvider: terminalMeta.ttsProvider,
          ttsVoice: terminalMeta.ttsVoice,
        }),
      });
      syncSessionAttachments({
        terminalType,
        mcpTools: buildMcpToolsPayload(nextIds),
      });
      // Mark that config changed - restart needed to apply
      if (session?.id) {
        setPendingConfigRestart(true);
      }
    },
    [buildMcpToolsPayload, data, syncSessionAttachments, terminalMeta, terminalType, session?.id]
  );

  const handleUseSavedMcpTool = React.useCallback(
    (item: UserMcpTool) => {
      handleAttachMcpTool(item.id);
      const nextIds = [...terminalMeta.mcpToolIds, item.id];
      syncSessionAttachments({
        terminalType,
        mcpTools: buildMcpToolsPayload(nextIds),
      });
    },
    [buildMcpToolsPayload, handleAttachMcpTool, syncSessionAttachments, terminalMeta.mcpToolIds, terminalType]
  );

  const handleUseBrowseMcpTool = React.useCallback(
    async (item: McpToolCatalogItem) => {
      const existing = savedMcpByName.get(item.name);
      if (existing) {
        handleAttachMcpTool(existing.id);
        const nextIds = [...terminalMeta.mcpToolIds, existing.id];
        syncSessionAttachments({
          terminalType,
          mcpTools: buildMcpToolsPayload(nextIds),
        });
        return;
      }
      const created = await createMcpToolMutation.mutateAsync({
        name: item.name,
        description: item.description,
        serverUrl: item.serverUrl,
        transport: item.transport,
        config: item.config,
        source: "catalog",
      });
      handleAttachMcpTool(created.id);
      const nextIds = [...terminalMeta.mcpToolIds, created.id];
      // Build payload from nextIds; if created tool isn't in savedMcpById yet (no optimistic update), append it
      const payload = buildMcpToolsPayload(nextIds);
      const alreadyIncluded = payload.some((t) => t.name === created.name);
      if (!alreadyIncluded) {
        payload.push({
          name: created.name,
          serverUrl: created.serverUrl,
          transport: created.transport,
          config: created.config,
        });
      }
      syncSessionAttachments({
        terminalType,
        mcpTools: payload,
      });
    },
    [buildMcpToolsPayload, createMcpToolMutation, handleAttachMcpTool, savedMcpByName, syncSessionAttachments, terminalMeta.mcpToolIds, terminalType]
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
      // Use data.itemId (actual database ID) instead of id (React Flow node ID)
      // because id may be a temp ID like "temp-xxx" when using optimistic updates
      data.onCreateBrowserBlock?.(url, {
        x: positionAbsoluteX + (width ?? data.size.width) + 24,
        y: positionAbsoluteY + 24,
      }, data.itemId);
    },
    [data, positionAbsoluteX, positionAbsoluteY, width]
  );

  // Use terminal audio hook for TTS playback
  const { handleAudioEvent } = useTerminalAudio({
    sessionId: session?.id || "",
    enabled: !!session && session.status === "active",
  });

  // Get connection data flow context for firing output to connected blocks
  const connectionFlow = useConnectionDataFlow();
  const connectionFlowRef = React.useRef(connectionFlow);
  connectionFlowRef.current = connectionFlow;

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
        lastPtyOutputTimeRef.current = Date.now();
        outputBufferRef.current = (outputBufferRef.current + cleaned).slice(-2000);
        if (!isClaudeSession && /Claude Code v/i.test(outputBufferRef.current)) {
          setIsClaudeSession(true);
        }
      }, [isClaudeSession, maybeCreateBrowserBlock]),
      onAudio: handleAudioEvent,
      onAgentStopped: React.useCallback((event: { agent: string; lastMessage: string }) => {
        // Show toast notification when agent finishes
        const agentName = event.agent.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
        const preview = event.lastMessage.length > 100
          ? event.lastMessage.slice(0, 100) + "..."
          : event.lastMessage;
        toast.info(`${agentName} finished`, {
          description: preview || "Task completed",
        });

        // Fire output to connected blocks (e.g., note blocks, other terminals)
        if (connectionFlowRef.current && event.lastMessage) {
          connectionFlowRef.current.fireOutput(id, "right-out", {
            text: event.lastMessage,
            execute: true,
          });
          connectionFlowRef.current.fireOutput(id, "bottom-out", {
            text: event.lastMessage,
            execute: true,
          });
        }
      }, [id]),
    }
  );

  const { connectionState, turnTaking, agentState, ptyClosed, error: wsError, ttsStatus } = terminalState;

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

  // Post-reconnect liveness watchdog refs
  const lastPtyOutputTimeRef = React.useRef<number>(0);
  const reconnectWatchdogRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevConnectionStateRef = React.useRef<string>("disconnected");

  // Apply secrets when reconnecting to an existing session (e.g., page reload)
  // Track if we've already applied secrets for this session
  const secretsAppliedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!session?.id || !isOwner) return;
    // Only apply once per session ID
    if (secretsAppliedRef.current === session.id) return;

    // Mark as applied immediately to prevent duplicate calls
    secretsAppliedRef.current = session.id;

    // Apply secrets (fire and forget - errors are logged but don't block)
    applySessionSecrets(session.id)
      .then(() => console.log(`[TerminalBlock] Secrets applied on reconnect`))
      .catch((e) => console.warn(`[TerminalBlock] Failed to apply secrets on reconnect:`, e));
  }, [session?.id, isOwner]);

  // Computed state
  const isConnected = connectionState === "connected";
  const isConnecting = connectionState === "connecting" || connectionState === "reconnecting";
  const isFailed = connectionState === "failed";
  const isDisconnected = connectionState === "disconnected" && wasConnectedRef.current;
  const isAgentRunning = agentState === "running";
  const isAgentic = terminalMeta.agentic === true;
  const supportsMcp = (isClaudeSession || isAgentic) && terminalType !== "copilot" && terminalType !== "moltbot";
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
      // For Claude/Agentic sessions, use the unified restart banner
      // For regular terminals, show the inline apply notification
      if (needsRestartForSecrets) {
        setPendingConfigRestart(true);
      } else {
        setPendingSecretApply({ name, value });
      }
      // Apply all secrets with proper broker protection
      if (isOwner && session?.id) {
        await applySessionSecrets(session.id);
      }
    } catch {
      setNewSecretName(name);
      setNewSecretValue(value);
    }
  }, [createSecretMutation, data.dashboardId, newSecretName, newSecretValue, isOwner, session?.id, needsRestartForSecrets]);

  const handleDeleteSecret = React.useCallback(
    async (secret: UserSecret) => {
      await deleteSecretMutation.mutateAsync({ id: secret.id });
      // Re-apply all secrets (the deleted one will no longer be in the DB)
      if (isOwner && session?.id) {
        await applySessionSecrets(session.id);
      }
      // For Claude/Agentic sessions, use the unified restart banner
      if (needsRestartForSecrets) {
        setPendingConfigRestart(true);
      }
      setPendingSecretApply((current) =>
        current?.name === secret.name ? null : current
      );
    },
    [deleteSecretMutation, isOwner, session?.id, needsRestartForSecrets]
  );

  // Env var handlers (non-brokered)
  const handleAddEnvVar = React.useCallback(async () => {
    const name = newEnvVarName.trim();
    const value = newEnvVarValue.trim();
    if (!name || !value) return;
    setNewEnvVarName("");
    setNewEnvVarValue("");
    try {
      await createEnvVarMutation.mutateAsync({
        dashboardId: data.dashboardId,
        name,
        value,
      });
      // For Claude/Agentic sessions, use the unified restart banner
      // For regular terminals, show the inline apply notification
      if (needsRestartForSecrets) {
        setPendingConfigRestart(true);
      } else {
        setPendingSecretApply({ name, value });
      }
      // Apply all secrets/env vars with proper broker protection
      if (isOwner && session?.id) {
        await applySessionSecrets(session.id);
      }
    } catch {
      setNewEnvVarName(name);
      setNewEnvVarValue(value);
    }
  }, [createEnvVarMutation, data.dashboardId, newEnvVarName, newEnvVarValue, isOwner, session?.id, needsRestartForSecrets]);

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

  // Register handlers for incoming data from connections (both left and top inputs)
  React.useEffect(() => {
    if (!connectionFlow) return;

    const handler = (payload: { text: string; execute?: boolean }) => {
      // Default execute to true unless explicitly set to false
      const shouldExecute = payload.execute !== false;
      console.log("[TerminalBlock] Received input from connection", {
        id,
        canType,
        text: payload.text?.slice(0, 50),
        execute: shouldExecute,
        terminalType,
      });
      if (canType && payload.text) {
        let text = payload.text;
        // Gemini CLI special characters:
        // - Single quotes break shell command parsing
        // - ! triggers shell mode
        if (terminalType === "gemini") {
          text = text
            .replace(/'/g, "'\\''")  // Escape single quotes for shell
            .replace(/!/g, ".");      // Replace ! to avoid shell mode trigger
        }
        if (shouldExecute) {
          // Server handles text + CR atomically
          terminalActions.sendExecute(text);
        } else {
          terminalActions.sendInput(text);
        }
      }
    };

    const cleanupLeft = connectionFlow.registerInputHandler(id, "left-in", handler);
    const cleanupTop = connectionFlow.registerInputHandler(id, "top-in", handler);

    return () => {
      cleanupLeft();
      cleanupTop();
    };
  }, [id, connectionFlow, canType, terminalActions, terminalType]);

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

      // Apply stored secrets to the new session
      try {
        await applySessionSecrets(newSession.id);
        console.log(`[TerminalBlock] Secrets applied to session`);
      } catch (e) {
        console.warn(`[TerminalBlock] Failed to apply secrets:`, e);
      }

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

      // Apply stored secrets to the new session
      try {
        await applySessionSecrets(newSession.id);
        console.log(`[TerminalBlock] Secrets applied to session`);
      } catch (e) {
        console.warn(`[TerminalBlock] Failed to apply secrets:`, e);
      }

      // Clear the pending config restart banner since we've applied all changes
      setPendingConfigRestart(false);
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

  // Auto-restart when the connection fails or the session ends.
  // Previously this was gated on session.status === "stopped", but after
  // deployments the sandbox is replaced while the session is still "active"
  // in frontend state. The WebSocket exhausts all retries (→ "failed") and
  // the user is stuck. Now we restart on any terminal failure regardless of
  // the session status the frontend last saw.
  React.useEffect(() => {
    if (!session || !isOwner) {
      return;
    }
    if (!isFailed && !isDisconnected && !ptyClosed) {
      return;
    }
    if (isCreatingSession || autoReopenAttemptedRef.current) {
      return;
    }
    autoReopenAttemptedRef.current = true;
    console.log(`[TerminalBlock] Auto-restart: isFailed=${isFailed} isDisconnected=${isDisconnected} ptyClosed=${ptyClosed} sessionStatus=${session.status}`);
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

  // Post-reconnect liveness watchdog: if no PTY output arrives within 8s
  // after a WebSocket reconnection, auto-restart the session.
  // Only triggers on reconnect (reconnecting→connected), not initial connect.
  React.useEffect(() => {
    const wasReconnecting = prevConnectionStateRef.current === "reconnecting";
    prevConnectionStateRef.current = connectionState;

    // Clear any existing watchdog on state change
    if (reconnectWatchdogRef.current) {
      clearTimeout(reconnectWatchdogRef.current);
      reconnectWatchdogRef.current = null;
    }

    // Only trigger when transitioning from "reconnecting" to "connected"
    if (connectionState !== "connected" || !wasReconnecting) {
      return;
    }

    // Only the owner can restart sessions
    if (!isOwner || !session) {
      return;
    }

    const reconnectTime = Date.now();
    console.log(`[TerminalBlock] Reconnect detected, starting 8s liveness watchdog`);

    reconnectWatchdogRef.current = setTimeout(() => {
      reconnectWatchdogRef.current = null;
      if (lastPtyOutputTimeRef.current < reconnectTime) {
        console.log(`[TerminalBlock] Watchdog: no PTY output in 8s post-reconnect, auto-restarting`);
        terminalRef.current?.write("\x1b[33mSession unresponsive after reconnect, restarting...\x1b[0m\r\n");
        void handleReopen();
      } else {
        console.log(`[TerminalBlock] Watchdog: PTY output received, session is alive`);
      }
    }, 8000);

    return () => {
      if (reconnectWatchdogRef.current) {
        clearTimeout(reconnectWatchdogRef.current);
        reconnectWatchdogRef.current = null;
      }
    };
  }, [connectionState, isOwner, session, handleReopen]);

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

      // Only auto-adjust font size when "auto" is selected
      if (!isAutoFontSize) {
        return;
      }

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
  }, [data.size.width, data.size.height, session, blockWidth, isAutoFontSize]);

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
          {/* Attached Agents List */}
          {(showAttachedList || activePanel === "subagents") && (isClaudeSession || isAgentic) && (
            <div className="rounded border border-[var(--border)] bg-[var(--background-elevated)] shadow-md min-w-80">
              <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--border)]">
                <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--foreground)]">
                  <Bot className="w-3 h-3" />
                  <span>Attached Agents</span>
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
                  <div className="text-[var(--foreground-muted)]">No agents attached.</div>
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
                    <div className="flex items-center gap-1">
                      {terminalMeta.skillIds.includes(skill.id) ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDetachSkill(skill.id)}
                          className="text-[10px] h-5 px-2 nodrag"
                        >
                          Detach
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleUseSavedSkill(skill)}
                          className="text-[10px] h-5 px-2 nodrag"
                        >
                          Attach
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => deleteAgentSkillMutation.mutate(skill.id)}
                        className="h-5 w-5 text-[var(--status-error)] nodrag"
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Attached MCP Tools List */}
          {(showSavedMcp || activePanel === "mcp-tools") && supportsMcp && (
            <div className="rounded border border-[var(--border)] bg-[var(--background-elevated)] shadow-md min-w-80">
              <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--border)]">
                <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--foreground)]">
                  <Wrench className="w-3 h-3" />
                  <span>Attached MCP Tools</span>
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
                {terminalMeta.mcpToolIds.length === 0 && (
                  <div className="text-[var(--foreground-muted)]">No MCP tools attached.</div>
                )}
                {terminalMeta.mcpToolIds.map((toolId) => {
                  const tool = savedMcpById.get(toolId);
                  const isBuiltin = tool?.source === "builtin";
                  return (
                    <div
                      key={toolId}
                      className="flex items-center justify-between rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1"
                    >
                      <span className="text-[var(--foreground)]">
                        {tool?.name || "Unknown"}
                        {isBuiltin && <span className="text-[var(--foreground-muted)]"> (built-in)</span>}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDetachMcpTool(toolId)}
                        className="text-[10px] h-5 px-2 nodrag"
                      >
                        Detach
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Secrets & Environment Variables Panel */}
          {activePanel === "secrets" && (
            <div className="rounded border border-[var(--border)] bg-[var(--background-elevated)] shadow-md w-80">
              <div className="flex items-center justify-between px-2 py-1 border-b border-[var(--border)]">
                <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--foreground)]">
                  <Key className="w-3 h-3" />
                  <span>Secrets & Environment Variables</span>
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
              <div className="p-2 space-y-2 text-xs max-h-[400px] overflow-auto">
                {/* Inline hint for applying env vars to running terminal */}
                {pendingSecretApply && (
                  <div className="flex items-center justify-between gap-2 rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1">
                    <div className="flex items-center gap-1 text-[10px] text-[var(--foreground-muted)]">
                      <span>Saved {pendingSecretApply.name}. Run</span>
                      <button
                        type="button"
                        onClick={() => {
                          const cmd = needsRestartForSecrets ? "! source .env" : "source .env";
                          navigator.clipboard.writeText(cmd);
                        }}
                        className="inline-flex items-center gap-1 font-mono bg-[var(--background-muted)] px-1.5 py-0.5 rounded hover:bg-[var(--background-hover)] transition-colors cursor-pointer nodrag"
                        title="Click to copy"
                      >
                        {needsRestartForSecrets ? "! source .env" : "source .env"}
                        <Copy className="w-2.5 h-2.5" />
                      </button>
                      <span>to apply.</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setPendingSecretApply(null)}
                      className="h-5 w-5 nodrag"
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                )}

                {/* ========== SECRETS SECTION (brokered) ========== */}
                <div className="border border-[var(--border)] rounded">
                  <button
                    type="button"
                    onClick={() => setSecretsSectionExpanded(!secretsSectionExpanded)}
                    className="flex items-center justify-between w-full px-2 py-1.5 hover:bg-[var(--background)] transition-colors"
                  >
                    <div className="flex items-center gap-1.5">
                      {secretsSectionExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      <Shield className="w-3 h-3 text-[var(--status-success)]" />
                      <span className="font-medium">Secrets</span>
                      <span className="text-[var(--foreground-muted)]">({savedSecrets.length})</span>
                    </div>
                    <span className="text-[10px] text-[var(--foreground-muted)]">API keys, tokens</span>
                  </button>
                  {secretsSectionExpanded && (
                    <div className="border-t border-[var(--border)] p-2 space-y-2">
                      <div className="text-[10px] text-[var(--foreground-muted)]">
                        Secrets are brokered - the LLM cannot read them directly.
                      </div>
                      <form
                        autoComplete="off"
                        data-form-type="other"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (newSecretName.trim() && newSecretValue.trim()) {
                            handleAddSecret();
                          }
                        }}
                        className="flex gap-1"
                      >
                        <Input
                          name="secret_key_name"
                          placeholder="NAME"
                          value={newSecretName}
                          onChange={(e) => setNewSecretName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
                          className="h-6 text-xs flex-1 nodrag font-mono"
                          autoComplete="off"
                          data-form-type="other"
                        />
                        <Input
                          ref={secretValueInputRef}
                          name="secret_key_value"
                          type="text"
                          placeholder="Value"
                          value={newSecretValue}
                          onChange={(e) => setNewSecretValue(e.target.value)}
                          className="h-6 text-xs flex-1 nodrag"
                          autoComplete="off"
                          data-form-type="other"
                          data-lpignore="true"
                          style={{ WebkitTextSecurity: "disc" } as React.CSSProperties}
                        />
                        <Button
                          type="submit"
                          variant="secondary"
                          size="sm"
                          disabled={!newSecretName.trim() || !newSecretValue.trim()}
                          className="h-6 px-2 nodrag"
                        >
                          <Plus className="w-3 h-3" />
                        </Button>
                      </form>
                      {/* Pending domain approvals */}
                      {pendingApprovalsQuery.data && pendingApprovalsQuery.data.length > 0 && (
                        <div className="space-y-1">
                          {pendingApprovalsQuery.data.map((approval) => (
                            <div
                              key={approval.id}
                              className="flex items-center justify-between rounded border border-[var(--status-warning)]/50 bg-[var(--status-warning)]/10 px-2 py-1.5 cursor-pointer hover:bg-[var(--status-warning)]/20 transition-colors"
                              onClick={() => {
                                setApprovalToShow(approval);
                                setApprovalHeaderName("Authorization");
                                setApprovalHeaderFormat("Bearer %s");
                              }}
                            >
                              <div className="flex items-center gap-1.5 min-w-0">
                                <Shield className="w-3 h-3 text-[var(--status-warning)] flex-shrink-0" />
                                <span className="text-[var(--foreground)] text-xs">
                                  Domain approval needed for{" "}
                                  <code className="font-mono px-1 py-0.5 bg-[var(--background)] rounded text-[10px]">
                                    {approval.domain}
                                  </code>
                                </span>
                              </div>
                              <ChevronRight className="w-3 h-3 text-[var(--foreground-muted)] flex-shrink-0" />
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Secrets list */}
                      <div className="space-y-1">
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
                            <div className="flex items-center gap-1 min-w-0">
                              <button
                                type="button"
                                onClick={() => {
                                  if (secret.brokerProtected) {
                                    setSecretToDisableProtection(secret);
                                  } else {
                                    // Re-enable protection
                                    updateProtectionMutation.mutate({
                                      id: secret.id,
                                      brokerProtected: true,
                                    });
                                  }
                                }}
                                title={secret.brokerProtected ? "Protected - Click to disable protection" : "Unprotected - Click to enable protection"}
                                className="nodrag hover:opacity-70 transition-opacity"
                              >
                                {secret.brokerProtected ? (
                                  <Shield className="w-3 h-3 text-[var(--status-success)] flex-shrink-0" />
                                ) : (
                                  <ShieldOff className="w-3 h-3 text-[var(--status-warning)] flex-shrink-0" />
                                )}
                              </button>
                              <span className="text-[var(--foreground)] font-mono truncate">{secret.name}</span>
                              <span className="text-[var(--foreground-muted)] font-mono text-xs">=</span>
                              <span className="text-[var(--foreground-subtle)] font-mono text-xs tracking-tight">{'•'.repeat(8)}</span>
                            </div>
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
                  )}
                </div>

                {/* ========== ENVIRONMENT VARIABLES SECTION (non-brokered) ========== */}
                <div className="border border-[var(--border)] rounded">
                  <button
                    type="button"
                    onClick={() => setEnvVarsSectionExpanded(!envVarsSectionExpanded)}
                    className="flex items-center justify-between w-full px-2 py-1.5 hover:bg-[var(--background)] transition-colors"
                  >
                    <div className="flex items-center gap-1.5">
                      {envVarsSectionExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      <Settings className="w-3 h-3 text-[var(--foreground-muted)]" />
                      <span className="font-medium">Environment Variables</span>
                      <span className="text-[var(--foreground-muted)]">({savedEnvVars.length})</span>
                    </div>
                    <span className="text-[10px] text-[var(--foreground-muted)]">Config values</span>
                  </button>
                  {envVarsSectionExpanded && (
                    <div className="border-t border-[var(--border)] p-2 space-y-2">
                      <div className="text-[10px] text-[var(--foreground-muted)]">
                        Environment variables are set directly - the LLM can read them.
                      </div>
                      {/* Warning for secret-like names */}
                      {newEnvVarName && looksLikeSecret(newEnvVarName) && (
                        <div className="flex items-start gap-1.5 rounded border border-[var(--status-warning)]/50 bg-[var(--status-warning)]/10 px-2 py-1.5">
                          <AlertCircle className="w-3 h-3 text-[var(--status-warning)] flex-shrink-0 mt-0.5" />
                          <div className="text-[10px] text-[var(--foreground)]">
                            <span className="font-medium">{newEnvVarName}</span> looks like an API key or secret.
                            Consider adding it to <span className="font-medium">Secrets</span> instead for protection.
                          </div>
                        </div>
                      )}
                      <form
                        autoComplete="off"
                        data-form-type="other"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (newEnvVarName.trim() && newEnvVarValue.trim()) {
                            handleAddEnvVar();
                          }
                        }}
                        className="flex gap-1"
                      >
                        <Input
                          name="env_var_name"
                          placeholder="NAME"
                          value={newEnvVarName}
                          onChange={(e) => setNewEnvVarName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
                          className="h-6 text-xs flex-1 nodrag font-mono"
                          autoComplete="off"
                          data-form-type="other"
                        />
                        <Input
                          name="env_var_value"
                          type="text"
                          placeholder="Value"
                          value={newEnvVarValue}
                          onChange={(e) => setNewEnvVarValue(e.target.value)}
                          className="h-6 text-xs flex-1 nodrag"
                          autoComplete="off"
                          data-form-type="other"
                          data-lpignore="true"
                        />
                        <Button
                          type="submit"
                          variant="secondary"
                          size="sm"
                          disabled={!newEnvVarName.trim() || !newEnvVarValue.trim()}
                          className="h-6 px-2 nodrag"
                        >
                          <Plus className="w-3 h-3" />
                        </Button>
                      </form>
                      {/* Env vars list */}
                      <div className="space-y-1">
                        {secretsQuery.isLoading && (
                          <div className="text-[var(--foreground-muted)]">Loading...</div>
                        )}
                        {!secretsQuery.isLoading && savedEnvVars.length === 0 && (
                          <div className="text-[var(--foreground-muted)]">No environment variables configured.</div>
                        )}
                        {savedEnvVars.map((envVar) => (
                          <div
                            key={envVar.id}
                            className="flex items-center justify-between rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1"
                          >
                            <div className="flex items-center gap-1 min-w-0">
                              <span className="text-[var(--foreground)] font-mono truncate">{envVar.name}</span>
                              <span className="text-[var(--foreground-muted)] font-mono text-xs">=</span>
                              <span className="text-[var(--foreground-subtle)] font-mono text-xs tracking-tight">{'•'.repeat(8)}</span>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => handleDeleteSecret(envVar)}
                              className="h-5 w-5 text-[var(--status-error)] nodrag"
                            >
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Agents Panel */}
          {activePanel === "subagents" && (
            <CatalogPanel
              title="Add agents"
              activeTab={activeSubagentTab}
              onTabChange={setActiveSubagentTab}
              onClose={() => setActivePanel(null)}
              savedItems={savedSubagents}
              savedLoading={subagentsQuery.isLoading}
              savedEmptyText="No saved agents yet."
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
                    <div className="flex items-center gap-1">
                      {terminalMeta.skillIds.includes(item.id) ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDetachSkill(item.id)}
                          className="text-[10px] h-5 px-2 nodrag"
                        >
                          Detach
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleUseSavedSkill(item)}
                          className="text-[10px] h-5 px-2 nodrag"
                        >
                          Attach
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => deleteAgentSkillMutation.mutate(item.id)}
                        className="h-5 w-5 text-[var(--status-error)] nodrag"
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
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
                    <div className="flex items-center gap-1">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleUseBrowseSkill(item)}
                        className="text-[10px] h-5 px-2 nodrag"
                      >
                        Attach
                      </Button>
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
                    <div className="flex items-center gap-1">
                      {terminalMeta.mcpToolIds.includes(item.id) ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDetachMcpTool(item.id)}
                          className="text-[10px] h-5 px-2 nodrag"
                        >
                          Detach
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleUseSavedMcpTool(item)}
                          className="text-[10px] h-5 px-2 nodrag"
                        >
                          Attach
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => deleteMcpToolMutation.mutate(item.id)}
                        className="h-5 w-5 text-[var(--status-error)] nodrag"
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
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
                    <div className="flex items-center gap-1">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleUseBrowseMcpTool(item)}
                        className="text-[10px] h-5 px-2 nodrag"
                      >
                        Attach
                      </Button>
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

          {/* TTS Voice Panel */}
          {activePanel === "tts-voice" && (
            <div className="rounded border border-[var(--border)] bg-[var(--background-elevated)] shadow-md w-72">
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
              <div className="p-3 space-y-3">
                {/* Live TTS status from talkito */}
                {ttsStatus && (
                  <div className={cn(
                    "flex items-center gap-2 px-2 py-1.5 rounded text-[10px]",
                    ttsStatus.enabled && ttsStatus.initialized
                      ? "bg-[var(--status-success)]/10 text-[var(--status-success)]"
                      : "bg-[var(--foreground-subtle)]/10 text-[var(--foreground-muted)]"
                  )}>
                    <span className={cn(
                      "w-2 h-2 rounded-full shrink-0",
                      ttsStatus.enabled && ttsStatus.initialized
                        ? "bg-[var(--status-success)] animate-pulse"
                        : "bg-[var(--foreground-subtle)]"
                    )} />
                    <span className="font-medium">
                      {ttsStatus.enabled && ttsStatus.initialized ? (
                        <>Live: {ttsStatus.provider}{ttsStatus.voice ? ` (${ttsStatus.voice})` : ""}</>
                      ) : ttsStatus.enabled ? (
                        "Initializing..."
                      ) : (
                        "TTS disabled in session"
                      )}
                    </span>
                  </div>
                )}

                {/* Provider selection */}
                <div className="space-y-1">
                  <label className="text-[10px] font-medium text-[var(--foreground-muted)] uppercase tracking-wide">
                    Provider
                  </label>
                  <select
                    value={terminalMeta.ttsProvider || "none"}
                    onChange={(e) => {
                      const newProvider = e.target.value;
                      const voices = TTS_PROVIDERS[newProvider]?.voices || [];
                      const newVoice = voices[0] || "";
                      handleTtsChange(newProvider, newVoice);
                    }}
                    className="w-full h-7 px-2 text-xs rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]"
                  >
                    {Object.entries(TTS_PROVIDERS).map(([key, { label }]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Voice selection - only show if provider is not "none" */}
                {terminalMeta.ttsProvider && terminalMeta.ttsProvider !== "none" && (
                  <div className="space-y-1">
                    <label className="text-[10px] font-medium text-[var(--foreground-muted)] uppercase tracking-wide">
                      Voice
                    </label>
                    <select
                      value={terminalMeta.ttsVoice || ""}
                      onChange={(e) => handleTtsChange(terminalMeta.ttsProvider || "none", e.target.value)}
                      className="w-full h-7 px-2 text-xs rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]"
                    >
                      {(TTS_PROVIDERS[terminalMeta.ttsProvider]?.voices || []).map((voice) => (
                        <option key={voice} value={voice}>
                          {voice}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* API Key hint - show if provider requires one */}
                {terminalMeta.ttsProvider && TTS_PROVIDERS[terminalMeta.ttsProvider]?.envKey && (
                  <div className="pt-2 border-t border-[var(--border)]">
                    <div className="text-[10px] text-[var(--foreground-muted)]">
                      Requires <code className="px-1 py-0.5 rounded bg-[var(--background)] font-mono">{TTS_PROVIDERS[terminalMeta.ttsProvider].envKey}</code> in Environment Variables
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        const envKey = TTS_PROVIDERS[terminalMeta.ttsProvider!].envKey;
                        if (envKey) setNewSecretName(envKey);
                        setActivePanel("secrets");
                        // Focus the value input after panel renders
                        setTimeout(() => secretValueInputRef.current?.focus(), 50);
                      }}
                      className="mt-1.5 h-6 text-[10px] text-[var(--accent-primary)]"
                    >
                      <Key className="w-3 h-3 mr-1" />
                      Open Environment Variables
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Integrations Panel */}
          {activePanel === "integrations" && session?.ptyId && (
            <IntegrationsPanel
              dashboardId={data.dashboardId}
              terminalId={session.ptyId}
              onClose={() => setActivePanel(null)}
              onPolicyUpdate={data.onPolicyUpdate}
              onIntegrationAttached={data.onIntegrationAttached}
              onIntegrationDetached={data.onIntegrationDetached}
            />
          )}
        </div>
      )}

      {/* All content fades during minimize */}
      <div className={cn("flex flex-col flex-1 min-h-0", isAnimatingMinimize && "animate-content-fade-out")}>
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
          ) : terminalName === "OpenClaw" || terminalName === "Moltbot" ? (
            <img src="/icons/moltbot.png" alt="OpenClaw icon" title="OpenClaw icon" className="w-4 h-4" />
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

          {/* Agents, Skills, MCP Tools buttons - only shown in agentic mode */}
          {(isClaudeSession || isAgentic) && (
            <>
              {/* Agents button - hidden for Gemini, Codex, Copilot, and OpenClaw */}
              {terminalName !== "Gemini CLI" && terminalName !== "Codex" && terminalName !== "GitHub Copilot CLI" && terminalName !== "OpenClaw" && terminalName !== "Moltbot" && (
                <button
                  type="button"
                  onClick={() => setShowAttachedList((prev) => !prev)}
                  title={
                    attachedNames.length > 0
                      ? `Agents: ${attachedNames.join(", ")}`
                      : "No agents attached - click to manage"
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
                  attachedSkillNames.length > 0
                    ? `Attached skills: ${attachedSkillNames.join(", ")}`
                    : savedSkills.length > 0
                      ? `Saved skills: ${savedSkills.map(s => s.name).join(", ")}`
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
                <span className="text-[10px] font-medium">{attachedSkillNames.length}</span>
              </button>

              {/* MCP Tools button - hidden for Copilot (no MCP config available) */}
              {supportsMcp && (
                <button
                  type="button"
                  onClick={() => setShowSavedMcp((prev) => !prev)}
                  title={
                    attachedMcpToolNames.length > 0
                      ? `MCP tools: ${attachedMcpToolNames.join(", ")}`
                      : "No MCP tools attached - click to add"
                  }
                  className={cn(
                    "flex items-center gap-0.5 px-1 py-0.5 rounded text-xs nodrag",
                    showSavedMcp || activePanel === "mcp-tools"
                      ? "text-[var(--foreground)] bg-[var(--background-hover)]"
                      : "text-[var(--foreground-muted)] hover:bg-[var(--background-hover)]"
                  )}
                >
                  <Wrench className="w-3.5 h-3.5" />
                  <span className="text-[10px] font-medium">{attachedMcpToolNames.length}</span>
                </button>
              )}

              {/* Integrations button */}
              <button
                type="button"
                onClick={() => setActivePanel(activePanel === "integrations" ? null : "integrations")}
                title="Manage integrations (Gmail, Calendar, GitHub, etc.)"
                className={cn(
                  "flex items-center gap-0.5 px-1 py-0.5 rounded text-xs nodrag",
                  activePanel === "integrations"
                    ? "text-[var(--foreground)] bg-[var(--background-hover)]"
                    : "text-[var(--foreground-muted)] hover:bg-[var(--background-hover)]"
                )}
              >
                <Plug className="w-3.5 h-3.5" />
              </button>

              {/* TTS Voice indicator - prefers live status from talkito over config */}
              {(() => {
                // Use live TTS status if available and enabled, otherwise fall back to config
                const liveTtsEnabled = ttsStatus?.enabled && ttsStatus?.initialized;
                const liveTtsProvider = liveTtsEnabled ? ttsStatus?.provider : null;
                const liveTtsVoice = liveTtsEnabled ? ttsStatus?.voice : null;
                const effectiveProvider = liveTtsProvider || terminalMeta.ttsProvider;
                const effectiveVoice = liveTtsVoice || terminalMeta.ttsVoice;
                const isActive = !!effectiveProvider && effectiveProvider !== "none";

                return (
                  <button
                    type="button"
                    onClick={() => setActivePanel(activePanel === "tts-voice" ? null : "tts-voice")}
                    title={
                      isActive
                        ? `TTS: ${effectiveProvider}${effectiveVoice ? ` (${effectiveVoice})` : ""}${liveTtsEnabled ? " (live)" : ""}`
                        : "Text-to-speech disabled - click to configure"
                    }
                    className={cn(
                      "flex items-center gap-0.5 px-1 py-0.5 rounded text-xs nodrag",
                      activePanel === "tts-voice"
                        ? "text-[var(--foreground)] bg-[var(--background-hover)]"
                        : "text-[var(--foreground-muted)] hover:bg-[var(--background-hover)]"
                    )}
                  >
                    <Volume2 className="w-3.5 h-3.5" />
                    <span
                      className={cn(
                        "w-1.5 h-1.5 rounded-full",
                        liveTtsEnabled
                          ? "bg-[var(--status-success)] animate-pulse"
                          : isActive
                            ? "bg-[var(--status-success)]"
                            : "bg-[var(--foreground-subtle)]"
                      )}
                    />
                  </button>
                );
              })()}
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

          {/* Minimize button */}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleMinimize}
            className="h-7 w-7 nodrag"
            style={{ pointerEvents: "auto" }}
            title="Minimize"
          >
            <Minimize2 className="w-5 h-5" />
          </Button>

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
              <DropdownMenuItem onClick={() => setActivePanel(activePanel === "secrets" ? null : "secrets")} className="gap-2">
                <Key className="w-3 h-3" />
                <span>Environment Variables</span>
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
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="gap-2">
                  <span>Font Size</span>
                  <span className="ml-auto text-[10px] text-[var(--foreground-muted)]">
                    {FONT_SIZE_PRESETS[fontSizeSetting].label}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={fontSizeSetting}
                    onValueChange={(value) => handleFontSizeChange(value as FontSizeSetting)}
                  >
                    <DropdownMenuRadioItem value="auto">Auto</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="small">Small (10px)</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="medium">Medium (12px)</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="large">Large (14px)</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="xlarge">Extra Large (16px)</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              {terminalName !== "Gemini CLI" && terminalName !== "Codex" && terminalName !== "GitHub Copilot CLI" && terminalName !== "OpenClaw" && terminalName !== "Moltbot" && (
                <DropdownMenuItem onClick={() => setActivePanel(activePanel === "subagents" ? null : "subagents")} className="gap-2" disabled={!isClaudeSession && !isAgentic}>
                  <Bot className="w-3 h-3" />
                  <span>Agents</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setActivePanel(activePanel === "agent-skills" ? null : "agent-skills")} className="gap-2" disabled={!isClaudeSession && !isAgentic}>
                <Wand2 className="w-3 h-3" />
                <span>Skills</span>
              </DropdownMenuItem>
              {supportsMcp && (
                <DropdownMenuItem onClick={() => setActivePanel(activePanel === "mcp-tools" ? null : "mcp-tools")} className="gap-2">
                  <Wrench className="w-3 h-3" />
                  <span>MCP Tools</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setActivePanel(activePanel === "integrations" ? null : "integrations")} className="gap-2">
                <Plug className="w-3 h-3" />
                <span>Integrations</span>
              </DropdownMenuItem>
              {/* TTS Voice - only for Claude Code and Codex */}
              {(terminalType === "claude" || terminalType === "codex") && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setActivePanel(activePanel === "tts-voice" ? null : "tts-voice")} className="gap-2">
                    <Volume2 className="w-3 h-3" />
                    <span>TTS Voice</span>
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={handleReopen}
                disabled={isCreatingSession || !session}
                className="gap-2"
              >
                <RefreshCw className="w-3 h-3" />
                <span>{isCreatingSession ? "Restarting..." : "Restart"}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => data.onDuplicate?.()} className="gap-2">
                <Copy className="w-3 h-3" />
                <span>Duplicate</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Restart to apply banner - shown when MCP/skills/agents changed */}
      {pendingConfigRestart && session && (isClaudeSession || isAgentic) && (
        <div
          className="flex items-center justify-between gap-2 px-2 py-1 bg-[var(--status-warning)]/10 border-b border-[var(--status-warning)]/30"
          style={{ pointerEvents: "auto" }}
        >
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--foreground)]">
            <RefreshCw className="w-3 h-3" />
            <span>Configuration changed. Restart to apply.</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleReopen}
              disabled={isCreatingSession}
              className="h-5 px-2 text-[10px] nodrag"
            >
              {isCreatingSession ? "Restarting..." : "Restart"}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setPendingConfigRestart(false)}
              className="h-5 w-5 nodrag"
              title="Dismiss"
            >
              <X className="w-3 h-3" />
            </Button>
          </div>
        </div>
      )}

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
    </div>
  );

  // Minimized view - use settings menu from dropdown if available
  // Only show when fully minimized (not during animation)
  if (isMinimized && !isAnimatingMinimize) {
    // Determine icon based on terminal name
    const minimizedIcon = terminalName === "Claude Code" ? (
      <img src="/icons/claude.ico" alt="Claude Code" className="w-14 h-14" />
    ) : terminalName === "Gemini CLI" ? (
      <img src="/icons/gemini.ico" alt="Gemini CLI" className="w-14 h-14" />
    ) : terminalName === "Codex" ? (
      <img src="/icons/codex.png" alt="Codex" className="w-14 h-14" />
    ) : terminalName === "OpenCode" ? (
      <img src="/icons/opencode.ico" alt="OpenCode" className="w-14 h-14" />
    ) : terminalName === "GitHub Copilot CLI" ? (
      <img src="/icons/github.png" alt="GitHub Copilot" className="w-14 h-14" />
    ) : terminalName === "Droid" ? (
      <img src="/icons/droid.png" alt="Droid" className="w-14 h-14" />
    ) : terminalName === "OpenClaw" || terminalName === "Moltbot" ? (
      <img src="/icons/moltbot.png" alt="OpenClaw" className="w-14 h-14" />
    ) : (
      <Terminal className="w-14 h-14 text-[var(--foreground-subtle)]" />
    );

    return (
      <MinimizedBlockView
        nodeId={id}
        selected={selected}
        icon={minimizedIcon}
        label={terminalName}
        onExpand={handleExpand}
        settingsMenu={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                title="Settings"
                className="nodrag h-5 w-5"
              >
                <Settings className="w-3 h-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuItem
                onSelect={() => deleteElements({ nodes: [{ id }] })}
                className="text-red-500"
              >
                <Trash2 className="w-3.5 h-3.5 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
        connectorsVisible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
    );
  }

  return (
    <>
      {/* Invisible placeholder node in ReactFlow for drag/resize handling */}
      <BlockWrapper
        selected={selected}
        className={cn("p-0 overflow-hidden", expandAnimation, isAnimatingMinimize && "animate-shrink-fade-out")}
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
              />
            </div>,
            overlay.root
          )
        : terminalContent}

      {/* Disable Protection Confirmation Dialog */}
      <Dialog
        open={!!secretToDisableProtection}
        onOpenChange={(open) => {
          if (!open) setSecretToDisableProtection(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[var(--status-warning)]">
              <ShieldOff className="w-5 h-5" />
              Disable Secret Protection?
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 text-sm">
                <p>
                  This will expose <code className="px-1.5 py-0.5 rounded bg-[var(--background-elevated)] font-mono text-[var(--foreground)]">{secretToDisableProtection?.name}</code> directly to
                  AI agents running in this sandbox.
                </p>

                <div className="rounded border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/10 p-3 space-y-2">
                  <p className="font-medium text-[var(--foreground)]">This should rarely be necessary.</p>
                  <p className="text-[var(--foreground-muted)]">
                    The broker is compatible with most APIs and SDKs.
                    If you&apos;re experiencing issues, please check:
                  </p>
                  <ul className="list-disc list-inside text-[var(--foreground-muted)] space-y-1">
                    <li>The API key is correct</li>
                    <li>The service isn&apos;t experiencing an outage</li>
                    <li>Your account has sufficient credits/quota</li>
                  </ul>
                  <p className="text-[var(--foreground-muted)]">
                    Only disable protection if you&apos;ve confirmed the service
                    specifically blocks brokered requests.
                  </p>
                </div>

                <div className="rounded border border-[var(--status-error)]/30 bg-[var(--status-error)]/10 p-3">
                  <p className="text-[var(--status-error)] font-medium">
                    Risk: The agent will be able to read and potentially exfiltrate this key.
                  </p>
                </div>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="secondary"
              onClick={() => setSecretToDisableProtection(null)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (secretToDisableProtection) {
                  updateProtectionMutation.mutate({
                    id: secretToDisableProtection.id,
                    brokerProtected: false,
                  });
                }
                setSecretToDisableProtection(null);
              }}
            >
              I understand, disable protection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Domain Approval Dialog */}
      <Dialog
        open={!!approvalToShow}
        onOpenChange={(open) => {
          if (!open) setApprovalToShow(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-[var(--status-warning)]" />
              Domain Approval Required
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-4 text-sm">
                <p>
                  A request was blocked because it needs your approval to send a secret to a new domain.
                </p>

                <div className="rounded border border-[var(--border)] bg-[var(--background-elevated)] p-3 space-y-2 font-mono text-xs">
                  <div className="flex justify-between">
                    <span className="text-[var(--foreground-muted)]">Secret:</span>
                    <span className="text-[var(--foreground)]">{approvalToShow?.secretName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--foreground-muted)]">Domain:</span>
                    <span className="text-[var(--foreground)]">{approvalToShow?.domain}</span>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <label className="text-[var(--foreground-muted)] text-xs">Header name</label>
                    <select
                      value={approvalHeaderName}
                      onChange={(e) => setApprovalHeaderName(e.target.value)}
                      className="w-full px-3 py-2 rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                    >
                      <option value="Authorization">Authorization</option>
                      <option value="x-api-key">x-api-key</option>
                      <option value="X-API-Key">X-API-Key</option>
                      <option value="api-key">api-key</option>
                    </select>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[var(--foreground-muted)] text-xs">Header format</label>
                    <select
                      value={approvalHeaderFormat}
                      onChange={(e) => setApprovalHeaderFormat(e.target.value)}
                      className="w-full px-3 py-2 rounded border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                    >
                      <option value="Bearer %s">Bearer %s</option>
                      <option value="%s">%s (plain)</option>
                      <option value="Token %s">Token %s</option>
                      <option value="Basic %s">Basic %s</option>
                    </select>
                  </div>
                </div>

                <div className="rounded border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/10 p-3">
                  <p className="text-[var(--status-warning)] font-medium text-xs">
                    ⚠️ This will allow sending your secret to {approvalToShow?.domain}
                  </p>
                </div>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="secondary"
              onClick={() => {
                if (approvalToShow) {
                  dismissApprovalMutation.mutate(approvalToShow.id);
                }
              }}
              disabled={dismissApprovalMutation.isPending}
            >
              Deny
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (approvalToShow) {
                  approveDomainMutation.mutate({
                    secretId: approvalToShow.secretId,
                    domain: approvalToShow.domain,
                    headerName: approvalHeaderName,
                    headerFormat: approvalHeaderFormat,
                  });
                }
              }}
              disabled={approveDomainMutation.isPending}
            >
              Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default TerminalBlock;
