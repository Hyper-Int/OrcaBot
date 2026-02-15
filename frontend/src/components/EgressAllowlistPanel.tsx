"use client";

// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: egress-allowlist-panel-v1
const PANEL_REVISION = "egress-allowlist-panel-v1";
console.log(`[EgressAllowlistPanel] REVISION: ${PANEL_REVISION} loaded at ${new Date().toISOString()}`);

import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Shield, Trash2, Loader2, Globe } from "lucide-react";
import { toast } from "sonner";
import { listEgressAllowlist, revokeEgressDomain, type EgressAllowlistEntry } from "@/lib/api/cloudflare/egress";

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
  const [loading, setLoading] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listEgressAllowlist(dashboardId);
      setEntries(result);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle className="flex items-center gap-2">
          <Shield className="w-5 h-5" />
          Network Allowlist
        </DialogTitle>

        <div className="space-y-3">
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
            <div className="space-y-1 max-h-64 overflow-y-auto">
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
      </DialogContent>
    </Dialog>
  );
}
