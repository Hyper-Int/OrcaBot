// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
"use client";

// REVISION: desktop-auth-v3-subscription-status
const MODULE_REVISION = "desktop-auth-v3-subscription-status";
console.log(
  `[providers] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "sonner";
import { API, DESKTOP_MODE } from "@/config/env";
import { getAuthHeaders, useAuthStore } from "@/stores/auth-store";
import type { User, SubscriptionInfo } from "@/types";

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
  const hasBootstrapped = React.useRef(false);

  React.useEffect(() => {
    // If already authenticated (from localStorage hydration), just mark as resolved.
    // In desktop mode, also do a one-time sync to ensure the local user ID matches
    // the server's DB (the client-generated ID may differ from an older creation).
    if (isAuthenticated) {
      setAuthResolved(true);
      if (DESKTOP_MODE && !hasBootstrapped.current) {
        hasBootstrapped.current = true;
        const authHeaders = getAuthHeaders();
        fetch(API.cloudflare.usersMe, {
          headers: { ...authHeaders },
          credentials: "include",
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((data: { user?: User; isAdmin?: boolean; subscription?: SubscriptionInfo } | null) => {
            if (data?.user) {
              if (data.user.id !== authHeaders["X-User-ID"] || data.subscription) {
                setUser(data.user, data.isAdmin ?? false, data.subscription);
              }
            }
          })
          .catch(() => {});
      }
      return;
    }

    if (hasBootstrapped.current) {
      return;
    }

    hasBootstrapped.current = true;
    let isActive = true;

    const bootstrap = async () => {
      // Desktop mode: auto-login as local user, no auth needed
      if (DESKTOP_MODE) {
        loginDevMode("Desktop User", "desktop@localhost");
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
  }, [isAuthenticated, setUser, setAuthResolved, loginDevMode]);

  return null;
}

export function Providers({ children }: ProvidersProps) {
  const queryClient = getQueryClient();

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <AuthBootstrapper />
        {children}
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
