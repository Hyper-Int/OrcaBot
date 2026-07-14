// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: desktop-welcome-v8-rollback-retry
"use client";

import * as React from "react";
import { toast } from "sonner";
import { CLOUD_SITE_URL } from "@/config/env";
import {
  openExternalUrl,
  signInGoogleLoopback,
  cancelGoogleSignIn,
  rollbackSignIn,
  setCloudCredential,
  verifyOrcabotAccount,
} from "@/lib/tauri-bridge";
import { useDesktopAccountStore } from "@/stores/desktop-account-store";

const MODULE_REVISION = "desktop-welcome-v8-rollback-retry";
if (typeof window !== "undefined") {
  console.log(
    `[desktop-welcome] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
  );
}

/**
 * First-run screen for the desktop app. Three equally-weighted choices — use it
 * free (local, no account), sign in with Google, or paste an Orcabot token — all
 * of which keep the app running on the LOCAL control plane + VM. Signing in only
 * attaches the real identity (data stays local). Shown until a choice is made.
 */
export function DesktopWelcome() {
  const chooseFree = useDesktopAccountStore((s) => s.chooseFree);
  const chooseSignedIn = useDesktopAccountStore((s) => s.chooseSignedIn);

  // "token" opens the paste panel; "google" shows the waiting-for-browser state.
  const [panel, setPanel] = React.useState<null | "token" | "google">(null);

  // Token (PAT) flow
  const [token, setToken] = React.useState("");
  const [tokenBusy, setTokenBusy] = React.useState(false);
  const [tokenError, setTokenError] = React.useState<string | null>(null);

  // Google flow. Each sign-in attempt gets a unique token; `currentAttemptRef`
  // holds the one we'll accept. Cancelling, starting another attempt, or pasting a
  // PAT changes/clears it, so a late-resolving attempt knows it's stale and rolls
  // back ONLY its own credential (never a newer sign-in or a pasted token).
  const [googleError, setGoogleError] = React.useState<string | null>(null);
  const attemptCounterRef = React.useRef(0);
  const currentAttemptRef = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      currentAttemptRef.current = null;
    },
    []
  );

  async function rollbackCancelledAttempt(attempt: number): Promise<void> {
    const toastId = `desktop-signin-rollback-${attempt}`;
    try {
      await rollbackSignIn(attempt);
      toast.success("Cancelled sign-in credential removed.", { id: toastId });
    } catch (e) {
      console.error("[welcome] failed to roll back cancelled sign-in:", e);
      toast.error(
        "The cancelled sign-in credential couldn't be removed locally. Keep the app open and retry cleanup.",
        {
          id: toastId,
          duration: Infinity,
          action: {
            label: "Retry cleanup",
            onClick: () => void rollbackCancelledAttempt(attempt),
          },
        }
      );
    }
  }

  const connectToken = async () => {
    const t = token.trim();
    if (!t) return;
    setTokenBusy(true);
    setTokenError(null);
    // Pasting a PAT supersedes any in-flight Google attempt so its late resolve
    // won't override this choice (the native side also guards the credential).
    currentAttemptRef.current = null;
    try {
      const account = await verifyOrcabotAccount(t);
      // Keep the token as the cloud credential so we can list/download the user's
      // cloud dashboards (the app still runs locally; this is only for sync).
      await setCloudCredential(t, account.email);
      chooseSignedIn(account.email, account.name || account.email);
    } catch (e) {
      setTokenError(e instanceof Error ? e.message : String(e));
    } finally {
      setTokenBusy(false);
    }
  };

  const startGoogle = async () => {
    const myAttempt = ++attemptCounterRef.current;
    currentAttemptRef.current = myAttempt;
    setGoogleError(null);
    setPanel("google");
    try {
      // Loopback sign-in (RFC 8252): the native layer opens the OS browser to the
      // cloud login, receives the result on a local 127.0.0.1 listener, and stores
      // the PAT host-only — the token never enters this webview. Resolves with the
      // identity once done. Google needs a real browser (blocks embedded webviews),
      // and this authenticates against the CLOUD so we get a credential for sync.
      const account = await signInGoogleLoopback();
      if (currentAttemptRef.current !== myAttempt) {
        // Superseded (cancelled / another attempt / PAT pasted): roll back ONLY this
        // attempt's credential — a no-op natively if something newer now owns it.
        // Keep the attempt id alive in a persistent retry action if local deletion
        // fails; restarting would discard the native ownership mapping.
        void rollbackCancelledAttempt(account.attempt);
        return;
      }
      chooseSignedIn(account.email, account.name || account.email);
      // chooseSignedIn unmounts this component.
    } catch (e) {
      if (currentAttemptRef.current !== myAttempt) return; // stale attempt — ignore
      setGoogleError(
        e instanceof Error ? e.message : "Couldn't complete Google sign-in."
      );
      setPanel(null);
    }
  };

  const cancelGoogle = () => {
    // Drop the current attempt so a late resolve rolls itself back instead of
    // signing in, and stop the native flow (it keeps waiting/exchanging otherwise).
    currentAttemptRef.current = null;
    void cancelGoogleSignIn();
    setPanel(null);
  };

  const optionClass =
    "w-full rounded-xl px-5 py-4 text-left border border-[var(--border)] " +
    "hover:bg-[var(--background-elevated)] hover:border-[var(--foreground)]/30 " +
    "transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent,#5b8cff)]";

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
        <p className="mt-2 text-sm opacity-60">
          Everything runs locally on this machine — pick how you sign in.
        </p>

        {panel === "google" ? (
          <div className="mt-8 rounded-xl border border-[var(--border)] p-5 text-center">
            <div
              aria-hidden
              className="mx-auto mb-3 h-5 w-5 rounded-full border-2 border-[var(--foreground)]/25"
              style={{
                borderTopColor: "var(--accent,#5b8cff)",
                animation: "orcaSpin 0.8s linear infinite",
              }}
            />
            <div className="text-sm font-medium">Waiting for Google sign-in…</div>
            <div className="mt-1 text-xs opacity-60">
              Finish signing in in your browser, then return here.
            </div>
            <button
              type="button"
              onClick={cancelGoogle}
              className="mt-4 text-xs opacity-60 hover:opacity-100"
            >
              Cancel
            </button>
            <style>{`@keyframes orcaSpin { to { transform: rotate(360deg); } }`}</style>
          </div>
        ) : (
          <div className="mt-8 space-y-3">
            {/* 1. Local / no account */}
            <button type="button" onClick={chooseFree} className={optionClass}>
              <div className="text-base font-semibold">Local Desktop Use</div>
              <div className="text-sm opacity-70">
                No account required. Uses local storage.
              </div>
            </button>

            {/* 2. Google */}
            <button
              type="button"
              onClick={() => void startGoogle()}
              className={optionClass}
            >
              <div className="text-base font-semibold">Sign in with Google</div>
              <div className="text-sm opacity-70">
                Use your orcabot.com Google account.
              </div>
            </button>

            {/* 3. Token */}
            <button
              type="button"
              onClick={() => setPanel(panel === "token" ? null : "token")}
              className={optionClass}
              aria-expanded={panel === "token"}
            >
              <div className="text-base font-semibold">Sign in with a token</div>
              <div className="text-sm opacity-70">
                Paste an Orcabot personal access token.
              </div>
            </button>

            {googleError && (
              <div className="text-xs text-[var(--error,#ef4444)]">{googleError}</div>
            )}

            {panel === "token" && (
              <div className="rounded-xl border border-[var(--border)] p-4 text-left">
                <ol className="text-xs opacity-70 list-decimal list-inside space-y-1">
                  <li>Open orcabot.com and sign in.</li>
                  <li>In Settings, create a personal access token.</li>
                  <li>Paste it below.</li>
                </ol>
                <button
                  type="button"
                  onClick={() =>
                    void openExternalUrl(`${CLOUD_SITE_URL}/settings`)
                  }
                  className="mt-3 text-xs font-medium text-[var(--accent,#5b8cff)] hover:underline"
                >
                  Open orcabot.com settings →
                </button>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value);
                    if (tokenError) setTokenError(null);
                  }}
                  placeholder="orca_pat_…"
                  autoComplete="off"
                  spellCheck={false}
                  className="mt-3 w-full rounded-lg bg-[var(--background)] border border-[var(--border)] px-3 py-2 text-sm outline-none focus:border-[var(--accent,#5b8cff)]"
                />
                {tokenError && (
                  <div className="mt-2 text-xs text-[var(--error,#ef4444)]">
                    {tokenError}
                  </div>
                )}
                <button
                  type="button"
                  disabled={tokenBusy || !token.trim()}
                  onClick={() => void connectToken()}
                  className="mt-3 rounded-lg px-4 py-2 text-sm font-semibold bg-[var(--foreground)] text-[var(--background)] disabled:opacity-40"
                >
                  {tokenBusy ? "Connecting…" : "Connect"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default DesktopWelcome;
