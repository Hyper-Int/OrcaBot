// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: asr-settings-v3-unified-secrets

"use client";

import * as React from "react";
import { Settings, Check, Loader2, Trash2, ShieldCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  useASRSettingsStore,
  ASR_PROVIDERS,
  type ASRProvider,
} from "@/stores/asr-settings-store";
import { saveASRKey, deleteASRKey } from "@/lib/api/cloudflare/asr";
import { useQueryClient } from "@tanstack/react-query";

interface ASRSettingsDialogProps {
  trigger?: React.ReactNode;
  /** Controlled open state (optional — uses internal state if not provided) */
  open?: boolean;
  /** Controlled open change handler */
  onOpenChange?: (open: boolean) => void;
}

export function ASRSettingsDialog({ trigger, open: controlledOpen, onOpenChange }: ASRSettingsDialogProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = isControlled ? (onOpenChange ?? (() => {})) : setInternalOpen;
  const queryClient = useQueryClient();
  const provider = useASRSettingsStore((s) => s.provider);
  const setProvider = useASRSettingsStore((s) => s.setProvider);
  const isKeyConfigured = useASRSettingsStore((s) => s.isKeyConfigured);
  const refreshKeyStatus = useASRSettingsStore((s) => s.refreshKeyStatus);
  const keyStatusLoading = useASRSettingsStore((s) => s.keyStatusLoading);

  // Key input state (for adding new keys — value never stored client-side)
  const [keyInputs, setKeyInputs] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState<Record<string, boolean>>({});
  const [deleting, setDeleting] = React.useState<Record<string, boolean>>({});
  const [saveError, setSaveError] = React.useState<Record<string, string>>({});

  // Refresh key status when dialog opens
  React.useEffect(() => {
    if (open) {
      refreshKeyStatus();
      setKeyInputs({});
      setSaveError({});
    }
  }, [open, refreshKeyStatus]);

  const handleSaveKey = async (providerKey: string, keyName: string) => {
    const value = keyInputs[keyName];
    if (!value?.trim()) return;

    setSaving((prev) => ({ ...prev, [keyName]: true }));
    setSaveError((prev) => ({ ...prev, [keyName]: "" }));

    try {
      await saveASRKey(providerKey as "assemblyai" | "openai" | "deepgram", value.trim());
      setKeyInputs((prev) => ({ ...prev, [keyName]: "" }));
      await refreshKeyStatus();
      // Key is now stored under standard env var name — invalidate terminal secrets cache
      queryClient.invalidateQueries({ queryKey: ["secrets"] });
    } catch (err) {
      setSaveError((prev) => ({
        ...prev,
        [keyName]: err instanceof Error ? err.message : "Failed to save key",
      }));
    } finally {
      setSaving((prev) => ({ ...prev, [keyName]: false }));
    }
  };

  const handleDeleteKey = async (providerKey: string) => {
    setDeleting((prev) => ({ ...prev, [providerKey]: true }));
    setSaveError((prev) => ({ ...prev, [providerKey]: "" }));

    try {
      await deleteASRKey(providerKey as "assemblyai" | "openai" | "deepgram");
      await refreshKeyStatus();
      queryClient.invalidateQueries({ queryKey: ["secrets"] });
    } catch (err) {
      setSaveError((prev) => ({
        ...prev,
        [providerKey]: err instanceof Error ? err.message : "Failed to delete key",
      }));
    } finally {
      setDeleting((prev) => ({ ...prev, [providerKey]: false }));
    }
  };

  const providerConfig = ASR_PROVIDERS[provider];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!isControlled && (
        <DialogTrigger asChild>
          {trigger || (
            <Button
              variant="ghost"
              size="icon-sm"
              className="nodrag h-6 w-6 text-white hover:text-white hover:bg-white/20"
              title="ASR Settings"
            >
              <Settings className="w-3.5 h-3.5" />
            </Button>
          )}
        </DialogTrigger>
      )}
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Speech Recognition Settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-4">
          {/* Provider Selection */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-[var(--foreground)]">
              ASR Provider
            </label>
            <div className="grid gap-2">
              {(Object.keys(ASR_PROVIDERS) as ASRProvider[]).map((providerKey) => {
                const config = ASR_PROVIDERS[providerKey];
                const isSelected = provider === providerKey;
                const configured = isKeyConfigured(providerKey);
                return (
                  <button
                    key={providerKey}
                    onClick={() => setProvider(providerKey)}
                    className={cn(
                      "flex items-center justify-between px-3 py-2 rounded-md text-left text-sm transition-colors",
                      "border",
                      isSelected
                        ? "border-emerald-500 bg-emerald-500/10 text-[var(--foreground)]"
                        : "border-[var(--border)] hover:bg-[var(--background-hover)] text-[var(--foreground-muted)]"
                    )}
                  >
                    <div className="flex flex-col">
                      <span className="font-medium">{config.name}</span>
                      <span className="text-xs text-[var(--foreground-subtle)]">
                        {config.supportsStreaming ? "Real-time streaming" : "Chunk-based"}
                        {config.requiredKeys.length === 0 && " • No API key required"}
                        {config.requiredKeys.length > 0 && configured && " • Key configured"}
                        {config.requiredKeys.length > 0 && !configured && " • Key not configured"}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {config.requiredKeys.length > 0 && configured && (
                        <ShieldCheck className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                      )}
                      {isSelected && (
                        <Check className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* API Keys Section */}
          {providerConfig.requiredKeys.length > 0 && (
            <div className="space-y-3">
              <label className="text-sm font-medium text-[var(--foreground)]">
                API Key
              </label>
              {providerConfig.requiredKeys.map((keyConfig) => {
                const configured = isKeyConfigured(provider);
                const isSaving = saving[keyConfig.key];
                const isDeleting = deleting[provider];
                const error = saveError[keyConfig.key] || saveError[provider];

                return (
                  <div key={keyConfig.key} className="space-y-1.5">
                    {configured ? (
                      // Key is configured — show status + delete
                      <>
                        <div className="flex items-center justify-between px-3 py-2 rounded-md border border-emerald-500/30 bg-emerald-500/5">
                          <div className="flex items-center gap-2">
                            <ShieldCheck className="w-4 h-4 text-emerald-500" />
                            <span className="text-sm text-[var(--foreground)]">
                              {keyConfig.label} configured
                            </span>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="h-7 w-7 text-[var(--foreground-muted)] hover:text-red-500"
                            onClick={() => handleDeleteKey(provider)}
                            disabled={isDeleting}
                            title="Remove key"
                          >
                            {isDeleting ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="w-3.5 h-3.5" />
                            )}
                          </Button>
                        </div>
                        {error && (
                          <p className="text-xs text-red-500">{error}</p>
                        )}
                      </>
                    ) : (
                      // Key not configured — show input
                      <>
                        <label className="text-xs text-[var(--foreground-muted)]">
                          {keyConfig.label}
                        </label>
                        <div className="flex gap-2">
                          <Input
                            type="password"
                            value={keyInputs[keyConfig.key] || ""}
                            onChange={(e) =>
                              setKeyInputs((prev) => ({ ...prev, [keyConfig.key]: e.target.value }))
                            }
                            placeholder={keyConfig.placeholder}
                            className="font-mono text-xs flex-1"
                          />
                          <Button
                            size="sm"
                            onClick={() => handleSaveKey(provider, keyConfig.key)}
                            disabled={isSaving || !keyInputs[keyConfig.key]?.trim()}
                          >
                            {isSaving ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              "Save"
                            )}
                          </Button>
                        </div>
                        {error && (
                          <p className="text-xs text-red-500">{error}</p>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
              <p className="text-xs text-[var(--foreground-subtle)]">
                Keys are stored encrypted on the server. They never reach the browser after saving.
              </p>
            </div>
          )}

          {/* Loading indicator for key status */}
          {keyStatusLoading && (
            <div className="flex items-center gap-2 text-xs text-[var(--foreground-subtle)]">
              <Loader2 className="w-3 h-3 animate-spin" />
              Checking key status...
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
