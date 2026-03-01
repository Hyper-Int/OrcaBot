// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: ai-setup-card-v2-saved-keys-callback

"use client";

const REVISION = "ai-setup-card-v2-saved-keys-callback";
console.log(`[AiProviderSetupCard] REVISION: ${REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import Image from "next/image";
import { Shield, Loader2, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createGlobalSecret } from "@/lib/api/cloudflare/secrets";

interface AiProviderSetupCardProps {
  /**
   * Called when the user saves keys (with the saved provider names) or skips (no args).
   * Parent should store savedKeys to render a persistent confirmation in chat.
   */
  onDone: (savedKeys?: string[]) => void;
}

interface Provider {
  name: string;
  keyName: string;
  logo: string;
  placeholder: string;
  hint: string;
}

const PROVIDERS: Provider[] = [
  {
    name: "Claude",
    keyName: "ANTHROPIC_API_KEY",
    logo: "/icons/claude.ico",
    placeholder: "sk-ant-…",
    hint: "console.anthropic.com",
  },
  {
    name: "Gemini",
    keyName: "GEMINI_API_KEY",
    logo: "/icons/gemini.ico",
    placeholder: "AIza…",
    hint: "aistudio.google.com",
  },
  {
    name: "OpenAI",
    keyName: "OPENAI_API_KEY",
    logo: "/icons/codex.png",
    placeholder: "sk-…",
    hint: "platform.openai.com",
  },
];

export function AiProviderSetupCard({ onDone }: AiProviderSetupCardProps) {
  const [values, setValues] = React.useState<Record<string, string>>({
    ANTHROPIC_API_KEY: "",
    GEMINI_API_KEY: "",
    OPENAI_API_KEY: "",
  });
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  const hasAny = Object.values(values).some((v) => v.trim().length > 0);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const toSave = PROVIDERS.filter((p) => values[p.keyName].trim());
    try {
      await Promise.all(
        toSave.map((p) =>
          createGlobalSecret({
            name: p.keyName,
            value: values[p.keyName].trim(),
            description: `${p.name} API key`,
          })
        )
      );
      const savedNames = toSave.map((p) => p.name);
      setSaved(savedNames);
      // Brief confirmation then close — pass saved keys so parent can persist the confirmation
      setTimeout(() => onDone(savedNames), 1200);
    } catch {
      setError("Failed to save — please try again.");
      setSaving(false);
    }
  };

  if (saved.length > 0) {
    return (
      <div className="flex gap-3 py-2">
        <div className="flex-shrink-0 w-8 h-8 rounded-full overflow-hidden bg-gradient-to-br from-cyan-400 to-blue-500">
          <Image src="/orca.png" alt="Orcabot" width={32} height={32} className="w-full h-full object-cover" />
        </div>
        <div className="max-w-[80%] rounded-2xl px-4 py-3 bg-muted text-sm" style={{ color: "var(--foreground)" }}>
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-emerald-400" />
            <span>{saved.join(" & ")} key{saved.length > 1 ? "s" : ""} saved — encrypted and broker-protected.</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 py-2">
      {/* Orca avatar */}
      <div className="flex-shrink-0 w-8 h-8 rounded-full overflow-hidden bg-gradient-to-br from-cyan-400 to-blue-500">
        <Image src="/orca.png" alt="Orcabot" width={32} height={32} className="w-full h-full object-cover" />
      </div>

      {/* Card */}
      <div className="max-w-[80%] rounded-2xl px-4 py-3 bg-muted space-y-3" style={{ color: "var(--foreground)" }}>
        <p className="text-sm font-medium">Do you have an AI API key you'd like to use?</p>
        <p className="text-xs" style={{ color: "var(--foreground-subtle)" }}>
          Keys are stored encrypted and are never visible to AI agents.
        </p>

        <div className="space-y-2">
          {PROVIDERS.map((p) => (
            <div key={p.keyName} className="flex items-center gap-2">
              {/* Provider icon */}
              <div className="w-5 h-5 flex-shrink-0 relative">
                <Image
                  src={p.logo}
                  alt={p.name}
                  width={20}
                  height={20}
                  className="w-full h-full object-contain rounded-sm"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
              </div>
              {/* Label */}
              <span className="w-14 text-xs flex-shrink-0 font-medium">{p.name}</span>
              {/* Key input */}
              <div className="relative flex-1">
                <Input
                  type="text"
                  placeholder={p.placeholder}
                  value={values[p.keyName]}
                  onChange={(e) => setValues((v) => ({ ...v, [p.keyName]: e.target.value }))}
                  disabled={saving}
                  autoComplete="off"
                  data-form-type="other"
                  data-lpignore="true"
                  data-1p-ignore
                  style={{
                    WebkitTextSecurity: values[p.keyName] ? "disc" : undefined,
                    fontFamily: values[p.keyName] ? "monospace" : undefined,
                    fontSize: "12px",
                    height: "28px",
                  } as React.CSSProperties}
                  className="h-7 text-xs pr-2"
                />
              </div>
            </div>
          ))}
        </div>

        {error && (
          <p className="text-xs text-red-400">{error}</p>
        )}

        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!hasAny || saving}
            className="h-7 text-xs px-3"
          >
            {saving ? (
              <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Saving…</>
            ) : (
              <><Shield className="w-3 h-3 mr-1" /> Save encrypted</>
            )}
          </Button>
          <button
            type="button"
            onClick={onDone}
            disabled={saving}
            className="flex items-center gap-1 text-xs hover:underline disabled:opacity-50"
            style={{ color: "var(--foreground-subtle)" }}
          >
            <SkipForward className="w-3 h-3" />
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
