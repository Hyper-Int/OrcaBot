"use client";

// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: egress-dialog-v3-request-id-resolution
const EGRESS_DIALOG_REVISION = "egress-dialog-v3-request-id-resolution";
console.log(`[EgressApprovalDialog] REVISION: ${EGRESS_DIALOG_REVISION} loaded at ${new Date().toISOString()}`);

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Shield, Globe, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { approveEgress, type EgressDecision } from "@/lib/api/cloudflare/egress";

interface EgressApprovalRequest {
  domain: string;
  port: number;
  request_id: string;
}

interface EgressApprovalDialogProps {
  dashboardId: string;
  pending: EgressApprovalRequest[];
  onResolved: (requestId: string) => void;
}

export function EgressApprovalDialog({
  dashboardId,
  pending,
  onResolved,
}: EgressApprovalDialogProps) {
  const [submitting, setSubmitting] = useState<string | null>(null);

  const current = pending[0];
  if (!current) return null;

  const handleDecision = async (decision: EgressDecision) => {
    setSubmitting(decision);
    try {
      await approveEgress(dashboardId, current.domain, decision, current.request_id, current.port);

      const labels: Record<EgressDecision, string> = {
        allow_once: "Allowed once",
        allow_always: "Always allowed",
        deny: "Denied",
      };
      toast.success(`${labels[decision]}: ${current.domain}`);
      onResolved(current.request_id);
    } catch (err) {
      toast.error(`Failed to submit decision: ${err}`);
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <Dialog open={pending.length > 0} onOpenChange={() => {}}>
      <DialogContent className="sm:max-w-md" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogTitle className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-yellow-500" />
          Network Access Request
        </DialogTitle>

        <div className="space-y-4">
          <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50 border">
            <Globe className="w-8 h-8 text-muted-foreground flex-shrink-0" />
            <div className="min-w-0">
              <p className="font-mono text-sm font-medium truncate">{current.domain}</p>
              <p className="text-xs text-muted-foreground">Port {current.port}</p>
            </div>
          </div>

          <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
            <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-muted-foreground">
              An agent is trying to connect to this domain. The connection is held
              until you approve or deny. If you don&apos;t respond within 60 seconds,
              the connection will be denied automatically.
            </p>
          </div>

          {pending.length > 1 && (
            <p className="text-xs text-muted-foreground text-center">
              +{pending.length - 1} more pending {pending.length - 1 === 1 ? "request" : "requests"}
            </p>
          )}

          <div className="flex gap-2 justify-end">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleDecision("deny")}
              disabled={submitting !== null}
            >
              Deny
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleDecision("allow_once")}
              disabled={submitting !== null}
            >
              Allow Once
            </Button>
            <Button
              size="sm"
              onClick={() => handleDecision("allow_always")}
              disabled={submitting !== null}
            >
              Always Allow
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
