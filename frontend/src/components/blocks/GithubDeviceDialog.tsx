// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
"use client";

// REVISION: github-device-dialog-v1
import * as React from "react";
import { Loader2, ExternalLink, Copy, Check, AlertCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { startGithubDevice, pollGithubDevice } from "@/lib/api/cloudflare/integrations";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dashboardId?: string;
  /** Called once GitHub reports the flow complete (token stored). */
  onConnected: () => void;
}

type Phase = "starting" | "waiting" | "connected" | "error";

/**
 * Desktop GitHub connect via the OAuth **device flow** (public client, no secret,
 * no redirect): show a user code, the user enters it at github.com/login/device,
 * and we poll the control plane until it reports the token stored.
 */
export function GithubDeviceDialog({ open, onOpenChange, dashboardId, onConnected }: Props) {
  const [phase, setPhase] = React.useState<Phase>("starting");
  const [userCode, setUserCode] = React.useState("");
  const [verificationUri, setVerificationUri] = React.useState("https://github.com/login/device");
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const stateRef = React.useRef<string | null>(null);
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = React.useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const begin = React.useCallback(async () => {
    stopPolling();
    setPhase("starting");
    setError(null);
    setUserCode("");
    try {
      const res = await startGithubDevice(dashboardId);
      stateRef.current = res.state;
      setUserCode(res.user_code);
      setVerificationUri(res.verification_uri || "https://github.com/login/device");
      setPhase("waiting");
      const intervalMs = Math.max(2, res.interval || 5) * 1000;
      pollRef.current = setInterval(async () => {
        const st = stateRef.current;
        if (!st) return;
        try {
          const p = await pollGithubDevice(st);
          if (p.status === "complete") {
            stopPolling();
            setPhase("connected");
            onConnected();
            setTimeout(() => onOpenChange(false), 800);
          } else if (p.status === "error") {
            stopPolling();
            setError(
              p.error === "expired"
                ? "The code expired — start again."
                : p.error === "denied"
                ? "Authorization was denied."
                : "GitHub authorization failed."
            );
            setPhase("error");
          }
          // pending / slow_down: keep waiting
        } catch {
          // transient poll error — keep waiting
        }
      }, intervalMs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start GitHub sign-in.");
      setPhase("error");
    }
  }, [dashboardId, onConnected, onOpenChange, stopPolling]);

  // Start when opened; always clean up the poller when closed/unmounted.
  React.useEffect(() => {
    if (open) void begin();
    return () => stopPolling();
  }, [open, begin, stopPolling]);

  const copyCode = React.useCallback(() => {
    if (!userCode) return;
    void navigator.clipboard?.writeText(userCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [userCode]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) stopPolling();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect GitHub</DialogTitle>
          <DialogDescription>
            Enter this code at GitHub to authorize Orcabot.
          </DialogDescription>
        </DialogHeader>

        {phase === "starting" && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Starting…
          </div>
        )}

        {(phase === "waiting" || phase === "connected") && (
          <div className="space-y-4 py-2">
            <button
              type="button"
              onClick={copyCode}
              className="w-full flex items-center justify-center gap-3 rounded-lg border py-3 font-mono text-2xl tracking-[0.3em] hover:bg-muted/50"
              title="Copy code"
            >
              {userCode || "········"}
              {copied ? (
                <Check className="w-4 h-4 text-green-500" />
              ) : (
                <Copy className="w-4 h-4 opacity-60" />
              )}
            </button>
            <Button
              className="w-full"
              onClick={() => window.open(verificationUri, "_blank", "noopener,noreferrer")}
            >
              <ExternalLink className="w-4 h-4 mr-2" /> Open github.com/login/device
            </Button>
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              {phase === "connected" ? (
                <>
                  <Check className="w-4 h-4 text-green-500" /> Connected!
                </>
              ) : (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Waiting for authorization…
                </>
              )}
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="space-y-4 py-2">
            <div className="flex items-start gap-2 text-sm text-red-500">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-none" />
              <span>{error}</span>
            </div>
            <Button className="w-full" variant="secondary" onClick={() => void begin()}>
              Try again
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
