// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: splash-v14-popup-login
"use client";

const MODULE_REVISION = "splash-v14-popup-login";
console.log(
  `[page] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import { useSplashTransitionStore } from "@/stores/splash-transition-store";
import { createDashboard } from "@/lib/api/cloudflare/dashboards";
import { API } from "@/config/env";

export default function Home() {
  const router = useRouter();
  const { isAuthenticated, isAuthResolved } = useAuthStore();
  const { phase, startTransition, setAnimating, reset } =
    useSplashTransitionStore();
  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  const creatingRef = React.useRef(false);

  // Once auth resolves, notify the iframe of auth status
  React.useEffect(() => {
    if (!isAuthResolved) return;
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;

    // The iframe may not be loaded yet, so try on load too
    const loginUrl = `${API.cloudflare.base}/auth/google/login?mode=popup`;
    const sendAuth = () => {
      iframe.contentWindow?.postMessage(
        { type: "orcabot_auth_status", authenticated: isAuthenticated, loginUrl },
        window.location.origin
      );
    };

    sendAuth();
    iframe.addEventListener("load", sendAuth);
    return () => iframe.removeEventListener("load", sendAuth);
  }, [isAuthenticated, isAuthResolved]);

  // Listen for splash submit postMessage
  React.useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      if (!e.data || e.data.type !== "orcabot_splash_submit") return;

      const { prompt, chatBarBottom } = e.data as {
        prompt: string;
        chatBarBottom: number;
      };

      console.log(
        `[page] Splash submit: prompt="${prompt.slice(0, 40)}...", chatBarBottom=${chatBarBottom}`
      );

      // Safety net: always store prompt in localStorage
      localStorage.setItem("orcabot_initial_prompt", prompt);

      // If not authenticated, fall back to /go redirect
      if (!isAuthenticated) {
        router.push("/go");
        return;
      }

      // Prevent double-creation
      if (creatingRef.current) return;
      creatingRef.current = true;

      // Start the transition animation
      startTransition(prompt, chatBarBottom);

      // Create dashboard in the background
      const dashName =
        prompt.slice(0, 40) + (prompt.length > 40 ? "..." : "");

      createDashboard(dashName)
        .then(({ dashboard }) => {
          console.log(
            `[page] Dashboard created: ${dashboard.id}, navigating...`
          );
          // Move to animating phase, then navigate
          setAnimating(dashboard.id);
          router.push(`/dashboards/${dashboard.id}`);
        })
        .catch((err) => {
          console.error("[page] Failed to create dashboard:", err);
          creatingRef.current = false;
          reset();
          toast.error("Failed to create dashboard");
          // Fallback: redirect through /go which handles everything
          router.push("/go");
        });
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [isAuthenticated, router, startTransition, setAnimating, reset]);

  // Listen for login completion from splash iframe (popup OAuth flow)
  React.useEffect(() => {
    function handleLoginComplete(data: {
      user: { id: string; email: string; name: string };
      pendingPrompt?: string;
      chatBarBottom?: number;
    }) {
      const { user, pendingPrompt, chatBarBottom } = data;
      console.log(
        `[page] Login auth complete: ${user.email}${pendingPrompt ? `, pendingPrompt="${pendingPrompt.slice(0, 40)}"` : ""}`
      );
      useAuthStore.getState().setUser(user);

      if (pendingPrompt) {
        // User submitted a prompt before logging in — create dashboard
        if (creatingRef.current) return;
        creatingRef.current = true;

        localStorage.setItem("orcabot_initial_prompt", pendingPrompt);
        const store = useSplashTransitionStore.getState();
        store.startTransition(pendingPrompt, chatBarBottom || 0);

        const dashName =
          pendingPrompt.slice(0, 40) + (pendingPrompt.length > 40 ? "..." : "");

        createDashboard(dashName)
          .then(({ dashboard }) => {
            console.log(
              `[page] Dashboard created after login: ${dashboard.id}`
            );
            useSplashTransitionStore.getState().setAnimating(dashboard.id);
            router.push(`/dashboards/${dashboard.id}`);
          })
          .catch((err) => {
            console.error("[page] Failed to create dashboard:", err);
            creatingRef.current = false;
            useSplashTransitionStore.getState().reset();
            toast.error("Failed to create dashboard");
            router.push("/dashboards");
          });
      } else {
        // Simple login — go to dashboards list
        router.push("/dashboards");
      }
    }

    function handleMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === "login-auth-complete" && e.data.user) {
        handleLoginComplete(e.data);
      }
      if (e.data?.type === "login-popup-closed") {
        // Popup closed without postMessage — check if session cookie was set
        console.log("[page] Login popup closed, checking auth...");
        fetch(API.cloudflare.usersMe, { credentials: "include" })
          .then((r) => (r.ok ? r.json() : null))
          .then(
            (data: {
              user?: { id: string; email: string; name: string };
            } | null) => {
              if (data?.user) {
                // Check if there's a pending prompt in localStorage
                const pendingPrompt =
                  localStorage.getItem("orcabot_initial_prompt") || undefined;
                handleLoginComplete({ user: data.user, pendingPrompt });
              }
            }
          )
          .catch(() => {});
      }
    }

    window.addEventListener("message", handleMessage);

    // BroadcastChannel fallback (same pattern as integration OAuth)
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel("orcabot-oauth");
      bc.onmessage = (e: MessageEvent) => {
        if (e.data?.type === "login-auth-complete" && e.data.user) {
          handleLoginComplete(e.data);
        }
      };
    } catch {}

    return () => {
      window.removeEventListener("message", handleMessage);
      try { bc?.close(); } catch {}
    };
  }, [router]);

  // Hide the iframe when the transition overlay is active
  const iframeHidden = phase !== "idle" && phase !== "done";

  return (
    <iframe
      ref={iframeRef}
      src="/splash.html"
      style={{
        width: "100%",
        height: "100vh",
        border: "none",
        display: "block",
        opacity: iframeHidden ? 0 : 1,
        transition: "opacity 400ms cubic-bezier(0.4, 0, 0.2, 1)",
      }}
      title="OrcaBot"
    />
  );
}
