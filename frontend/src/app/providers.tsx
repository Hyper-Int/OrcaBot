// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "sonner";
import { API } from "@/config/env";
import { useAuthStore } from "@/stores/auth-store";
import type { User } from "@/types";

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
  const { isAuthenticated, setUser, setAuthResolved } = useAuthStore();
  const hasBootstrapped = React.useRef(false);

  React.useEffect(() => {
    // If already authenticated (from localStorage hydration), just mark as resolved
    if (isAuthenticated) {
      setAuthResolved(true);
      return;
    }

    if (hasBootstrapped.current) {
      return;
    }

    hasBootstrapped.current = true;
    let isActive = true;

    const bootstrap = async () => {
      try {
        const response = await fetch(API.cloudflare.usersMe, {
          credentials: "include",
        });

        if (!isActive) return;

        if (response.ok) {
          const data = (await response.json()) as { user?: User };
          if (data.user) {
            setUser(data.user);
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
  }, [isAuthenticated, setUser, setAuthResolved]);

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
