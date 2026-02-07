// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { Settings, Eye, EyeOff, Check } from "lucide-react";
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
  const provider = useASRSettingsStore((s) => s.provider);
  const setProvider = useASRSettingsStore((s) => s.setProvider);
  const getApiKey = useASRSettingsStore((s) => s.getApiKey);
  const setApiKey = useASRSettingsStore((s) => s.setApiKey);

  const [visibleKeys, setVisibleKeys] = React.useState<Record<string, boolean>>({});

  const toggleKeyVisibility = (key: string) => {
    setVisibleKeys((prev) => ({ ...prev, [key]: !prev[key] }));
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
                      </span>
                    </div>
                    {isSelected && (
                      <Check className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* API Keys Section */}
          {providerConfig.requiredKeys.length > 0 && (
            <div className="space-y-3">
              <label className="text-sm font-medium text-[var(--foreground)]">
                API Keys
              </label>
              {providerConfig.requiredKeys.map((keyConfig) => {
                const value = getApiKey(keyConfig.key);
                const isVisible = visibleKeys[keyConfig.key];
                return (
                  <div key={keyConfig.key} className="space-y-1">
                    <label className="text-xs text-[var(--foreground-muted)]">
                      {keyConfig.label}
                    </label>
                    <div className="relative">
                      <Input
                        type={isVisible ? "text" : "password"}
                        value={value}
                        onChange={(e) => setApiKey(keyConfig.key, e.target.value)}
                        placeholder={keyConfig.placeholder}
                        className="pr-10 font-mono text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => toggleKeyVisibility(keyConfig.key)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--foreground-subtle)] hover:text-[var(--foreground)] transition-colors"
                      >
                        {isVisible ? (
                          <EyeOff className="w-4 h-4" />
                        ) : (
                          <Eye className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
              <p className="text-xs text-[var(--foreground-subtle)]">
                Keys are stored locally in your browser and sent directly to the provider.
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
