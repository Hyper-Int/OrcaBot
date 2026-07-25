// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: pat-panel-v1
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Copy, KeyRound, Loader2, Trash2 } from "lucide-react";

import {
  listApiTokens,
  mintApiToken,
  revokeApiToken,
  type ApiToken,
  type MintedApiToken,
} from "@/lib/api/cloudflare/api-tokens";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const MODULE_REVISION = "pat-panel-v1";
if (typeof window !== "undefined") {
  console.log(`[pat-panel] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

function formatDate(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function PersonalAccessTokensPanel() {
  const queryClient = useQueryClient();
  const [newName, setNewName] = React.useState("");
  const [minted, setMinted] = React.useState<MintedApiToken | null>(null);
  const [copied, setCopied] = React.useState(false);

  const {
    data: tokens = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["api-tokens"],
    queryFn: listApiTokens,
  });

  const mintMutation = useMutation({
    mutationFn: (name: string) => mintApiToken(name),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
      setMinted(data);
      setCopied(false);
      setNewName("");
    },
    onError: (err) => toast.error(`Failed to create token: ${(err as Error).message}`),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeApiToken(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["api-tokens"] });
      toast.success("Token revoked");
    },
    onError: (err) => toast.error(`Failed to revoke token: ${(err as Error).message}`),
  });

  const copyToken = async () => {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.token);
      setCopied(true);
      toast.success("Token copied to clipboard");
    } catch {
      toast.error("Could not copy — select and copy manually");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--foreground)]">
            <KeyRound className="h-5 w-5" /> Personal Access Tokens
          </h2>
          <p className="mt-1 text-sm text-[var(--foreground-muted)]">
            Authenticate the <code className="font-mono">orcabot</code> CLI to this account for{" "}
            <code className="font-mono">push</code>/<code className="font-mono">pull</code>. A token
            carries your full account access — treat it like a password.
          </p>
        </div>
      </div>

      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          mintMutation.mutate(newName.trim() || "cli");
        }}
      >
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Token name (e.g. laptop)"
          className="max-w-xs"
          disabled={mintMutation.isPending}
        />
        <Button type="submit" isLoading={mintMutation.isPending} leftIcon={<KeyRound className="h-4 w-4" />}>
          Create token
        </Button>
      </form>

      <div className="rounded-[var(--radius-button)] border border-[var(--border)]">
        {isLoading ? (
          <div className="flex items-center gap-2 p-4 text-sm text-[var(--foreground-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : isError ? (
          <div className="p-4 text-sm text-[var(--status-error)]">Could not load tokens.</div>
        ) : tokens.length === 0 ? (
          <div className="p-4 text-sm text-[var(--foreground-muted)]">No tokens yet.</div>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {tokens.map((t: ApiToken) => (
              <li key={t.id} className="flex items-center justify-between gap-4 p-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-[var(--foreground)]">{t.name}</p>
                  <p className="text-xs text-[var(--foreground-muted)]">
                    Created {formatDate(t.createdAt)} · Last used {formatDate(t.lastUsedAt)}
                    {t.expiresAt ? ` · Expires ${formatDate(t.expiresAt)}` : ""}
                  </p>
                </div>
                <Button
                  variant="danger"
                  size="sm"
                  leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                  isLoading={revokeMutation.isPending && revokeMutation.variables === t.id}
                  onClick={() => {
                    if (confirm(`Revoke token "${t.name}"? The CLI using it will stop working.`)) {
                      revokeMutation.mutate(t.id);
                    }
                  }}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* One-time reveal of the freshly minted token */}
      <Dialog open={!!minted} onOpenChange={(open) => !open && setMinted(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Copy your new token</DialogTitle>
            <DialogDescription>
              This is the only time the token is shown. Store it somewhere safe — you can&apos;t
              retrieve it again.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded bg-[var(--background-muted)] px-2 py-1.5 font-mono text-xs">
                {minted?.token}
              </code>
              <Button
                variant="secondary"
                size="icon"
                onClick={copyToken}
                title="Copy to clipboard"
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <div className="rounded bg-[var(--background-muted)] p-2 text-xs text-[var(--foreground-muted)]">
              <p className="mb-1">Use it with the CLI:</p>
              <code className="block whitespace-pre-wrap font-mono">
                orcabot push &lt;dashboard&gt; --remote {typeof window !== "undefined" ? window.location.origin : "https://app.orcabot.com"} --token {minted?.token ? minted.token.slice(0, 16) + "…" : "<token>"}
              </code>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setMinted(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
