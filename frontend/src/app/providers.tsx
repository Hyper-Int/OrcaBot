// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
"use client";

// REVISION: providers-v8-machine-wide-local-identity
const MODULE_REVISION = "providers-v8-machine-wide-local-identity";
console.log(
  `[providers] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "sonner";
import { API, DESKTOP_MODE } from "@/config/env";
import { ensureSurfaceToken } from "@/lib/tauri-bridge";
import { getAuthHeaders, useAuthStore } from "@/stores/auth-store";
import { useDesktopAccountStore } from "@/stores/desktop-account-store";
import { DesktopWelcome } from "@/components/desktop/DesktopWelcome";
import type { User, SubscriptionInfo } from "@/types";
import { initAnalytics, stopAnalytics, resetQueue } from "@/lib/analytics";

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30 * 1000, // 30 seconds
        refetchOnWindowFocus: false,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined = undefined;

function getQueryClient() {
  if (typeof window === "undefined") {
    // Server: always make a new query client
    return makeQueryClient();
  } else {
    // Browser: make a new query client if we don't already have one
    if (!browserQueryClient) browserQueryClient = makeQueryClient();
    return browserQueryClient;
  }
}

interface ProvidersProps {
  children: React.ReactNode;
}

function AuthBootstrapper() {
  const { isAuthenticated, setUser, setAuthResolved, loginDevMode } = useAuthStore();
  const userId = useAuthStore((s) => s.user?.id ?? null);
  // Desktop first-run account choice (free / signed-in). Drives whether/who we
  // auto-login as; until it's set on a fresh install, the welcome gate is shown.
  const accountChoice = useDesktopAccountStore((s) => s.choice);
  const accountEmail = useDesktopAccountStore((s) => s.email);
  // (account name/email are shown via the account store + CloudDashboardsSection;
  //  the LOCAL identity no longer depends on them — see bootstrap below.)
  const chooseFree = useDesktopAccountStore((s) => s.chooseFree);
  // Track which user ID we last validated — re-runs on user switch, not just once per page
  const validatedUserRef = React.useRef<string | null>(null);
  // Which (mode/choice) we last bootstrapped for, so a first-run choice re-runs it.
  const bootstrappedForRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    // If already authenticated (from localStorage hydration), just mark as resolved.
    // In desktop mode, also do a one-time sync to ensure the local user ID matches
    // the server's DB (the client-generated ID may differ from an older creation).
    if (isAuthenticated) {
      setAuthResolved(true);
      if (validatedUserRef.current !== userId) {
        validatedUserRef.current = userId;
        if (DESKTOP_MODE) {
          // Existing installs (already authed before the first-run choice existed)
          // count as "free" so the welcome screen never appears for them.
          if (!accountChoice) chooseFree();
          void ensureSurfaceToken()
            .then(() => {
              const authHeaders = getAuthHeaders();
              return fetch(API.cloudflare.usersMe, {
                headers: { ...authHeaders },
                credentials: "include",
              });
            })
            .then((r) => (r.ok ? r.json() : null))
            .then((data: { user?: User; isAdmin?: boolean; subscription?: SubscriptionInfo } | null) => {
              if (data?.user) {
                if (data.user.id !== userId || data.subscription) {
                  setUser(data.user, data.isAdmin ?? false, data.subscription);
                }
              }
            })
            .catch(() => {});
        } else {
          // Web mode: validate persisted auth against server in the background
          fetch(API.cloudflare.usersMe, { credentials: "include" })
            .then((r) => {
              if (r.status === 401 || r.status === 403) {
                // Persisted auth is stale/invalid — clear it
                useAuthStore.getState().logout();
              } else if (!r.ok) {
                // Transient server error (500/502/503/429) — ignore, don't log out
                return undefined;
              } else {
                return r.json() as Promise<{ user?: User; isAdmin?: boolean; subscription?: SubscriptionInfo }>;
              }
            })
            .then((data) => {
              if (data?.user) {
                setUser(data.user, data.isAdmin ?? false, data.subscription);
              }
            })
            .catch(() => {});
        }
      }
      return;
    }

    // Desktop: nothing to log in as until the first-run choice is made (the
    // DesktopWelcome gate is rendered instead). Re-bootstrap if the choice changes
    // (null → free/signed-in, or account switch). Web bootstraps exactly once.
    if (DESKTOP_MODE && !accountChoice) {
      // Logged out / reset to the welcome screen — clear the guard so the NEXT
      // choice (even the same one) triggers a fresh login instead of being skipped.
      bootstrappedForRef.current = null;
      return;
    }
    const bootstrapKey = DESKTOP_MODE
      ? `${accountChoice}:${accountEmail ?? ""}`
      : "web";
    if (bootstrappedForRef.current === bootstrapKey) {
      return;
    }
    bootstrappedForRef.current = bootstrapKey;
    // Reset validated user so post-login validation runs for the new session
    validatedUserRef.current = null;
    let isActive = true;

    const bootstrap = async () => {
      // Desktop mode: auto-login as local user, no auth needed
      if (DESKTOP_MODE) {
        // Set the local user first so a slow/failed surface-token fetch can't
        // block login. Then load the token (bounded) so the raw bootstrap fetches
        // below carry X-Orcabot-Surface — the control plane requires it to honor
        // dev-auth, or /auth/dev/session and the /me ID-sync 401 (wrong user →
        // empty dashboards).
        //
        // Machine-wide local dashboards: the LOCAL dev-auth identity is ALWAYS the
        // single machine user (desktop@localhost), regardless of Free vs signed-in.
        // Signing in is purely additive — it attaches the cloud credential and
        // surfaces your email (desktop-account-store + CloudDashboardsSection) — it
        // must NOT switch the local owner, or your local dashboards would fork per
        // identity and "disappear" when you sign in. Downloaded cloud dashboards
        // land under this same machine user, alongside everything made while Free.
        loginDevMode("Desktop User", "desktop@localhost");
        await Promise.race([
          ensureSurfaceToken(),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
        const authHeaders = getAuthHeaders();
        try {
          // Create server-side session
          await fetch(`${API.cloudflare.base}/auth/dev/session`, {
            method: "POST",
            headers: { ...authHeaders },
            credentials: "include",
          });
          // Sync actual user from server — the DB user may have a different ID
          // than the locally-generated one (e.g. created by an older version).
          // This ensures WebSocket connections (which only send user_id, not email)
          // use the correct ID that the server recognizes.
          const meResp = await fetch(API.cloudflare.usersMe, {
            headers: { ...authHeaders },
            credentials: "include",
          });
          if (meResp.ok) {
            const meData = (await meResp.json()) as { user?: User; isAdmin?: boolean; subscription?: SubscriptionInfo };
            if (meData.user) {
              if (meData.user.id !== authHeaders["X-User-ID"] || meData.subscription) {
                setUser(meData.user, meData.isAdmin ?? false, meData.subscription);
              }
            }
          }
        } catch {
          // Session creation is best-effort — auth store is already set
        }
        return;
      }

      try {
        const response = await fetch(API.cloudflare.usersMe, {
          credentials: "include",
        });

        if (!isActive) return;

        if (response.ok) {
          const data = (await response.json()) as { user?: User; isAdmin?: boolean; subscription?: SubscriptionInfo };
          if (data.user) {
            setUser(data.user, data.isAdmin ?? false, data.subscription);
            return;
          }
        }

        setAuthResolved(true);
      } catch {
        if (isActive) {
          setAuthResolved(true);
        }
      }
    };

    void bootstrap();

    return () => {
      isActive = false;
    };
  }, [
    isAuthenticated,
    userId,
    setUser,
    setAuthResolved,
    loginDevMode,
    accountChoice,
    accountEmail,
    chooseFree,
  ]);

  return null;
}

function AnalyticsBootstrapper() {
  const userId = useAuthStore((s) => s.user?.id ?? null);

  React.useEffect(() => {
    initAnalytics();
    return () => stopAnalytics();
  }, []);

  // On user identity change (login/logout/switch), drop queued events
  // to prevent cross-user attribution.
  React.useEffect(() => {
    resetQueue();
  }, [userId]);

  return null;
}

/**
 * On the desktop app's first run, show the welcome screen (Free Desktop Use vs.
 * sign in) instead of the app until a choice is made. Web is unaffected, and
 * returning/authenticated desktop users skip straight through.
 */
function DesktopAuthGate({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const choice = useDesktopAccountStore((s) => s.choice);
  const hydrated = useDesktopAccountStore((s) => s.hydrated);

  if (DESKTOP_MODE && hydrated && !isAuthenticated && choice === null) {
    return <DesktopWelcome />;
  }
  return <>{children}</>;
}

export function Providers({ children }: ProvidersProps) {
  const queryClient = getQueryClient();

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <AuthBootstrapper />
        <AnalyticsBootstrapper />
        <DesktopAuthGate>{children}</DesktopAuthGate>
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: "var(--background-elevated)",
              border: "1px solid var(--border)",
              color: "var(--foreground)",
            },
          }}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
