// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: desktop-welcome-v1
"use client";

import * as React from "react";
import { CLOUD_SITE_URL } from "@/config/env";
import { openExternalUrl, verifyOrcabotAccount } from "@/lib/tauri-bridge";
import { useDesktopAccountStore } from "@/stores/desktop-account-store";

const MODULE_REVISION = "desktop-welcome-v1";
if (typeof window !== "undefined") {
  console.log(
    `[desktop-welcome] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
  );
}

/**
 * First-run screen for the desktop app. Offers "Free Desktop Use" (the local,
 * no-account experience — everything runs on this machine) prominently above an
 * option to connect an orcabot.com account. Either way the app runs on the LOCAL
 * control plane + VM; signing in only attaches the real identity (and, later,
 * cloud sync). Shown only until a choice is made (persisted).
 */
export function DesktopWelcome() {
  const chooseFree = useDesktopAccountStore((s) => s.chooseFree);
  const chooseSignedIn = useDesktopAccountStore((s) => s.chooseSignedIn);

  const [showSignIn, setShowSignIn] = React.useState(false);
  const [token, setToken] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const connect = async () => {
    const t = token.trim();
    if (!t) return;
    if (!t.startsWith("orca_pat_")) {
      setError("That doesn't look like an Orcabot token (starts with orca_pat_).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Verify the token + read the identity via the native layer (no CORS). The
      // app still runs locally; we just use the real email/name as the local
      // account identity, and this proves the token is valid before we trust it.
      const account = await verifyOrcabotAccount(t);
      chooseSignedIn(account.email, account.name || account.email);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[2147483000] flex items-center justify-center bg-[var(--background)] text-[var(--foreground)] p-6">
      <div className="w-full max-w-md text-center">
        <img
          src="/orca.png"
          alt="Orcabot"
          className="w-16 h-16 object-contain mx-auto mb-4"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
        <h1 className="text-2xl font-bold tracking-tight">Welcome to Orcabot</h1>
        <p className="mt-2 text-sm text-[var(--foreground)] opacity-60">
          Everything runs locally on this machine either way.
        </p>

        {/* Primary: free, local, no account */}
        <button
          type="button"
          onClick={chooseFree}
          className="mt-8 w-full rounded-xl px-5 py-4 text-left bg-[var(--foreground)] text-[var(--background)] hover:opacity-90 transition-opacity"
        >
          <div className="text-base font-semibold">Free Desktop Use</div>
          <div className="text-sm opacity-75">
            Start now — no account needed. Runs entirely on your computer.
          </div>
        </button>

        <div className="my-5 flex items-center gap-3 text-xs opacity-40">
          <span className="h-px flex-1 bg-current" />
          <span>or</span>
          <span className="h-px flex-1 bg-current" />
        </div>

        {!showSignIn ? (
          <button
            type="button"
            onClick={() => setShowSignIn(true)}
            className="w-full rounded-xl px-5 py-3 border border-[var(--border)] hover:bg-[var(--background-elevated)] transition-colors text-sm font-medium"
          >
            Sign in with your orcabot.com account
          </button>
        ) : (
          <div className="rounded-xl border border-[var(--border)] p-4 text-left">
            <div className="text-sm font-medium">Connect your orcabot.com account</div>
            <ol className="mt-2 text-xs opacity-70 list-decimal list-inside space-y-1">
              <li>Open orcabot.com and sign in.</li>
              <li>In Settings, create a personal access token.</li>
              <li>Paste it below.</li>
            </ol>
            <button
              type="button"
              onClick={() => void openExternalUrl(`${CLOUD_SITE_URL}/settings`)}
              className="mt-3 text-xs font-medium text-[var(--accent,#5b8cff)] hover:underline"
            >
              Open orcabot.com settings →
            </button>
            <input
              type="password"
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                if (error) setError(null);
              }}
              placeholder="orca_pat_…"
              autoComplete="off"
              spellCheck={false}
              className="mt-3 w-full rounded-lg bg-[var(--background)] border border-[var(--border)] px-3 py-2 text-sm outline-none focus:border-[var(--accent,#5b8cff)]"
            />
            {error && (
              <div className="mt-2 text-xs text-[var(--error,#ef4444)]">{error}</div>
            )}
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                disabled={busy || !token.trim()}
                onClick={() => void connect()}
                className="rounded-lg px-4 py-2 text-sm font-semibold bg-[var(--foreground)] text-[var(--background)] disabled:opacity-40"
              >
                {busy ? "Connecting…" : "Connect"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowSignIn(false);
                  setError(null);
                }}
                className="rounded-lg px-3 py-2 text-sm opacity-60 hover:opacity-100"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default DesktopWelcome;
