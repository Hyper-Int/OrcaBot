// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: go-v4-bottom-position
"use client";

const MODULE_REVISION = "go-v4-bottom-position";
console.log(
  `[go] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

import * as React from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { API, SITE_URL, TURNSTILE_SITE_KEY } from "@/config/env";
import { createDashboard } from "@/lib/api/cloudflare/dashboards";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  execute: (widgetId: string) => void;
  reset: (widgetId: string) => void;
};
const getTurnstile = (): TurnstileApi | null =>
  (window as unknown as { turnstile?: TurnstileApi }).turnstile || null;

export default function GoPage() {
  const router = useRouter();
  const { isAuthenticated, isAuthResolved } = useAuthStore();
  const [status, setStatus] = React.useState("Checking authentication...");
  const [initialPrompt, setInitialPrompt] = React.useState<string | null>(null);
  const creatingRef = React.useRef(false);
  const turnstileWidgetId = React.useRef<string | null>(null);

  // Read prompt from localStorage on mount to display in UI
  React.useEffect(() => {
    const prompt = localStorage.getItem("orcabot_initial_prompt");
    if (prompt) setInitialPrompt(prompt);
  }, []);

  // Load Turnstile script if configured
  React.useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    if (document.getElementById("cf-turnstile-script")) return;
    const script = document.createElement("script");
    script.id = "cf-turnstile-script";
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    document.head.appendChild(script);
  }, []);

  // Callback ref to render Turnstile widget
  const turnstileCallbackRef = React.useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || !TURNSTILE_SITE_KEY || turnstileWidgetId.current) return;
      const tryRender = () => {
        const api = getTurnstile();
        if (!api) return false;
        turnstileWidgetId.current = api.render(el, {
          sitekey: TURNSTILE_SITE_KEY,
          execution: "execute",
          appearance: "interaction-only",
          callback: (token: string) => {
            proceedWithLogin(token);
          },
          "error-callback": () => {
            setStatus("Verification failed. Redirecting...");
            router.push("/dashboards");
          },
          theme: "dark",
        });
        // Widget rendered in manual execution mode — execute immediately
        // so the user isn't stuck on "Redirecting to sign in..."
        api.execute(turnstileWidgetId.current);
        return true;
      };
      if (!tryRender()) {
        const interval = setInterval(() => {
          if (tryRender()) clearInterval(interval);
        }, 100);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const proceedWithLogin = React.useCallback((token: string) => {
    const redirectUrl = `${SITE_URL.replace(/\/$/, "")}/go`;
    const loginUrl = `${API.cloudflare.base}/auth/google/login?redirect=${encodeURIComponent(redirectUrl)}&turnstile_token=${encodeURIComponent(token)}`;
    window.location.assign(loginUrl);
  }, []);

  // Main orchestration effect
  React.useEffect(() => {
    if (!isAuthResolved) return;

    // Not authenticated — redirect to Google OAuth
    if (!isAuthenticated) {
      setStatus("Redirecting to sign in...");

      if (!TURNSTILE_SITE_KEY) {
        // No Turnstile, go straight to Google
        const redirectUrl = `${SITE_URL.replace(/\/$/, "")}/go`;
        const loginUrl = `${API.cloudflare.base}/auth/google/login?redirect=${encodeURIComponent(redirectUrl)}`;
        window.location.assign(loginUrl);
      } else {
        // Trigger Turnstile, then login
        const api = getTurnstile();
        if (api && turnstileWidgetId.current) {
          api.execute(turnstileWidgetId.current);
        }
        // If Turnstile not ready yet, the callback ref will handle it
        // once the widget renders and auto-executes
      }
      return;
    }

    // Authenticated — create dashboard and navigate
    if (creatingRef.current) return;
    creatingRef.current = true;

    const prompt = localStorage.getItem("orcabot_initial_prompt");
    const dashName = prompt
      ? prompt.slice(0, 40) + (prompt.length > 40 ? "..." : "")
      : "New Dashboard";
    setStatus("Creating dashboard...");

    createDashboard(dashName)
      .then(({ dashboard }) => {
        router.push(`/dashboards/${dashboard.id}`);
      })
      .catch((err) => {
        console.error("[go] Failed to create dashboard:", err);
        toast.error("Failed to create dashboard");
        router.push("/dashboards");
      });
  }, [isAuthenticated, isAuthResolved, router, proceedWithLogin]);

  return (
    <div className="min-h-screen bg-[var(--background)] relative">
      {/* Centered status text */}
      <div className="min-h-screen flex flex-col items-center justify-center px-4 gap-4">
        <p className="text-[var(--foreground-muted)] text-sm">{status}</p>
        {!initialPrompt && (
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-[var(--accent-primary)] border-t-transparent" />
        )}
        {/* Invisible Turnstile widget */}
        {TURNSTILE_SITE_KEY && (
          <div ref={turnstileCallbackRef} className="flex justify-center" />
        )}
      </div>

      {/* Prompt pill — fixed at bottom, matching ChatPanel position exactly */}
      {initialPrompt && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-xl px-4">
          <div className="bg-[var(--background)]/95 backdrop-blur-lg border border-[var(--border)] rounded-2xl shadow-lg overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 border-b">
              <span className="flex-1 text-sm text-[var(--foreground)] truncate">
                {initialPrompt}
              </span>
              <div className="h-7 w-7 flex items-center justify-center rounded-full bg-[var(--accent-primary)]">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-white" />
              </div>
            </div>
            {/* Empty messages area — matches dashboard expanded state */}
            <div className="flex flex-col items-center justify-center py-8 text-center px-4">
              <p className="text-sm text-[var(--foreground-muted)]">
                Setting up your dashboard...
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
