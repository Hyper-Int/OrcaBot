"use client";

// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: restart-background-dialog-v1
const MODULE_REVISION = "restart-background-dialog-v1";
console.log(`[RestartBackgroundDialog] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import { Cpu } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { BackgroundProcess } from "@/lib/api/cloudflare/background-processes";

/**
 * Asked before a user restarts a terminal that has background processes: programs it
 * started that run on their own (daemons, servers), which a restart won't stop. The
 * user picks which to stop. Only for restarts the user asked for; automatic restarts
 * never ask.
 */
export interface RestartBackgroundDialogProps {
  open: boolean;
  terminalName: string;
  processes: BackgroundProcess[];
  busy: boolean;
  /** stop: the processes to stop first ([] = keep them all) */
  onRestart: (stop: BackgroundProcess[]) => void;
  onCancel: () => void;
}

function ago(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return "just now";
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** Parents before their children, children indented under a parent that is listed. */
function ordered(processes: BackgroundProcess[]): Array<{ p: BackgroundProcess; depth: number }> {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const kids = new Map<number, BackgroundProcess[]>();
  const roots: BackgroundProcess[] = [];
  for (const p of processes) {
    if (byPid.has(p.ppid) && p.ppid !== p.pid) {
      kids.set(p.ppid, [...(kids.get(p.ppid) || []), p]);
    } else {
      roots.push(p);
    }
  }
  const out: Array<{ p: BackgroundProcess; depth: number }> = [];
  const walk = (p: BackgroundProcess, depth: number) => {
    out.push({ p, depth });
    for (const k of kids.get(p.pid) || []) walk(k, Math.min(depth + 1, 3));
  };
  roots.forEach((r) => walk(r, 0));
  return out;
}

export function RestartBackgroundDialog({ open, terminalName, processes, busy, onRestart, onCancel }: RestartBackgroundDialogProps) {
  // Everything is selected to start with: the user unticks what should keep running.
  const [selected, setSelected] = React.useState<Set<number>>(new Set());
  React.useEffect(() => {
    if (open) setSelected(new Set(processes.map((p) => p.pid)));
  }, [open, processes]);

  const rows = React.useMemo(() => ordered(processes), [processes]);
  const toStop = processes.filter((p) => selected.has(p.pid));
  const anyEarlier = processes.some((p) => !p.fromCurrentRun);

  const toggle = (pid: number, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(pid);
      else next.delete(pid);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onCancel(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-[var(--foreground-muted)]" />
            Stop background processes too?
          </DialogTitle>
          <DialogDescription>
            Restarting {terminalName ? <strong>{terminalName}</strong> : "this terminal"} stops what runs in it.
            {processes.length === 1 ? " This program was" : " These programs were"} started from it but
            {processes.length === 1 ? " runs" : " run"} on {processes.length === 1 ? "its" : "their"} own,
            so {processes.length === 1 ? "it keeps" : "they keep"} going after a restart.
            {anyEarlier && " Ones from an earlier run still have that run's settings, which can confuse the restarted terminal."}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-72 overflow-y-auto rounded-md border border-[var(--border)] divide-y divide-[var(--border)]">
          {rows.map(({ p, depth }) => (
            <label
              key={p.pid}
              className="flex items-start gap-2.5 px-3 py-2 cursor-pointer hover:bg-[var(--background-hover)]"
              style={{ paddingLeft: `${12 + depth * 18}px` }}
            >
              <input
                type="checkbox"
                className="mt-0.5 w-3.5 h-3.5 accent-[var(--accent-primary)] flex-shrink-0"
                checked={selected.has(p.pid)}
                disabled={busy}
                onChange={(e) => toggle(p.pid, e.target.checked)}
                aria-label={`Stop ${p.name} (pid ${p.pid})`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium truncate">{p.name}</span>
                  {!p.fromCurrentRun && (
                    <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-[var(--status-warning)]/15 text-[var(--status-warning)]">
                      earlier run
                    </span>
                  )}
                </div>
                <div className="font-mono text-xs text-[var(--foreground-muted)] truncate" title={p.command}>
                  {p.command}
                </div>
                <div className="text-[11px] text-[var(--foreground-subtle,var(--foreground-muted))]">
                  pid {p.pid}{p.startedAt ? ` · started ${ago(p.startedAt)}` : ""}
                </div>
              </div>
            </label>
          ))}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="secondary" onClick={() => onRestart([])} disabled={busy}>
            Restart, keep {processes.length === 1 ? "it" : "them"}
          </Button>
          <Button variant="danger" onClick={() => onRestart(toStop)} disabled={busy || toStop.length === 0}>
            {busy ? "Stopping…" : `Stop ${toStop.length} and restart`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
