// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: desktop-welcome-v2-three-options-google
"use client";

import * as React from "react";
import { CLOUDFLARE_API_URL, CLOUD_SITE_URL } from "@/config/env";
import {
  ensureSurfaceToken,
  getCachedSurfaceToken,
  onAppFocus,
  openExternalUrl,
  verifyOrcabotAccount,
} from "@/lib/tauri-bridge";
import { useDesktopAccountStore } from "@/stores/desktop-account-store";

const MODULE_REVISION = "desktop-welcome-v2-three-options-google";
if (typeof window !== "undefined") {
  console.log(
    `[desktop-welcome] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
  );
}

function randomNonce(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

  // Google flow
  const [googleError, setGoogleError] = React.useState<string | null>(null);
  const googleCancelRef = React.useRef(false);
  React.useEffect(
    () => () => {
      googleCancelRef.current = true;
    },
    []
  );

  const connectToken = async () => {
    const t = token.trim();
    if (!t) return;
    setTokenBusy(true);
    setTokenError(null);
    try {
      const account = await verifyOrcabotAccount(t);
      chooseSignedIn(account.email, account.name || account.email);
    } catch (e) {
      setTokenError(e instanceof Error ? e.message : String(e));
    } finally {
      setTokenBusy(false);
    }
  };

  const startGoogle = async () => {
    googleCancelRef.current = false;
    setGoogleError(null);
    setPanel("google");
    let unfocus: (() => void) | null = null;
    try {
      const nonce = randomNonce();
      await ensureSurfaceToken();
      const surface = getCachedSurfaceToken();
      const base = CLOUDFLARE_API_URL;

      // Open the OS browser to the LOCAL control plane's Google login. Google
      // requires a real browser (it blocks OAuth in embedded webviews), so we
      // poll for the result by nonce rather than getting a callback in-app.
      await openExternalUrl(
        `${base}/auth/google/login?mode=desktop&nonce=${encodeURIComponent(nonce)}`
      );

      const pollOnce = async (): Promise<boolean> => {
        try {
          const resp = await fetch(
            `${base}/auth/desktop/google-result?nonce=${encodeURIComponent(nonce)}`,
            {
              headers: surface ? { "X-Orcabot-Surface": surface } : {},
              cache: "no-store",
            }
          );
          if (resp.ok) {
            const data = (await resp.json()) as {
              email?: string;
              name?: string;
            };
            if (data.email) {
              chooseSignedIn(data.email, data.name || data.email);
              return true;
            }
          }
        } catch {
          /* keep polling */
        }
        return false;
      };

      // Poll immediately whenever the app regains focus (i.e. you switch back
      // from the browser after signing in), plus a steady background poll.
      unfocus = await onAppFocus(() => {
        void pollOnce();
      });

      const deadline = Date.now() + 150_000; // 2.5 min
      while (!googleCancelRef.current && Date.now() < deadline) {
        if (await pollOnce()) return; // success → chooseSignedIn unmounts this
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!googleCancelRef.current) {
        setGoogleError("Sign-in timed out. Please try again.");
        setPanel(null);
      }
    } catch (e) {
      setGoogleError(
        e instanceof Error ? e.message : "Couldn't start Google sign-in."
      );
      setPanel(null);
    } finally {
      if (unfocus) unfocus();
    }
  };

  const cancelGoogle = () => {
    googleCancelRef.current = true;
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
            {/* 1. Free / local */}
            <button type="button" onClick={chooseFree} className={optionClass}>
              <div className="text-base font-semibold">Free Desktop Use</div>
              <div className="text-sm opacity-70">
                Start now — no account, runs entirely on your computer.
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
