// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: splash-v6-code-login
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
  Users,
  SlidersHorizontal,
  Eye,
  Github,
  Mic,
  Volume2,
} from "lucide-react";
import {
  GmailIcon,
  GoogleDriveIcon,
  GoogleCalendarIcon,
  GoogleContactsIcon,
  GoogleSheetsIcon,
  GoogleFormsIcon,
  SlackIcon,
  DiscordIcon,
  TelegramIcon,
  WhatsAppIcon,
  TeamsIcon,
  MatrixIcon,
} from "@/components/icons";
import { Button, Input, ThemeToggle, Tooltip } from "@/components/ui";
import { getAuthHeaders, useAuthStore } from "@/stores/auth-store";
import { API, DEV_MODE_ENABLED, DESKTOP_MODE, SITE_URL } from "@/config/env";

const MODULE_REVISION = "splash-v6-code-login";
console.log(
  `[splash] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

const features = [
  {
    icon: Terminal,
    title: "AI Agents in the Browser",
    description:
      "Run Claude Code, Codex, Gemini CLI, or any shell-based AI coding agent directly in your browser. No local setup or installs required.",
    accent: "var(--accent-primary)",
  },
  {
    icon: Shield,
    title: "Sandboxed Virtual Machines",
    description:
      "Every session runs in an isolated Linux VM. Your code executes safely in a contained environment — nothing touches your local machine.",
    accent: "var(--status-success)",
  },
  {
    icon: Users,
    title: "Multiplayer Dashboards",
    description:
      "Collaborate in real-time on shared dashboards, like Figma for coding. Multiple team members can view terminals, share context, and coordinate work.",
    accent: "var(--accent-secondary)",
  },
  {
    icon: Globe,
    title: "Built-in Browser Testing",
    description:
      "Preview and test web applications in an integrated Chromium browser. See results instantly without switching windows or deploying anywhere.",
    accent: "var(--presence-pink)",
  },
  {
    icon: RefreshCcw,
    title: "Background Workflows",
    description:
      "Schedule repeatable workflows that run on a cadence or in response to events. Agents keep working even when you close the tab.",
    accent: "var(--status-warning)",
  },
  {
    icon: Store,
    title: "Templates & Recipes",
    description:
      "Start from a library of ready-made dashboard templates for common tasks — agentic coding, automation, and enterprise tooling setups.",
    accent: "var(--foreground-muted)",
  },
];

type IntegrationItem = {
  name: string;
  icon?: React.FC<{ className?: string }>;
  img?: string;
};

const allIntegrations: IntegrationItem[] = [
  { name: "Claude Code", img: "/icons/claude.ico" },
  { name: "Codex", img: "/icons/codex.png" },
  { name: "Gemini CLI", img: "/icons/gemini.ico" },
  { name: "Gmail", icon: GmailIcon },
  { name: "Google Drive", icon: GoogleDriveIcon },
  { name: "Google Calendar", icon: GoogleCalendarIcon },
  { name: "Google Contacts", icon: GoogleContactsIcon },
  { name: "Google Sheets", icon: GoogleSheetsIcon },
  { name: "Google Forms", icon: GoogleFormsIcon },
  { name: "GitHub", icon: Github },
  { name: "Slack", icon: SlackIcon },
  { name: "ElevenLabs", icon: Volume2 },
  { name: "Deepgram", icon: Mic },
  { name: "Discord", icon: DiscordIcon },
  { name: "Telegram", icon: TelegramIcon },
  { name: "WhatsApp", icon: WhatsAppIcon },
  { name: "Microsoft Teams", icon: TeamsIcon },
  { name: "Matrix", icon: MatrixIcon },
];

// Split into two rows for the carousel
const half = Math.ceil(allIntegrations.length / 2);
const carouselRows = [
  allIntegrations.slice(0, half),
  allIntegrations.slice(half),
];

const oauthIntegrations = [
  {
    title: "Gmail",
    description:
      "Agents can search and read emails to gather context for coding tasks. You control which senders and labels agents can access via per-terminal policies.",
  },
  {
    title: "Google Drive",
    description:
      "Agents can access project documents, specs, and reference files stored in Drive. They can read files and save outputs back to your Drive.",
  },
  {
    title: "Google Calendar",
    description:
      "Agents can check your schedule and create events — useful for scheduling deployments, setting reminders, or coordinating team workflows.",
  },
  {
    title: "GitHub",
    description:
      "Agents can search code, create issues, and list pull requests across your repositories. Access is scoped to the repos and actions you approve.",
  },
  {
    title: "Slack",
    description:
      "Agents can read and send messages in channels you specify. Useful for posting build results, status updates, or responding to team requests.",
  },
];

export default function Home() {
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

  // Desktop mode: skip splash entirely, go straight to dashboards
  React.useEffect(() => {
    if (DESKTOP_MODE) {
      router.replace("/dashboards");
    }
  }, [router]);

  // Don't render splash content in desktop mode — just show blank while redirecting
  if (DESKTOP_MODE) {
    return null;
  }

  // Auth config from backend (runtime feature flags)
  const [codeLoginEnabled, setCodeLoginEnabled] = React.useState(false);
  React.useEffect(() => {
    fetch(`${API.cloudflare.base}/auth/config`)
      .then((r) => r.json())
      .then((data: { codeLoginEnabled?: boolean }) => {
        if (data.codeLoginEnabled) setCodeLoginEnabled(true);
      })
      .catch(() => {});
  }, []);

  // Login form state
  const [showDevLogin, setShowDevLogin] = React.useState(false);
  const [showCodeLogin, setShowCodeLogin] = React.useState(false);
  const [showRegisterInterest, setShowRegisterInterest] = React.useState(false);
  const [registrationSuccess, setRegistrationSuccess] = React.useState(false);
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [accessCode, setAccessCode] = React.useState("");
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

  const handleCodeLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!accessCode.trim()) {
      setError("Access code is required");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${API.cloudflare.base}/auth/code/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ code: accessCode }),
      });

      if (!response.ok) {
        if (response.status === 401) {
          setError("Invalid access code");
        } else {
          setError("Login failed. Please try again.");
        }
        return;
      }

      // Session cookie is set — redirect and let AuthBootstrapper pick up the session
      window.location.assign("/dashboards");
    } catch (err) {
      setError("Login failed. Please try again.");
      console.warn("Code login failed:", err);
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
    setShowCodeLogin(false);
    setShowRegisterInterest(false);
    setRegistrationSuccess(false);
    setName("");
    setEmail("");
    setAccessCode("");
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
          OrcaBot is a web-based platform for running AI coding agents in
          sandboxed virtual machines. Create multiplayer dashboards, connect
          integrations like Gmail and Google Drive, and let AI agents help you
          build software — all from your browser.
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
            {!showDevLogin && !showRegisterInterest && !showCodeLogin ? (
              <div className="space-y-4">
                {/* Private beta notice */}
                <p className="text-caption text-[var(--foreground-muted)]">
                  OrcaBot is currently in private beta. Sign in below if you
                  have been invited.
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

                {/* Code Login */}
                {codeLoginEnabled && (
                  <Button
                    variant="ghost"
                    size="md"
                    className="w-full"
                    onClick={() => setShowCodeLogin(true)}
                    leftIcon={<Lock className="w-4 h-4" />}
                  >
                    Login with access code
                  </Button>
                )}

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
            ) : showCodeLogin ? (
              /* Access Code Login form */
              <form
                onSubmit={handleCodeLogin}
                className="space-y-4 text-left"
              >
                <div className="p-4 rounded-lg bg-[var(--accent-primary)]/10 border border-[var(--accent-primary)]/20">
                  <p className="text-caption text-[var(--accent-primary)] flex items-center gap-2">
                    <Lock className="w-4 h-4" />
                    Enter your access code
                  </p>
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="access-code"
                    className="text-caption text-[var(--foreground-muted)]"
                  >
                    Access Code
                  </label>
                  <Input
                    id="access-code"
                    type="password"
                    placeholder="Enter access code"
                    value={accessCode}
                    onChange={(e) => setAccessCode(e.target.value)}
                    autoFocus
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
                    disabled={!accessCode.trim()}
                  >
                    Login
                  </Button>
                </div>
              </form>
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

      {/* What is OrcaBot */}
      <div className="relative z-10 max-w-4xl mx-auto px-6 py-12">
        <div className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--background-elevated)] p-8">
          <h2 className="text-h2 text-[var(--foreground)] mb-4 text-center">
            What is OrcaBot?
          </h2>
          <div className="space-y-4 text-body text-[var(--foreground-muted)] leading-relaxed">
            <p>
              OrcaBot is a <strong className="text-[var(--foreground)]">web-based orchestration platform</strong> for
              AI coding agents. It provides sandboxed Linux virtual machines where AI agents
              like Claude Code, Codex, and Gemini CLI can write, run, and test code on your
              behalf — all accessible through your browser.
            </p>
            <p>
              OrcaBot is <strong className="text-[var(--foreground)]">not an AI provider</strong>.
              It orchestrates third-party AI agents (from Anthropic, OpenAI, Google, etc.)
              inside secure, isolated environments. You bring your own API keys, which are
              protected by a secrets broker that prevents AI agents from ever seeing or
              exfiltrating them.
            </p>
            <p>
              Users create <strong className="text-[var(--foreground)]">dashboards</strong> — collaborative
              workspaces similar to Figma boards — where they can place terminals, notes,
              browser previews, and integration blocks. Multiple team members can view and
              interact with the same dashboard in real-time.
            </p>
          </div>
        </div>
      </div>

      {/* Platform features */}
      <div className="relative z-10 max-w-5xl mx-auto px-6 py-12">
        <h2 className="text-h2 text-[var(--foreground)] mb-2 text-center">
          Platform Features
        </h2>
        <p className="text-body text-[var(--foreground-muted)] mb-8 text-center max-w-2xl mx-auto">
          Everything you need to run AI coding agents securely and collaboratively.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature, index) => (
            <FeatureCard key={feature.title} feature={feature} index={index} />
          ))}
        </div>
      </div>

      {/* Integrations carousel */}
      <div className="relative z-10 max-w-5xl mx-auto px-6 py-12">
        <h2 className="text-h2 text-[var(--foreground)] mb-2 text-center">
          A Growing List of Integrations
        </h2>
        <p className="text-body text-[var(--foreground-muted)] mb-10 text-center max-w-2xl mx-auto">
          OrcaBot connects to the tools, agents, and services you already use.
          Every integration is optional and controlled by policies you define.
        </p>
        <div className="space-y-2">
          {carouselRows.map((row, rowIndex) => (
            <IntegrationCarouselRow
              key={rowIndex}
              items={row}
              direction={rowIndex % 2 === 0 ? "left" : "right"}
            />
          ))}
        </div>
      </div>

      {/* OAuth integration details — for Google verification */}
      <div className="relative z-10 max-w-5xl mx-auto px-6 py-12">
        <h2 className="text-h2 text-[var(--foreground)] mb-2 text-center">
          Connected Services
        </h2>
        <p className="text-body text-[var(--foreground-muted)] mb-8 text-center max-w-2xl mx-auto">
          When you connect a service, you choose exactly which terminals can use
          it and what actions agents are allowed to perform.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {oauthIntegrations.map((integration, index) => (
            <div
              key={integration.title}
              className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--background-elevated)] p-5 animate-slide-up"
              style={{
                animationDelay: `${index * 60}ms`,
                animationFillMode: "both",
              }}
            >
              <h3 className="text-h4 text-[var(--foreground)] mb-2">
                {integration.title}
              </h3>
              <p className="text-body-sm text-[var(--foreground-muted)] leading-relaxed">
                {integration.description}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Security & User Control */}
      <div className="relative z-10 max-w-4xl mx-auto px-6 py-12">
        <h2 className="text-h2 text-[var(--foreground)] mb-2 text-center">
          Security & User Control
        </h2>
        <p className="text-body text-[var(--foreground-muted)] mb-8 text-center max-w-2xl mx-auto">
          You decide what agents can access. Every action is gated, audited, and
          transparent.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--background-elevated)] p-6">
            <div className="flex items-center gap-3 mb-3">
              <SlidersHorizontal
                className="w-5 h-5"
                style={{ color: "var(--accent-primary)" }}
              />
              <h3 className="text-h4 text-[var(--foreground)]">
                Per-Terminal Policies
              </h3>
            </div>
            <p className="text-body-sm text-[var(--foreground-muted)] leading-relaxed">
              You explicitly attach integrations to each terminal and define
              what actions agents can perform — such as which email senders
              agents can read, which repos they can access, or rate limits on
              API calls. No integration is available unless you attach it.
            </p>
          </div>
          <div className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--background-elevated)] p-6">
            <div className="flex items-center gap-3 mb-3">
              <Lock
                className="w-5 h-5"
                style={{ color: "var(--status-error)" }}
              />
              <h3 className="text-h4 text-[var(--foreground)]">
                Secrets Broker
              </h3>
            </div>
            <p className="text-body-sm text-[var(--foreground-muted)] leading-relaxed">
              API keys are never exposed to AI agents. A server-side broker
              injects credentials at the network layer — agents only see
              placeholder values. Terminal output is scanned and redacted before
              reaching your browser.
            </p>
          </div>
          <div className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--background-elevated)] p-6">
            <div className="flex items-center gap-3 mb-3">
              <Shield
                className="w-5 h-5"
                style={{ color: "var(--status-success)" }}
              />
              <h3 className="text-h4 text-[var(--foreground)]">
                OAuth Tokens Stay Server-Side
              </h3>
            </div>
            <p className="text-body-sm text-[var(--foreground-muted)] leading-relaxed">
              When you connect Gmail, Drive, or Calendar, your OAuth tokens are
              stored encrypted on our control plane. They are never sent to the
              sandbox VM or exposed to AI agents. All API calls are made
              server-side on your behalf.
            </p>
          </div>
          <div className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--background-elevated)] p-6">
            <div className="flex items-center gap-3 mb-3">
              <Eye
                className="w-5 h-5"
                style={{ color: "var(--status-warning)" }}
              />
              <h3 className="text-h4 text-[var(--foreground)]">
                Audit Logging
              </h3>
            </div>
            <p className="text-body-sm text-[var(--foreground-muted)] leading-relaxed">
              Every integration action is logged before a response is returned.
              You can review what agents accessed, when, and what data was
              returned. You can disconnect any integration at any time.
            </p>
          </div>
        </div>
      </div>

      {/* How It Works */}
      <div className="relative z-10 max-w-4xl mx-auto px-6 py-12">
        <h2 className="text-h2 text-[var(--foreground)] mb-8 text-center">
          How It Works
        </h2>
        <div className="space-y-6">
          {[
            {
              step: "1",
              title: "Create a Dashboard",
              desc: "Sign in and create a new dashboard — a shared workspace where you place terminals, notes, browser previews, and integration blocks on an infinite canvas.",
            },
            {
              step: "2",
              title: "Launch a Terminal",
              desc: "Add a terminal block to your dashboard. OrcaBot provisions a sandboxed Linux VM and connects it to your browser via a secure WebSocket.",
            },
            {
              step: "3",
              title: "Run an AI Agent",
              desc: "Start an AI coding agent (Claude Code, Codex, Gemini CLI, etc.) inside the terminal. The agent writes, runs, and tests code in the sandbox.",
            },
            {
              step: "4",
              title: "Connect Integrations (Optional)",
              desc: "Attach Gmail, Drive, Calendar, or GitHub to a terminal so agents can access relevant context. You define policies that control exactly what agents can see and do.",
            },
            {
              step: "5",
              title: "Collaborate & Ship",
              desc: "Share your dashboard with teammates. Everyone can see agent output in real-time, provide input, and review results together.",
            },
          ].map((item) => (
            <div key={item.step} className="flex gap-4 items-start">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-caption font-semibold"
                style={{
                  backgroundColor: `color-mix(in srgb, var(--accent-primary) 15%, transparent)`,
                  color: "var(--accent-primary)",
                }}
              >
                {item.step}
              </div>
              <div>
                <h3 className="text-h4 text-[var(--foreground)] mb-1">
                  {item.title}
                </h3>
                <p className="text-body-sm text-[var(--foreground-muted)] leading-relaxed">
                  {item.desc}
                </p>
              </div>
            </div>
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
      <footer className="relative z-10 border-t border-[var(--border)] py-6">
        <div className="max-w-5xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-micro text-[var(--foreground-disabled)]">
            OrcaBot — Sandboxed, multiplayer AI coding platform
          </p>
          <div className="flex items-center gap-4">
            <a
              href="/privacy"
              className="text-micro text-[var(--foreground-disabled)] underline hover:text-[var(--foreground-subtle)]"
            >
              Privacy Policy
            </a>
            <a
              href="/terms"
              className="text-micro text-[var(--foreground-disabled)] underline hover:text-[var(--foreground-subtle)]"
            >
              Terms of Service
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function IntegrationCarouselRow({
  items,
  direction,
}: {
  items: IntegrationItem[];
  direction: "left" | "right";
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  const [startX, setStartX] = React.useState(0);
  const [scrollLeft, setScrollLeft] = React.useState(0);

  // Auto-scroll animation
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf: number;
    const speed = direction === "left" ? 0.3 : -0.3;

    // Start from end if scrolling right so there's content to reveal
    if (direction === "right") {
      el.scrollLeft = el.scrollWidth - el.clientWidth;
    }

    const step = () => {
      if (!isDragging && el) {
        el.scrollLeft += speed;
        // Loop: if we've scrolled to the end, jump back
        if (direction === "left" && el.scrollLeft >= el.scrollWidth - el.clientWidth) {
          el.scrollLeft = 0;
        } else if (direction === "right" && el.scrollLeft <= 0) {
          el.scrollLeft = el.scrollWidth - el.clientWidth;
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [isDragging, direction]);

  const onPointerDown = (e: React.PointerEvent) => {
    setIsDragging(true);
    setStartX(e.clientX);
    setScrollLeft(scrollRef.current?.scrollLeft ?? 0);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!isDragging || !scrollRef.current) return;
    const dx = e.clientX - startX;
    scrollRef.current.scrollLeft = scrollLeft - dx;
  };

  const onPointerUp = () => setIsDragging(false);

  // Double the items so there's always content to scroll into
  const doubled = [...items, ...items];

  return (
    <div className="relative">
      <div className="absolute left-0 top-0 bottom-0 w-12 z-10 bg-gradient-to-r from-[var(--background)] to-transparent pointer-events-none" />
      <div className="absolute right-0 top-0 bottom-0 w-12 z-10 bg-gradient-to-l from-[var(--background)] to-transparent pointer-events-none" />
      <div
        ref={scrollRef}
        className="flex gap-2 overflow-hidden cursor-grab active:cursor-grabbing select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        {doubled.map((item, i) => {
          const Icon = item.icon;
          return (
            <span
              key={`${item.name}-${i}`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-caption text-[var(--foreground)] bg-[var(--background-elevated)] border border-[var(--border)] rounded-full whitespace-nowrap shrink-0"
            >
              {item.img ? (
                <img src={item.img} alt={item.name} className="w-3.5 h-3.5 object-contain" />
              ) : Icon ? (
                <Icon className="w-3.5 h-3.5 text-[var(--foreground-muted)]" />
              ) : null}
              {item.name}
            </span>
          );
        })}
      </div>
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
        <Icon className="w-5 h-5" style={{ color: feature.accent }} />
      </div>

      <h3 className="text-h4 text-[var(--foreground)] mb-2">{feature.title}</h3>

      <p className="text-body-sm text-[var(--foreground-muted)] leading-relaxed">
        {feature.description}
      </p>
    </div>
  );
}
