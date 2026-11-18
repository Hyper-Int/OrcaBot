// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: agent-block-v2-status-detail

"use client";

const AGENT_BLOCK_REVISION = "agent-block-v2-status-detail";
if (typeof window !== "undefined" && !(window as unknown as { __agentBlockLogged?: boolean }).__agentBlockLogged) {
  (window as unknown as { __agentBlockLogged?: boolean }).__agentBlockLogged = true;
  console.log(`[AgentBlock] REVISION: ${AGENT_BLOCK_REVISION} loaded at ${new Date().toISOString()}`);
}

/**
 * Agent block: an outside AI agent (Grok Bot, Muse, Dots, Claude Code, Codex, ...)
 * that runs on its own computer, linked to the user's account with a pairing code.
 *
 * Not linked: pick the agent, paste its setup instructions into it, type the code it
 * prints. Linked: chat with it here (through the dashboard's sandbox, end to end
 * encrypted), and connect the block to a terminal to let that terminal use the agent
 * (e.g. seat it at a PokerBench table). The hub underneath is never named in the UI.
 */

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import { Bot, Copy, Link2, Loader2, Minimize2, Send, Settings, Unlink } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";
import { MinimizedBlockView, MINIMIZED_SIZE } from "./MinimizedBlockView";
import { BlockSettingsFooter } from "./BlockSettingsFooter";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui";
import { AGENT_KINDS, agentKind, setupText } from "@/data/agent-kinds";
import {
  getAgentChat,
  linkAgent,
  listAgents,
  sendAgentMessage,
  unlinkAgent,
  type AgentMessage,
  type LinkedAgent,
} from "@/lib/api/cloudflare/agents";
import type { AgentContent, DashboardItem } from "@/types/dashboard";

interface AgentData extends Record<string, unknown> {
  content: string;
  size: { width: number; height: number };
  metadata?: { minimized?: boolean; expandedSize?: { width: number; height: number }; [key: string]: unknown };
  dashboardId?: string;
  itemId?: string;
  onContentChange?: (content: string) => void;
  onItemChange?: (changes: Partial<DashboardItem>) => void;
  onDuplicate?: () => void;
  connectorMode?: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
}

type AgentNode = Node<AgentData, "agent">;

export function parseAgentContent(content: string): AgentContent {
  try {
    const v = JSON.parse(content || "{}") as Partial<AgentContent>;
    const agent = v.agent && typeof v.agent.identity === "string" && typeof v.agent.name === "string"
      ? { identity: v.agent.identity, name: v.agent.name } : undefined;
    return { kind: typeof v.kind === "string" ? v.kind : AGENT_KINDS[0].id, agent };
  } catch {
    return { kind: AGENT_KINDS[0].id };
  }
}

/** Accepts "abcd efgh", "ABCD-EFGH", a pasted sentence with the code in it. */
export function cleanPairingCode(raw: string): string | null {
  const m = /\b([A-Za-z0-9]{4})[-\s]?([A-Za-z0-9]{4})\b/.exec(raw.trim());
  return m ? `${m[1]}${m[2]}`.toUpperCase() : null;
}

const titleCase = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

const STATUS_TEXT: Record<string, string> = {
  connecting: "Connecting…",
  pairing: "Setting up this dashboard's link…",
  ready: "Connected",
  no_sandbox: "Start a terminal on this dashboard to chat (its computer is asleep).",
  disabled: "Agent linking isn't set up on this Orcabot.",
  error: "This dashboard can't reach your agents.",
};

/** What the block says about its link: the status, and why when something is wrong. */
export function statusMessage(status: string, detail?: string): { text: string; why: string | null } {
  const text = STATUS_TEXT[status] ?? status;
  const why = (status === "error" || status === "disabled") && detail?.trim() ? detail.trim() : null;
  return { text, why: why && why.toLowerCase() !== text.toLowerCase().replace(/\.$/, "") ? why : null };
}

export function AgentBlock({ id, data, selected }: NodeProps<AgentNode>) {
  const cfg = React.useMemo(() => parseAgentContent(data.content), [data.content]);
  const kind = agentKind(cfg.kind);
  const connectorsVisible = selected || Boolean(data.connectorMode);
  const isMinimized = data.metadata?.minimized === true;
  const [expandAnimation, setExpandAnimation] = React.useState<string | null>(null);
  const [isAnimatingMinimize, setIsAnimatingMinimize] = React.useState(false);

  const save = (next: AgentContent) => data.onContentChange?.(JSON.stringify(next));

  // Account-level: is linking available, the hub URL for the setup text, agents already linked.
  const [hubUrl, setHubUrl] = React.useState<string>("");
  const [enabled, setEnabled] = React.useState(true);
  const [linked, setLinked] = React.useState<LinkedAgent[]>([]);
  const refreshAgents = React.useCallback(() => {
    listAgents()
      .then((r) => { setHubUrl(r.hubUrl); setEnabled(r.enabled); setLinked(r.agents); })
      .catch(() => setEnabled(false));
  }, []);
  React.useEffect(() => { refreshAgents(); }, [refreshAgents]);

  // --- not linked: pairing code --------------------------------------------------
  const [code, setCode] = React.useState("");
  const [linking, setLinking] = React.useState(false);
  const [linkError, setLinkError] = React.useState<string | null>(null);
  const handleLink = async () => {
    const clean = cleanPairingCode(code);
    if (!clean) { setLinkError("That doesn't look like a pairing code (8 letters and digits, like ABCD-EFGH)."); return; }
    setLinking(true);
    setLinkError(null);
    try {
      const agent = await linkAgent(clean);
      save({ ...cfg, agent: { identity: agent.identity, name: agent.name } });
      setCode("");
      refreshAgents();
      toast.success(`${titleCase(agent.name)} is connected`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLinkError(/unknown_code|404/.test(msg) ? "That code isn't right, or it expired (codes last 10 minutes)."
        : /too_many/.test(msg) ? "You've connected as many agents as you can. Remove one first."
        : "Couldn't connect. Check the code and try again.");
    } finally {
      setLinking(false);
    }
  };

  const handleUnlink = async () => {
    if (!cfg.agent) return;
    try {
      await unlinkAgent(cfg.agent.identity);
      toast.success(`${titleCase(cfg.agent.name)} is disconnected`);
    } catch {
      toast.error("Couldn't disconnect the agent");
    }
    save({ kind: cfg.kind });
    refreshAgents();
  };

  // --- linked: chat ----------------------------------------------------------------
  const [messages, setMessages] = React.useState<AgentMessage[]>([]);
  const [status, setStatus] = React.useState<string>("connecting");
  const [detail, setDetail] = React.useState("");
  const statusMsg = statusMessage(status, detail);
  const [draft, setDraft] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const lastSeq = React.useRef(0);
  const listRef = React.useRef<HTMLDivElement>(null);
  const agentIdentity = cfg.agent?.identity;

  React.useEffect(() => {
    setMessages([]);
    lastSeq.current = 0;
    if (!agentIdentity || !data.dashboardId || isMinimized) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await getAgentChat(data.dashboardId!, agentIdentity, lastSeq.current);
        if (cancelled) return;
        setStatus(r.status);
        setDetail(r.detail || "");
        if (r.messages.length) {
          lastSeq.current = r.messages[r.messages.length - 1].seq;
          setMessages((prev) => [...prev, ...r.messages].slice(-200));
        }
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e);
          const asleep = /409|no_sandbox/.test(msg);
          setStatus(asleep ? "no_sandbox" : "error");
          setDetail(asleep ? "" : msg.slice(0, 240));
        }
      }
      if (!cancelled) timer = setTimeout(poll, 3000);
    };
    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [agentIdentity, data.dashboardId, isMinimized]);

  React.useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || !agentIdentity || !data.dashboardId) return;
    setSending(true);
    try {
      await sendAgentMessage(data.dashboardId, agentIdentity, text);
      setDraft("");
    } catch {
      toast.error("Couldn't send the message");
    } finally {
      setSending(false);
    }
  };

  // --- minimise --------------------------------------------------------------------
  const handleMinimize = () => {
    setIsAnimatingMinimize(true);
    data.onItemChange?.({ metadata: { ...data.metadata, expandedSize: data.size }, size: MINIMIZED_SIZE });
    setTimeout(() => {
      setIsAnimatingMinimize(false);
      data.onItemChange?.({ metadata: { ...data.metadata, minimized: true, expandedSize: data.size } });
    }, 350);
  };
  const handleExpand = () => {
    const saved = data.metadata?.expandedSize;
    setExpandAnimation("animate-expand-bounce");
    setTimeout(() => setExpandAnimation(null), 300);
    data.onItemChange?.({ metadata: { ...data.metadata, minimized: false }, size: saved || { width: 360, height: 480 } });
  };

  const title = cfg.agent ? titleCase(cfg.agent.name) : "Agent";

  if (isMinimized && !isAnimatingMinimize) {
    return (
      <MinimizedBlockView
        nodeId={id}
        selected={selected}
        icon={<Bot className="w-14 h-14 text-[var(--accent-primary)]" />}
        label={title}
        onExpand={handleExpand}
        connectorsVisible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
    );
  }

  const inputClass = "nodrag w-full text-[11px] bg-[var(--background)] border border-[var(--border)] rounded px-1.5 py-1 " +
    "focus:outline-none focus:border-[var(--border-focus)]";

  return (
    <BlockWrapper selected={selected} className={cn("p-0 flex flex-col overflow-visible", expandAnimation)} includeHandles={false}>
      <div className={cn("flex flex-col flex-1 overflow-hidden", isAnimatingMinimize && "animate-content-fade-out")}>
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] shrink-0">
          <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--foreground)] min-w-0">
            <Bot className="w-3.5 h-3.5 text-[var(--accent-primary)] shrink-0" />
            <span className="truncate">{title}</span>
            {cfg.agent && (
              <span
                className={cn("w-1.5 h-1.5 rounded-full shrink-0",
                  status === "ready" ? "bg-green-500" : status === "error" ? "bg-red-500" : "bg-amber-400")}
                title={statusMsg.why ? `${statusMsg.text} ${statusMsg.why}` : statusMsg.text}
              />
            )}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-[var(--foreground-muted)] truncate max-w-[110px]">{kind.title}</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="nodrag h-5 w-5" title="Settings">
                  <Settings className="w-3 h-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={() => data.onDuplicate?.()} className="gap-2">
                  <Copy className="w-3 h-3" /><span>Duplicate</span>
                </DropdownMenuItem>
                {cfg.agent && (
                  <DropdownMenuItem onClick={handleUnlink} className="gap-2">
                    <Unlink className="w-3 h-3" /><span>Disconnect agent</span>
                  </DropdownMenuItem>
                )}
                <BlockSettingsFooter nodeId={id} onMinimize={handleMinimize} />
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="ghost" size="icon-sm" className="nodrag h-5 w-5" title="Minimize" onClick={handleMinimize}>
              <Minimize2 className="w-3 h-3" />
            </Button>
          </div>
        </div>

        {!cfg.agent ? (
          <div className="flex-1 overflow-auto p-3 space-y-3 text-[11px]">
            {!enabled ? (
              <p className="text-[var(--foreground-muted)]">Connecting outside agents isn&apos;t set up on this Orcabot yet.</p>
            ) : (
              <>
                <div className="space-y-1">
                  <div className="font-medium text-[var(--foreground-muted)]">Which agent?</div>
                  <div className="flex flex-wrap gap-1">
                    {AGENT_KINDS.map((k) => (
                      <button
                        key={k.id}
                        type="button"
                        onClick={() => save({ kind: k.id })}
                        className={cn("nodrag rounded border px-1.5 py-0.5",
                          k.id === kind.id ? "border-[var(--accent-primary)] text-[var(--accent-primary)]"
                            : "border-[var(--border)] text-[var(--foreground)] hover:border-[var(--border-focus)]")}
                      >
                        {k.title}
                      </button>
                    ))}
                  </div>
                  <div className="text-[10px] text-[var(--foreground-muted)]">{kind.where}</div>
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-[var(--foreground-muted)]">1. {kind.intro}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="nodrag h-5 px-1.5 text-[10px] gap-1"
                      disabled={!hubUrl}
                      onClick={() => {
                        navigator.clipboard.writeText(setupText(kind, hubUrl)).then(
                          () => toast.success("Copied"), () => toast.error("Couldn't copy"));
                      }}
                    >
                      <Copy className="w-2.5 h-2.5" />Copy
                    </Button>
                  </div>
                  <pre className="nodrag nowheel whitespace-pre-wrap break-words max-h-36 overflow-auto rounded border border-[var(--border)] bg-[var(--background)] p-1.5 text-[10px] leading-snug select-text">
                    {hubUrl ? setupText(kind, hubUrl) : "Loading…"}
                  </pre>
                </div>

                <div className="space-y-1">
                  <div className="font-medium text-[var(--foreground-muted)]">2. Type the pairing code it gives you</div>
                  <div className="flex gap-1">
                    <input
                      value={code}
                      onChange={(e) => { setCode(e.target.value); setLinkError(null); }}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleLink(); } }}
                      placeholder="ABCD-EFGH"
                      autoComplete="off"
                      spellCheck={false}
                      className={cn(inputClass, "font-mono uppercase tracking-wider")}
                    />
                    <Button size="sm" className="nodrag h-7 text-xs gap-1" onClick={handleLink} disabled={linking || !code.trim()}>
                      {linking ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2 className="w-3 h-3" />}Connect
                    </Button>
                  </div>
                  {linkError && <div className="text-[10px] text-red-500">{linkError}</div>}
                  <div className="text-[10px] text-[var(--foreground-muted)]">Codes last 10 minutes.</div>
                </div>

                {linked.length > 0 && (
                  <div className="space-y-1">
                    <div className="font-medium text-[var(--foreground-muted)]">Or use one you&apos;ve already connected</div>
                    <div className="flex flex-wrap gap-1">
                      {linked.map((a) => (
                        <button
                          key={a.identity}
                          type="button"
                          onClick={() => save({ ...cfg, agent: { identity: a.identity, name: a.name } })}
                          className="nodrag rounded border border-[var(--border)] px-1.5 py-0.5 hover:border-[var(--border-focus)]"
                        >
                          {titleCase(a.name)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <>
            {statusMsg.why && messages.length > 0 && (
              <div className="nodrag shrink-0 px-2 py-1 text-[10px] border-b border-[var(--border)] text-red-500 break-words select-text">
                {statusMsg.text} {statusMsg.why}
              </div>
            )}
            <div ref={listRef} className="nodrag nowheel flex-1 overflow-auto p-2 space-y-1.5 text-[11px] select-text">
              {messages.length === 0 ? (
                <div className="text-[var(--foreground-muted)] text-center mt-6 px-4 space-y-1">
                  <p>
                    {status === "ready"
                      ? `Say hello to ${title}. It answers from its own computer, so replies can take a little while.`
                      : statusMsg.text}
                  </p>
                  {statusMsg.why && <p className="text-[10px] text-red-500 break-words">{statusMsg.why}</p>}
                </div>
              ) : messages.map((m) => (
                <div key={m.seq} className={cn("flex", m.from === "me" ? "justify-end" : "justify-start")}>
                  <div
                    className={cn("max-w-[85%] rounded-lg px-2 py-1 whitespace-pre-wrap break-words",
                      m.from === "me" ? "bg-[var(--accent-primary)] text-white" : "bg-[var(--background-surface)] border border-[var(--border)]")}
                  >
                    {m.text}
                  </div>
                </div>
              ))}
            </div>
            <div className="shrink-0 border-t border-[var(--border)] p-2 space-y-1">
              <div className="flex gap-1">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                  placeholder={`Message ${title}`}
                  disabled={status !== "ready"}
                  className={inputClass}
                />
                <Button size="sm" className="nodrag h-7 px-2" onClick={handleSend} disabled={sending || !draft.trim() || status !== "ready"} title="Send">
                  {sending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                </Button>
              </div>
              <div className="text-[10px] text-[var(--foreground-muted)]">
                Connect this block to a terminal to let it use {title} (for example, to seat it at a PokerBench table).
              </div>
            </div>
          </>
        )}
      </div>
      <ConnectionHandles nodeId={id} visible={connectorsVisible} onConnectorClick={data.onConnectorClick} />
    </BlockWrapper>
  );
}
