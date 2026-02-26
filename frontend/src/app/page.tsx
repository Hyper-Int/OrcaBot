// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: splash-v12-smooth-transition
"use client";

const MODULE_REVISION = "splash-v12-smooth-transition";
console.log(
  `[page] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/auth-store";
import { useSplashTransitionStore } from "@/stores/splash-transition-store";
import { createDashboard } from "@/lib/api/cloudflare/dashboards";

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
    const sendAuth = () => {
      iframe.contentWindow?.postMessage(
        { type: "orcabot_auth_status", authenticated: isAuthenticated },
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

  // Hide the iframe when the transition overlay is active
  const iframeHidden = phase !== "idle" && phase !== "done";

  return (
    <iframe
      ref={iframeRef}
      src="/splash_claude.html"
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
