// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: splash-v2-login-landing
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Terminal,
  Shield,
  Globe,
  RefreshCcw,
  Store,
  Lock,
  ChevronRight,
  Zap,
  Mail,
  ArrowLeft,
  Check,
} from "lucide-react";
import { Button, Input, ThemeToggle, Tooltip } from "@/components/ui";
import { getAuthHeaders, useAuthStore } from "@/stores/auth-store";
import { API, DEV_MODE_ENABLED, SITE_URL } from "@/config/env";

const MODULE_REVISION = "splash-v2-login-landing";
console.log(
  `[splash] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

const features = [
  {
    icon: Terminal,
    title: "AI Agents in the Browser",
    description:
      "Run Claude Code, Codex, or any shell agent directly in your browser. Zero setup, zero local installs. Just open and start building.",
    accent: "var(--accent-primary)",
  },
  {
    icon: Shield,
    title: "Sandboxed Virtual Machines",
    description:
      "Every session runs in an isolated VM. Your code executes safely — nothing touches your local machine. Full Linux environment, completely contained.",
    accent: "var(--status-success)",
  },
  {
    icon: Globe,
    title: "Built-in Browser Testing",
    description:
      "Preview and test your work in an integrated Chromium browser. See results instantly without switching windows or deploying anywhere.",
    accent: "var(--accent-secondary)",
  },
  {
    icon: RefreshCcw,
    title: "Persistent Background Processes",
    description:
      "Set up repeatable workflows that run in the background. Agents keep working even when you close the tab. Come back to results, not restarts.",
    accent: "var(--status-warning)",
  },
  {
    icon: Store,
    title: "Marketplace & Templates",
    description:
      "Browse a library of ready-made dashboards and recipes. Clone proven workflows, share your own, and get productive immediately.",
    accent: "var(--presence-pink)",
  },
  {
    icon: Lock,
    title: "Security-First Architecture",
    description:
      "API keys never reach the LLM — a secrets broker injects them server-side. Output redaction, domain allowlisting, and integration gates keep your data locked down.",
    accent: "var(--status-error)",
  },
];

export default function SplashPage() {
  const router = useRouter();
  const {
    isAuthenticated,
    isAuthResolved,
    user,
    loginDevMode,
    logout,
    isLoading,
    setLoading,
  } = useAuthStore();

  // Login form state
  const [showDevLogin, setShowDevLogin] = React.useState(false);
  const [showRegisterInterest, setShowRegisterInterest] = React.useState(false);
  const [registrationSuccess, setRegistrationSuccess] = React.useState(false);
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState("");

  const handleGoogleLogin = () => {
    setError("");
    const redirectUrl = `${SITE_URL.replace(/\/$/, "")}/`;
    const loginUrl = `${API.cloudflare.base}/auth/google/login?redirect=${encodeURIComponent(redirectUrl)}`;
    window.location.assign(loginUrl);
  };

  const handleDevLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

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
    loginDevMode(name, email);

    try {
      const response = await fetch(`${API.cloudflare.base}/auth/dev/session`, {
        method: "POST",
        headers: { ...getAuthHeaders() },
        credentials: "include",
      });

      if (!response.ok) throw new Error("Unable to start dev session");
      router.push("/dashboards");
    } catch (err) {
      logout();
      setError("Dev login failed. Please try again.");
      console.warn("Dev session bootstrap failed:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterInterest = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!email.trim() || !email.includes("@")) {
      setError("Valid email is required");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${API.cloudflare.base}/register-interest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          note: note.trim() || undefined,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to register interest");
      }

      setRegistrationSuccess(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to register interest. Please try again."
      );
    } finally {
      setLoading(false);
    }
  };

  const resetLoginForms = () => {
    setShowDevLogin(false);
    setShowRegisterInterest(false);
    setRegistrationSuccess(false);
    setName("");
    setEmail("");
    setNote("");
    setError("");
  };

  return (
    <div className="min-h-screen bg-[var(--background)] relative overflow-hidden">
      {/* Subtle background grid */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, var(--border) 1px, transparent 0)`,
          backgroundSize: "40px 40px",
          opacity: 0.4,
        }}
      />

      {/* Top bar */}
      <header className="relative z-10 flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
        <div className="flex items-center gap-3">
          <img
            src="/orca.png"
            alt="OrcaBot"
            className="w-8 h-8 object-contain"
          />
          <span className="text-h4 text-[var(--foreground)]">OrcaBot</span>
        </div>
        <div className="flex items-center gap-3">
          <Tooltip content="Toggle theme">
            <ThemeToggle />
          </Tooltip>
          {isAuthResolved && isAuthenticated && (
            <Button
              variant="primary"
              size="md"
              onClick={() => router.push("/dashboards")}
              rightIcon={<ArrowRight className="w-4 h-4" />}
            >
              Go to Dashboards
            </Button>
          )}
        </div>
      </header>

      {/* Hero section */}
      <div className="relative z-10 max-w-5xl mx-auto px-6 pt-16 pb-8 text-center animate-fade-in">
        <div className="mb-6">
          <img
            src="/orca.png"
            alt="OrcaBot"
            className="w-20 h-20 object-contain mx-auto mb-6 drop-shadow-lg"
          />
        </div>

        <h1 className="text-display text-[var(--foreground)] mb-4">
          Agentic AI Coding.
          <br />
          <span className="text-[var(--accent-primary)]">
            Orchestrated on the Web.
          </span>
        </h1>

        <p className="text-body text-[var(--foreground-muted)] max-w-2xl mx-auto mb-8 leading-relaxed">
          Run AI coding agents in sandboxed virtual machines with multiplayer
          dashboards, built-in browser testing, and enterprise-grade secret
          protection. No setup required — just open and build.
        </p>

        {/* CTA area — adapts to auth state */}
        {isAuthResolved && isAuthenticated ? (
          /* Authenticated: Dashboard CTA */
          <div>
            <div className="flex items-center justify-center mb-4">
              <Button
                variant="primary"
                size="lg"
                onClick={() => router.push("/dashboards")}
                rightIcon={<ChevronRight className="w-4 h-4" />}
              >
                Open Dashboards
              </Button>
            </div>
            {user?.name && (
              <p className="text-caption text-[var(--foreground-subtle)] mt-4">
                Welcome back, {user.name}
              </p>
            )}
          </div>
        ) : isAuthResolved ? (
          /* Unauthenticated: Login options */
          <div className="max-w-md mx-auto">
            {!showDevLogin && !showRegisterInterest ? (
              <div className="space-y-4">
                {/* Private beta notice */}
                <p className="text-caption text-[var(--foreground-muted)]">
                  OrcaBot is currently in private beta. Sign in below if you have been invited.
                </p>

                {/* Google OAuth — primary CTA */}
                <Button
                  variant="primary"
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

                {/* Divider */}
                <div className="relative py-2">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-[var(--border)]" />
                  </div>
                  <div className="relative flex justify-center">
                    <span className="bg-[var(--background)] px-4 text-caption text-[var(--foreground-subtle)]">
                      or
                    </span>
                  </div>
                </div>

                {/* Register Interest */}
                <Button
                  variant="ghost"
                  size="md"
                  className="w-full"
                  onClick={() => setShowRegisterInterest(true)}
                  leftIcon={<Mail className="w-4 h-4" />}
                >
                  Register Interest
                </Button>

                {/* Dev Mode */}
                {DEV_MODE_ENABLED && (
                  <Button
                    variant="ghost"
                    size="md"
                    className="w-full"
                    onClick={() => setShowDevLogin(true)}
                    leftIcon={<Zap className="w-4 h-4" />}
                  >
                    Dev mode login
                  </Button>
                )}

                <p className="text-micro text-[var(--foreground-disabled)] mt-4">
                  By continuing, you agree to our{" "}
                  <a
                    href="/terms"
                    className="underline hover:text-[var(--foreground-subtle)]"
                  >
                    Terms of Service
                  </a>{" "}
                  and{" "}
                  <a
                    href="/privacy"
                    className="underline hover:text-[var(--foreground-subtle)]"
                  >
                    Privacy Policy
                  </a>
                </p>
              </div>
            ) : showRegisterInterest ? (
              /* Register Interest form */
              registrationSuccess ? (
                <div className="text-center space-y-4">
                  <div className="w-16 h-16 mx-auto rounded-full bg-[var(--status-success)]/10 flex items-center justify-center">
                    <Check className="w-8 h-8 text-[var(--status-success)]" />
                  </div>
                  <h2 className="text-heading text-[var(--foreground)]">
                    Thanks for registering!
                  </h2>
                  <p className="text-body text-[var(--foreground-muted)]">
                    We&apos;ve sent a confirmation to your email. We&apos;ll be
                    in touch soon!
                  </p>
                  <Button
                    variant="ghost"
                    onClick={resetLoginForms}
                    leftIcon={<ArrowLeft className="w-4 h-4" />}
                  >
                    Back
                  </Button>
                </div>
              ) : (
                <form
                  onSubmit={handleRegisterInterest}
                  className="space-y-4 text-left"
                >
                  <div className="p-4 rounded-lg bg-[var(--accent-primary)]/10 border border-[var(--accent-primary)]/20">
                    <p className="text-caption text-[var(--accent-primary)] flex items-center gap-2">
                      <Mail className="w-4 h-4" />
                      Register your interest
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label
                      htmlFor="interest-email"
                      className="text-caption text-[var(--foreground-muted)]"
                    >
                      Email
                    </label>
                    <Input
                      id="interest-email"
                      type="email"
                      placeholder="your@email.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoFocus
                    />
                    <p className="text-micro text-[var(--foreground-subtle)]">
                      Use a Google account email for easier access later
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label
                      htmlFor="interest-note"
                      className="text-caption text-[var(--foreground-muted)]"
                    >
                      Note (optional)
                    </label>
                    <textarea
                      id="interest-note"
                      placeholder="Tell us a bit about how you'd like to use OrcaBot..."
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      rows={3}
                      className="w-full px-3 py-2 text-body bg-[var(--background)] border border-[var(--border)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]/50 focus:border-[var(--accent-primary)] resize-none"
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
                      onClick={resetLoginForms}
                      className="flex-1"
                    >
                      Back
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      className="flex-1"
                      isLoading={isLoading}
                      disabled={!email.trim() || !email.includes("@")}
                    >
                      Register
                    </Button>
                  </div>
                </form>
              )
            ) : DEV_MODE_ENABLED ? (
              /* Dev Login form */
              <form
                onSubmit={handleDevLogin}
                className="space-y-4 text-left"
              >
                <div className="p-4 rounded-lg bg-[var(--status-warning)]/10 border border-[var(--status-warning)]/20">
                  <p className="text-caption text-[var(--status-warning)] flex items-center gap-2">
                    <Zap className="w-4 h-4" />
                    Dev Mode - For development only
                  </p>
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="dev-name"
                    className="text-caption text-[var(--foreground-muted)]"
                  >
                    Name
                  </label>
                  <Input
                    id="dev-name"
                    type="text"
                    placeholder="Your name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoFocus
                  />
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="dev-email"
                    className="text-caption text-[var(--foreground-muted)]"
                  >
                    Email
                  </label>
                  <Input
                    id="dev-email"
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
                    onClick={resetLoginForms}
                    className="flex-1"
                  >
                    Back
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    className="flex-1"
                    isLoading={isLoading}
                    disabled={
                      !name.trim() || !email.trim() || !email.includes("@")
                    }
                  >
                    Continue
                  </Button>
                </div>
              </form>
            ) : null}
          </div>
        ) : (
          /* Auth resolving — loading spinner */
          <div className="flex items-center justify-center py-4">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-[var(--accent-primary)] border-t-transparent" />
          </div>
        )}
      </div>

      {/* Feature grid */}
      <div
        id="features"
        className="relative z-10 max-w-5xl mx-auto px-6 py-12"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature, index) => (
            <FeatureCard key={feature.title} feature={feature} index={index} />
          ))}
        </div>
      </div>

      {/* Bottom CTA */}
      <div className="relative z-10 max-w-5xl mx-auto px-6 py-12 text-center">
        <div className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--background-elevated)] p-8">
          <h2 className="text-h2 text-[var(--foreground)] mb-2">
            {isAuthResolved && isAuthenticated
              ? "Ready to start building?"
              : "Want to get started?"}
          </h2>
          <p className="text-body text-[var(--foreground-muted)] mb-6">
            {isAuthResolved && isAuthenticated
              ? "Create a dashboard from scratch or pick a template to hit the ground running."
              : "Sign in to create dashboards, run AI agents, and start building in seconds."}
          </p>
          {isAuthResolved && isAuthenticated ? (
            <Button
              variant="primary"
              size="lg"
              onClick={() => router.push("/dashboards")}
              rightIcon={<ArrowRight className="w-4 h-4" />}
            >
              Go to Dashboards
            </Button>
          ) : (
            <Button
              variant="primary"
              size="lg"
              onClick={handleGoogleLogin}
              rightIcon={<ArrowRight className="w-4 h-4" />}
            >
              Get Started
            </Button>
          )}
        </div>
      </div>

      {/* Footer */}
      <footer className="relative z-10 border-t border-[var(--border)] py-6 text-center">
        <p className="text-micro text-[var(--foreground-disabled)]">
          OrcaBot — Sandboxed, multiplayer AI coding platform
        </p>
      </footer>
    </div>
  );
}

function FeatureCard({
  feature,
  index,
}: {
  feature: (typeof features)[number];
  index: number;
}) {
  const Icon = feature.icon;

  return (
    <div
      className="group rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--background-elevated)] p-6 transition-all hover:shadow-[var(--shadow-block-hover)] hover:border-[var(--border-strong)] animate-slide-up"
      style={{ animationDelay: `${index * 80}ms`, animationFillMode: "both" }}
    >
      <div
        className="w-10 h-10 rounded-[var(--radius-button)] flex items-center justify-center mb-4 transition-transform group-hover:scale-110"
        style={{
          backgroundColor: `color-mix(in srgb, ${feature.accent} 12%, transparent)`,
        }}
      >
        <Icon
          className="w-5 h-5"
          style={{ color: feature.accent }}
        />
      </div>

      <h3 className="text-h4 text-[var(--foreground)] mb-2">{feature.title}</h3>

      <p className="text-body-sm text-[var(--foreground-muted)] leading-relaxed">
        {feature.description}
      </p>
    </div>
  );
}
