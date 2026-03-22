"use client";

// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: egress-allowlist-panel-v2-canonical-defaults
const PANEL_REVISION = "egress-allowlist-panel-v2-canonical-defaults";
console.log(`[EgressAllowlistPanel] REVISION: ${PANEL_REVISION} loaded at ${new Date().toISOString()}`);

import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Shield, Trash2, Loader2, Globe, ChevronDown, ChevronRight, ShieldOff, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  listEgressAllowlist,
  revokeEgressDomain,
  blockDefaultDomain,
  unblockDefaultDomain,
  type EgressAllowlistEntry,
  type EgressDefaultEntry,
} from "@/lib/api/cloudflare/egress";

interface EgressAllowlistPanelProps {
  dashboardId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EgressAllowlistPanel({
  dashboardId,
  open,
  onOpenChange,
}: EgressAllowlistPanelProps) {
  const [entries, setEntries] = useState<EgressAllowlistEntry[]>([]);
  const [defaults, setDefaults] = useState<EgressDefaultEntry[]>([]);
  const [blockedPatterns, setBlockedPatterns] = useState<Set<string>>(new Set());
  const [defaultsExpanded, setDefaultsExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [overriding, setOverriding] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listEgressAllowlist(dashboardId);
      setEntries(result.entries);
      setDefaults(result.defaults);
      setBlockedPatterns(new Set(result.blocked));
    } catch {
      // Keep current state on error
    } finally {
      setLoading(false);
    }
  }, [dashboardId]);

  useEffect(() => {
    if (open) {
      void refresh();
    }
  }, [open, refresh]);

  const handleRevoke = async (entry: EgressAllowlistEntry) => {
    setRevoking(entry.id);
    try {
      await revokeEgressDomain(dashboardId, entry.id);
      setEntries(prev => prev.filter(e => e.id !== entry.id));
      toast.success(`Revoked: ${entry.domain}`);
    } catch (err) {
      toast.error(`Failed to revoke: ${err}`);
    } finally {
      setRevoking(null);
    }
  };

  const handleBlockDefault = async (pattern: string) => {
    setOverriding(pattern);
    try {
      await blockDefaultDomain(dashboardId, pattern);
      setBlockedPatterns((prev) => new Set([...prev, pattern]));
      toast.success(`Overridden: ${pattern} will now require approval`);
    } catch (err) {
      toast.error(`Failed to override: ${err}`);
    } finally {
      setOverriding(null);
    }
  };

  const handleUnblockDefault = async (pattern: string) => {
    setOverriding(pattern);
    try {
      await unblockDefaultDomain(dashboardId, pattern);
      setBlockedPatterns((prev) => {
        const next = new Set(prev);
        next.delete(pattern);
        return next;
      });
      toast.success(`Restored: ${pattern} is auto-allowed again`);
    } catch (err) {
      toast.error(`Failed to restore: ${err}`);
    } finally {
      setOverriding(null);
    }
  };

  const sortedDefaults = [...defaults].sort((a, b) => {
    const aBlocked = blockedPatterns.has(a.pattern) ? 0 : 1;
    const bBlocked = blockedPatterns.has(b.pattern) ? 0 : 1;
    return aBlocked - bBlocked || a.pattern.localeCompare(b.pattern);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle className="flex items-center gap-2">
          <Shield className="w-5 h-5" />
          Network Allowlist
        </DialogTitle>

        <div className="space-y-4">
          <div className="space-y-1">
            <button
              className="flex w-full items-center gap-2 text-sm font-medium text-foreground hover:text-foreground/80 transition-colors"
              onClick={() => setDefaultsExpanded((value) => !value)}
              type="button"
            >
              {defaultsExpanded ? (
                <ChevronDown className="w-4 h-4 flex-shrink-0" />
              ) : (
                <ChevronRight className="w-4 h-4 flex-shrink-0" />
              )}
              Built-in domains
              <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground font-mono">
                {defaults.length}
              </span>
              {blockedPatterns.size > 0 && (
                <span className="rounded-full bg-orange-500/15 px-2 py-0.5 text-xs text-orange-600 dark:text-orange-400 font-mono">
                  {blockedPatterns.size} overridden
                </span>
              )}
            </button>

            {defaultsExpanded && (
              <div className="mt-1 space-y-1 max-h-48 overflow-y-auto rounded-md border bg-muted/30 p-1">
                {loading ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                  </div>
                ) : sortedDefaults.length === 0 ? (
                  <div className="text-center py-4 text-xs text-muted-foreground">
                    No built-in domains loaded yet.
                  </div>
                ) : (
                  sortedDefaults.map((entry) => {
                    const isBlocked = blockedPatterns.has(entry.pattern);
                    const isBusy = overriding === entry.pattern;
                    return (
                      <div
                        key={entry.pattern}
                        className={`group flex items-center justify-between gap-2 px-2 py-1.5 rounded-sm ${
                          isBlocked
                            ? "bg-orange-500/10 border border-orange-500/20"
                            : "hover:bg-muted/60"
                        }`}
                        title={entry.rationale}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          {isBlocked ? (
                            <ShieldOff className="w-3.5 h-3.5 text-orange-500 flex-shrink-0" />
                          ) : (
                            <Globe className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className={`font-mono text-xs truncate ${isBlocked ? "text-orange-600 dark:text-orange-400" : "text-foreground/80"}`}>
                              {entry.pattern}
                            </div>
                            <div className="text-[10px] text-muted-foreground truncate">
                              {entry.label}
                            </div>
                          </div>
                        </div>
                        {isBlocked ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleUnblockDefault(entry.pattern)}
                            disabled={isBusy}
                            className="flex-shrink-0 h-6 px-2 text-xs text-orange-600 dark:text-orange-400 hover:text-foreground hover:bg-muted"
                          >
                            {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <><ShieldCheck className="w-3 h-3 mr-1" />Restore</>}
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleBlockDefault(entry.pattern)}
                            disabled={isBusy}
                            className="flex-shrink-0 h-6 px-2 text-xs text-muted-foreground hover:text-destructive hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <><ShieldOff className="w-3 h-3 mr-1" />Override</>}
                          </Button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Common registries, git hosts, LLM APIs, and provider domains are auto-approved. Override a pattern to require approval again.
            </p>
          </div>

          <div className="space-y-1">
            <p className="text-sm font-medium">
              User-approved domains
            </p>
            <p className="text-xs text-muted-foreground">
              Domains approved via &quot;Always Allow&quot;. Agents can connect to these without prompting.
              Revoke to require approval again.
            </p>

            {loading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              </div>
            ) : entries.length === 0 ? (
              <div className="text-center py-6 text-sm text-muted-foreground">
                No user-approved domains yet.
              </div>
            ) : (
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {entries.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-muted/50 border"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Globe className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                      <span className="font-mono text-xs truncate">{entry.domain}</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleRevoke(entry)}
                      disabled={revoking !== null}
                      className="flex-shrink-0 text-muted-foreground hover:text-destructive"
                    >
                      {revoking === entry.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="w-3.5 h-3.5" />
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
