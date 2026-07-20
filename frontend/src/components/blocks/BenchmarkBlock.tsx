// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: benchmark-block-v1-config-panel

"use client";

const BENCHMARK_BLOCK_REVISION = "benchmark-block-v1-config-panel";
if (typeof window !== "undefined" && !(window as unknown as { __benchmarkBlockLogged?: boolean }).__benchmarkBlockLogged) {
  (window as unknown as { __benchmarkBlockLogged?: boolean }).__benchmarkBlockLogged = true;
  console.log(`[BenchmarkBlock] REVISION: ${BENCHMARK_BLOCK_REVISION} loaded at ${new Date().toISOString()}`);
}

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import { FlaskConical, Play, X, Minimize2, Settings, Copy, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";
import { MinimizedBlockView, MINIMIZED_SIZE } from "./MinimizedBlockView";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui";
import { useDebouncedCallback } from "@/hooks/useDebounce";
import { BlockSettingsFooter } from "./BlockSettingsFooter";
import { writeSessionFile, readSessionFileText } from "@/lib/api/cloudflare/files";
import catalog from "@/data/openrouter-models.json";
import type { DashboardItem, BenchmarkContent } from "@/types/dashboard";

// Slop-code harnesses (from the fork's agent_runner/agents dir).
const HARNESSES = ["opencode", "claude_code", "codex", "gemini", "kimi_cli", "cursor_cli", "openhands", "miniswe", "pi"];
const PROBLEMS_KNOWN = ["file_backup", "etl_pipeline", "layered_config_synthesizer"];
const PROMPTS = ["just-solve", "plan_first", "anti_slop", "plan-and-test"];
const THINKING = ["low", "medium", "high"] as const;
// Public agent-skill packs. Every skill now runs in the Orcabot VM (local envs);
// scb-matrix clones each skill's public plugin repo and stages it into the run.
const SKILLS = ["baseline", "gsd", "omc", "superpowers", "karpathy", "addyosmani"];

// Model suggestions: the validated arms + the OpenRouter catalog (routed via the
// broker, so prefixed openrouter/). The field also accepts free-typed ids.
const MODEL_SUGGESTIONS = Array.from(new Set([
  "openrouter/kimi-k2.6",
  "openrouter/z-ai/glm-4.6",
  ...((catalog as { models: { id: string }[] }).models || []).map((m) => `openrouter/${m.id}`),
]));

const DEFAULT_CONFIG: BenchmarkContent = {
  harnesses: ["opencode"],
  skills: ["baseline"],
  models: ["openrouter/kimi-k2.6"],
  problems: [],
  workers: 1,
  prompt: "just-solve",
  thinking: "low",
  evaluate: false,
  codexAuth: "broker",
};

function parseConfig(content: string): BenchmarkContent {
  try {
    const p = JSON.parse(content || "{}");
    return {
      harnesses: Array.isArray(p.harnesses) && p.harnesses.length ? p.harnesses : DEFAULT_CONFIG.harnesses,
      skills: Array.isArray(p.skills) && p.skills.length ? p.skills : DEFAULT_CONFIG.skills,
      models: Array.isArray(p.models) && p.models.length ? p.models : DEFAULT_CONFIG.models,
      problems: Array.isArray(p.problems) && p.problems.length ? p.problems : DEFAULT_CONFIG.problems,
      workers: Number.isFinite(p.workers) && p.workers > 0 ? Math.min(8, Math.floor(p.workers)) : 1,
      prompt: typeof p.prompt === "string" ? p.prompt : DEFAULT_CONFIG.prompt,
      thinking: THINKING.includes(p.thinking) ? p.thinking : DEFAULT_CONFIG.thinking,
      evaluate: p.evaluate === true,
      codexAuth: p.codexAuth === "subscription" ? "subscription" : "broker",
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// Minimal YAML subset for /workspace/.scb-config.yaml (matches scb-matrix's format).
function toYaml(c: BenchmarkContent): string {
  return [
    "# SlopCodeBench run config — written by the config panel (also edited by chat).",
    `harnesses: [${c.harnesses.join(", ")}]`,
    `models: [${c.models.join(", ")}]`,
    `skills: [${c.skills.join(", ")}]`,
    `problems: [${c.problems.join(", ")}]`,
    `workers: ${c.workers}`,
    `prompt: ${c.prompt}`,
    `thinking: ${c.thinking}`,
    `evaluate: ${c.evaluate}`,
    `codex_auth: ${c.codexAuth ?? "broker"}`,
    "",
  ].join("\n");
}

function fromYaml(text: string): Partial<BenchmarkContent> {
  const out: Record<string, unknown> = {};
  for (const raw of text.split("\n")) {
    const line = raw.split("#", 1)[0].trim();
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (val.startsWith("[") && val.endsWith("]")) {
      out[key] = val.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (val !== "") {
      out[key] = val;
    }
  }
  return {
    harnesses: out.harnesses as string[] | undefined,
    skills: out.skills as string[] | undefined,
    models: out.models as string[] | undefined,
    problems: out.problems as string[] | undefined,
    workers: out.workers != null ? Number(out.workers) : undefined,
    prompt: out.prompt as string | undefined,
    thinking: out.thinking as BenchmarkContent["thinking"] | undefined,
    evaluate: out.evaluate != null ? String(out.evaluate) === "true" : undefined,
    codexAuth: out.codex_auth === "subscription" ? "subscription" : out.codex_auth === "broker" ? "broker" : undefined,
  };
}

function buildBootCommand(c: BenchmarkContent): string {
  const q = (s: string) => (/^[\w./:-]+$/.test(s) ? s : `'${s.replace(/'/g, "")}'`);
  const flags: string[] = [];
  for (const h of c.harnesses) flags.push("--harness", q(h));
  for (const m of c.models) flags.push("--model", q(m));
  for (const s of c.skills) flags.push("--skill", q(s));
  for (const p of c.problems) flags.push("--problem", q(p));
  flags.push("--workers", String(c.workers), "--thinking", c.thinking, "--prompt", q(c.prompt));
  if (c.evaluate) flags.push("--evaluate");
  if (c.codexAuth === "subscription") flags.push("--codex-auth", "subscription");
  const matrix = `bin/scb-matrix ${flags.join(" ")}`;
  return (
    "cd /workspace/slop-code-bench; " +
    "SCB_LIVE_PORT=8051 nohup bin/scb-live >/workspace/.scb-live.log 2>&1 & " +
    "nohup bin/scb-visualize watch --skip-existing >/workspace/.scb-viz.log 2>&1 & " +
    matrix + "; echo '[matrix done]'; exec bash"
  );
}

interface BenchmarkData extends Record<string, unknown> {
  content: string;
  size: { width: number; height: number };
  metadata?: { minimized?: boolean; expandedSize?: { width: number; height: number }; [key: string]: unknown };
  /** Sandbox session id (for reading/writing /workspace/.scb-config.yaml). */
  sessionId?: string;
  /** Create a terminal that runs bootCommand (same path the chat's create_terminal uses). */
  onCreateTerminal?: (name: string, bootCommand: string) => void;
  onContentChange?: (content: string) => void;
  onItemChange?: (changes: Partial<DashboardItem>) => void;
  onDuplicate?: () => void;
  connectorMode?: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
}

type BenchmarkNode = Node<BenchmarkData, "benchmark">;

// A removable-chip list with an add input + datalist suggestions.
function TokenList({ label, values, onChange, suggestions, placeholder }: {
  label: string; values: string[]; onChange: (v: string[]) => void; suggestions: string[]; placeholder: string;
}) {
  const [draft, setDraft] = React.useState("");
  const listId = React.useId();
  const add = (v: string) => {
    const t = v.trim();
    if (t && !values.includes(t)) onChange([...values, t]);
    setDraft("");
  };
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium text-[var(--foreground-muted)]">{label}</div>
      <div className="flex flex-wrap gap-1">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded bg-[var(--background-surface)] border border-[var(--border)] px-1.5 py-0.5 text-[11px]">
            {v}
            <button type="button" className="nodrag opacity-60 hover:opacity-100" onClick={() => onChange(values.filter((x) => x !== v))} title="Remove">
              <X className="w-2.5 h-2.5" />
            </button>
          </span>
        ))}
      </div>
      <input
        list={listId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(draft); } }}
        onBlur={() => draft && add(draft)}
        placeholder={placeholder}
        className="nodrag w-full text-[11px] bg-[var(--background)] border border-[var(--border)] rounded px-1.5 py-1 focus:outline-none focus:border-[var(--border-focus)]"
      />
      <datalist id={listId}>
        {suggestions.filter((s) => !values.includes(s)).map((s) => <option key={s} value={s} />)}
      </datalist>
    </div>
  );
}

export function BenchmarkBlock({ id, data, selected }: NodeProps<BenchmarkNode>) {
  const initial = React.useMemo(() => parseConfig(data.content), [data.content]);
  const [cfg, setCfg] = React.useState<BenchmarkContent>(initial);
  const [running, setRunning] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);
  const connectorsVisible = selected || Boolean(data.connectorMode);
  const isMinimized = data.metadata?.minimized === true;
  const [expandAnimation, setExpandAnimation] = React.useState<string | null>(null);
  const [isAnimatingMinimize, setIsAnimatingMinimize] = React.useState(false);
  const syncedRef = React.useRef(false);

  const persist = useDebouncedCallback((c: BenchmarkContent) => {
    data.onContentChange?.(JSON.stringify(c));
  }, 500);

  const update = (patch: Partial<BenchmarkContent>) => {
    setCfg((prev) => {
      const next = { ...prev, ...patch };
      persist(next);
      return next;
    });
  };

  // Sync from server-persisted content.
  React.useEffect(() => { setCfg(parseConfig(data.content)); }, [data.content]);

  // On first mount with a live session, sync from /workspace/.scb-config.yaml so the
  // panel reflects whatever the chat last set (shared source of truth).
  React.useEffect(() => {
    if (syncedRef.current || !data.sessionId) return;
    syncedRef.current = true;
    readSessionFileText(data.sessionId, ".scb-config.yaml").then((text) => {
      if (!text) return;
      const y = fromYaml(text);
      setCfg((prev) => {
        const merged: BenchmarkContent = {
          harnesses: y.harnesses?.length ? y.harnesses : prev.harnesses,
          skills: y.skills?.length ? y.skills : prev.skills,
          models: y.models?.length ? y.models : prev.models,
          problems: y.problems?.length ? y.problems : prev.problems,
          workers: y.workers && y.workers > 0 ? y.workers : prev.workers,
          prompt: y.prompt || prev.prompt,
          thinking: y.thinking || prev.thinking,
          evaluate: y.evaluate ?? prev.evaluate,
          codexAuth: y.codexAuth ?? prev.codexAuth,
        };
        data.onContentChange?.(JSON.stringify(merged));
        return merged;
      });
    });
  }, [data.sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const arms = cfg.harnesses.length * cfg.models.length * cfg.skills.length;
  const canRun = cfg.harnesses.length > 0 && cfg.models.length > 0 && cfg.skills.length > 0 && cfg.problems.length > 0;

  const handleRun = async () => {
    if (!canRun) { setStatus("Pick ≥1 harness, model, and problem."); return; }
    setRunning(true);
    setStatus(null);
    try {
      if (data.sessionId) {
        await writeSessionFile(data.sessionId, ".scb-config.yaml", toYaml(cfg)).catch(() => false);
      }
      data.onCreateTerminal?.("benchmark runner", buildBootCommand(cfg));
      setStatus(`Launched ${arms} arm${arms === 1 ? "" : "s"} — watch the results browser.`);
    } finally {
      setRunning(false);
    }
  };

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
    data.onItemChange?.({ metadata: { ...data.metadata, minimized: false }, size: saved || { width: 320, height: 460 } });
  };

  if (isMinimized && !isAnimatingMinimize) {
    return (
      <MinimizedBlockView
        nodeId={id}
        selected={selected}
        icon={<FlaskConical className="w-14 h-14 text-[var(--accent-primary)]" />}
        label={`Benchmark (${arms} arm${arms === 1 ? "" : "s"})`}
        onExpand={handleExpand}
        connectorsVisible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
    );
  }

  return (
    <BlockWrapper selected={selected} className={cn("p-0 flex flex-col overflow-visible", expandAnimation)} includeHandles={false}>
      <div className={cn("flex flex-col flex-1 overflow-hidden", isAnimatingMinimize && "animate-content-fade-out")}>
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] shrink-0">
          <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--foreground)]">
            <FlaskConical className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
            Benchmark
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-[var(--foreground-muted)]">{arms} arm{arms === 1 ? "" : "s"}</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="nodrag h-5 w-5" title="Settings">
                  <Settings className="w-3 h-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36">
                <DropdownMenuItem onClick={() => data.onDuplicate?.()} className="gap-2">
                  <Copy className="w-3 h-3" /><span>Duplicate</span>
                </DropdownMenuItem>
                <BlockSettingsFooter nodeId={id} onMinimize={handleMinimize} />
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="ghost" size="icon-sm" className="nodrag h-5 w-5" title="Minimize" onClick={handleMinimize}>
              <Minimize2 className="w-3 h-3" />
            </Button>
          </div>
        </div>

        {/* Body / form */}
        <div className="flex-1 overflow-auto p-3 space-y-3">
          {/* Harnesses */}
          <div className="space-y-1">
            <div className="text-[11px] font-medium text-[var(--foreground-muted)]">Harnesses</div>
            <div className="flex flex-wrap gap-1">
              {HARNESSES.map((h) => {
                const on = cfg.harnesses.includes(h);
                return (
                  <button
                    key={h}
                    type="button"
                    onClick={() => update({ harnesses: on ? cfg.harnesses.filter((x) => x !== h) : [...cfg.harnesses, h] })}
                    className={cn(
                      "nodrag rounded px-1.5 py-0.5 text-[11px] border transition-colors",
                      on
                        ? "bg-[var(--accent-primary)]/15 border-[var(--accent-primary)] text-[var(--foreground)]"
                        : "bg-[var(--background-surface)] border-[var(--border)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
                    )}
                  >
                    {h}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Skills (public agent-skill packs; all run in the sandbox VM) */}
          <div className="space-y-1">
            <div className="text-[11px] font-medium text-[var(--foreground-muted)]">Skills</div>
            <div className="flex flex-wrap gap-1">
              {SKILLS.map((s) => {
                const on = cfg.skills.includes(s);
                return (
                  <button
                    key={s}
                    type="button"
                    title="public agent-skill pack — cloned + staged into the run"
                    onClick={() => update({ skills: on ? cfg.skills.filter((x) => x !== s) : [...cfg.skills, s] })}
                    className={cn(
                      "nodrag rounded px-1.5 py-0.5 text-[11px] border transition-colors",
                      on
                        ? "bg-[var(--accent-primary)]/15 border-[var(--accent-primary)] text-[var(--foreground)]"
                        : "bg-[var(--background-surface)] border-[var(--border)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
                    )}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </div>

          <TokenList label="Models" values={cfg.models} suggestions={MODEL_SUGGESTIONS}
            placeholder="add model (e.g. openrouter/kimi-k2.6)…" onChange={(v) => update({ models: v })} />
          <TokenList label="Problems" values={cfg.problems} suggestions={PROBLEMS_KNOWN}
            placeholder="add problem…" onChange={(v) => update({ problems: v })} />

          <div className="grid grid-cols-3 gap-2">
            <label className="space-y-1">
              <div className="text-[11px] font-medium text-[var(--foreground-muted)]">Workers</div>
              <input type="number" min={1} max={8} value={cfg.workers}
                onChange={(e) => update({ workers: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })}
                className="nodrag w-full text-[11px] bg-[var(--background)] border border-[var(--border)] rounded px-1.5 py-1 focus:outline-none focus:border-[var(--border-focus)]" />
            </label>
            <label className="space-y-1">
              <div className="text-[11px] font-medium text-[var(--foreground-muted)]">Thinking</div>
              <select value={cfg.thinking} onChange={(e) => update({ thinking: e.target.value as BenchmarkContent["thinking"] })}
                className="nodrag w-full text-[11px] bg-[var(--background)] border border-[var(--border)] rounded px-1.5 py-1 focus:outline-none">
                {THINKING.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <div className="text-[11px] font-medium text-[var(--foreground-muted)]">Prompt</div>
              <select value={cfg.prompt} onChange={(e) => update({ prompt: e.target.value })}
                className="nodrag w-full text-[11px] bg-[var(--background)] border border-[var(--border)] rounded px-1.5 py-1 focus:outline-none">
                {PROMPTS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          </div>

          <label className="flex items-center gap-2 text-[11px] text-[var(--foreground-muted)]">
            <input type="checkbox" className="nodrag" checked={cfg.evaluate} onChange={(e) => update({ evaluate: e.target.checked })} />
            Evaluate (score the run, not just inference)
          </label>

          {/* Codex auth: broker (API key) vs subscription (codex login). Only relevant when codex is selected. */}
          {cfg.harnesses.includes("codex") && (
            <label className="flex items-center gap-2 text-[11px] text-[var(--foreground-muted)]">
              <input
                type="checkbox"
                className="nodrag"
                checked={cfg.codexAuth === "subscription"}
                onChange={(e) => update({ codexAuth: e.target.checked ? "subscription" : "broker" })}
              />
              <span title="Uses ~/.codex/auth.json (codex login) instead of a brokered API key. The credential lives in the VM — readable by the agent-under-test.">
                Codex: use my subscription (codex login) ⚠
              </span>
            </label>
          )}

          <div className="text-[11px] text-[var(--foreground-muted)]">
            <b className="text-[var(--foreground)]">{arms}</b> arm{arms === 1 ? "" : "s"} ({cfg.harnesses.length}h × {cfg.models.length}m × {cfg.skills.length}s)
            {" × "}<b className="text-[var(--foreground)]">{cfg.problems.length}</b> problem{cfg.problems.length === 1 ? "" : "s"}
          </div>
        </div>

        {/* Footer / Run */}
        <div className="shrink-0 border-t border-[var(--border)] p-2 flex items-center gap-2">
          <Button size="sm" className="nodrag h-7 text-xs flex-1" disabled={!canRun || running} onClick={handleRun}>
            {running ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Play className="w-3 h-3 mr-1" />}
            Run benchmark
          </Button>
        </div>
        {status && <div className="px-3 pb-2 text-[10px] text-[var(--foreground-muted)]">{status}</div>}
      </div>
      <ConnectionHandles nodeId={id} visible={connectorsVisible} onConnectorClick={data.onConnectorClick} />
    </BlockWrapper>
  );
}
