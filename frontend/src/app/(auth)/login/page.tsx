// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Zap } from "lucide-react";
import { Button, Input, ThemeToggle, Tooltip } from "@/components/ui";
import { useAuthStore } from "@/stores/auth-store";
import { API, DEV_MODE_ENABLED, SITE_URL } from "@/config/env";

export default function LoginPage() {
  const router = useRouter();
  const {
    isAuthenticated,
    isAuthResolved,
    loginDevMode,
    isLoading,
    setLoading,
  } = useAuthStore();

  const [showDevLogin, setShowDevLogin] = React.useState(false);
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [error, setError] = React.useState("");

  // Redirect if already authenticated
  React.useEffect(() => {
    if (isAuthResolved && isAuthenticated) {
      router.push("/dashboards");
    }
  }, [isAuthenticated, isAuthResolved, router]);

  const handleDevLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    // Security: reject dev login if dev mode is disabled
    if (!DEV_MODE_ENABLED) {
      setError("Dev mode is not available in this environment");
      return;
    }

    if (!name.trim()) {
      setError("Name is required");
      return;
    }

    if (!email.trim() || !email.includes("@")) {
      setError("Valid email is required");
      return;
    }

    setLoading(true);
    // Simulate a brief delay for UX
    setTimeout(() => {
      loginDevMode(name, email);
      router.push("/dashboards");
    }, 300);
  };

  const handleGoogleLogin = () => {
    setError("");
    const redirectUrl = `${SITE_URL.replace(/\/$/, "")}/`;
    const loginUrl = `${API.cloudflare.base}/auth/google/login?redirect=${encodeURIComponent(
      redirectUrl
    )}`;
    window.location.assign(loginUrl);
  };

  return (
    <div className="min-h-screen bg-[var(--background)] flex flex-col items-center justify-center p-4 relative">
      {/* Theme toggle in top-right corner */}
      <div className="absolute top-4 right-4">
        <Tooltip content="Toggle theme">
          <ThemeToggle />
        </Tooltip>
      </div>

      <div className="w-full max-w-md">
        {/* Logo and Tagline */}
        <div className="text-center mb-12">
          <img
            src="/orca.png"
            alt="Orcabot"
            className="w-[90px] h-[90px] object-contain mx-auto mb-6"
          />
          <h1 className="text-display text-[var(--foreground)] mb-2">OrcaBot</h1>
          <p className="text-body text-[var(--foreground-muted)]">
            Agentic AI Coding Agent Orchestration on the Web
          </p>
        </div>

        {/* Login Options */}
        <div className="space-y-4">
          {!showDevLogin ? (
            <>
              {/* Google OAuth Button */}
              <Button
                variant="secondary"
                size="lg"
                className="w-full"
                onClick={handleGoogleLogin}
                leftIcon={
                  <svg className="w-5 h-5" viewBox="0 0 24 24">
                    <path
                      fill="currentColor"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    />
                    <path
                      fill="currentColor"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="currentColor"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                    />
                    <path
                      fill="currentColor"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                    />
                  </svg>
                }
              >
                Continue with Google
              </Button>

              {/* Dev Mode - only shown when DEV_MODE_ENABLED */}
              {DEV_MODE_ENABLED && (
                <>
                  {/* Divider */}
                  <div className="relative py-4">
                    <div className="absolute inset-0 flex items-center">
                      <div className="w-full border-t border-[var(--border)]" />
                    </div>
                    <div className="relative flex justify-center">
                      <span className="bg-[var(--background)] px-4 text-caption text-[var(--foreground-subtle)]">
                        or
                      </span>
                    </div>
                  </div>

                  {/* Dev Mode Button */}
                  <Button
                    variant="ghost"
                    size="lg"
                    className="w-full"
                    onClick={() => setShowDevLogin(true)}
                    leftIcon={<Zap className="w-4 h-4" />}
                  >
                    Dev mode login
                  </Button>

                  <p className="text-micro text-[var(--foreground-subtle)] text-center mt-4">
                    Dev mode bypasses OAuth for local development only
                  </p>
                </>
              )}
            </>
          ) : DEV_MODE_ENABLED ? (
            /* Dev Login Form - only accessible when DEV_MODE_ENABLED */
            <form onSubmit={handleDevLogin} className="space-y-4">
              <div className="p-4 rounded-lg bg-[var(--status-warning)]/10 border border-[var(--status-warning)]/20">
                <p className="text-caption text-[var(--status-warning)] flex items-center gap-2">
                  <Zap className="w-4 h-4" />
                  Dev Mode - For development only
                </p>
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="name"
                  className="text-caption text-[var(--foreground-muted)]"
                >
                  Name
                </label>
                <Input
                  id="name"
                  type="text"
                  placeholder="Your name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="email"
                  className="text-caption text-[var(--foreground-muted)]"
                >
                  Email
                </label>
                <Input
                  id="email"
                  type="email"
                  placeholder="your@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>

              {error && (
                <p className="text-caption text-[var(--status-error)]">
                  {error}
                </p>
              )}

              <div className="flex gap-3 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setShowDevLogin(false)}
                  className="flex-1"
                >
                  Back
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  className="flex-1"
                  isLoading={isLoading}
                  disabled={!name.trim() || !email.trim() || !email.includes("@")}
                >
                  Continue
                </Button>
              </div>
            </form>
          ) : (
            /* Fallback if showDevLogin somehow true but DEV_MODE_ENABLED false */
            null
          )}
        </div>

        {/* Footer */}
        <div className="mt-12 text-center">
          <p className="text-micro text-[var(--foreground-disabled)]">
            By continuing, you agree to our Terms of Service
          </p>
        </div>
      </div>
    </div>
  );
}
