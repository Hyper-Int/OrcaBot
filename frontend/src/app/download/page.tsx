// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: download-page-v2-min-os-warn
"use client";

import "./download.css";
import * as React from "react";
import Markdown from "react-markdown";
import { SiteHeader } from "@/components/SiteHeader";
import {
  getLatestRelease,
  pickMacInstaller,
  formatBytes,
  type LatestRelease,
} from "@/lib/api/releases";

const GITHUB_RELEASES = "https://github.com/Hyper-Int/OrcaBot/releases/latest";

// Minimum macOS the bundled workerd runtime supports (built with minos 13.5).
// Older Macs crash at startup (dyld: __libcpp_verbose_abort not found), so we
// surface the requirement before the download rather than after a broken launch.
const MIN_MACOS = "13.5";

const MODULE_REVISION = "download-page-v2-min-os-warn";
if (typeof window !== "undefined") {
  // eslint-disable-next-line no-console
  console.log(`[download] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

// Best-effort check to save pre-13.5 users a wasted download. Only Chromium
// exposes the real macOS version (UA Client Hints); Safari/Firefox don't, and
// navigator.userAgent is privacy-frozen at "10_15_7" on macOS. So this is
// advisory only — it never disables the button (a wrong guess must not block a
// valid download). Returns the detected version string when confidently < 13.5.
async function detectOldMacOS(): Promise<string | null> {
  try {
    const uaData = (navigator as unknown as {
      userAgentData?: {
        platform?: string;
        getHighEntropyValues?: (hints: string[]) => Promise<{ platformVersion?: string }>;
      };
    }).userAgentData;
    if (!uaData?.getHighEntropyValues || uaData.platform !== "macOS") return null;
    const hints = await uaData.getHighEntropyValues(["platformVersion"]);
    const raw = String(hints.platformVersion || "");
    const parts = raw.split(".").map((n) => parseInt(n, 10) || 0);
    const [maj, min] = parts;
    // major 10 (or 0) = privacy-frozen "10.15.7" or a pre-ARM Mac — can't trust
    // it as a real version, so don't warn (avoid false positives).
    if (!maj || maj === 10) return null;
    if (maj < 13 || (maj === 13 && min < 5)) return raw;
    return null;
  } catch {
    return null;
  }
}

export default function DownloadPage() {
  const [release, setRelease] = React.useState<LatestRelease | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [oldMac, setOldMac] = React.useState<string | null>(null);

  React.useEffect(() => {
    detectOldMacOS().then(setOldMac);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    getLatestRelease()
      .then((r) => {
        if (!cancelled) {
          setRelease(r);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load release");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const primary = release ? pickMacInstaller(release.assets) : null;
  const assets = release ? release.assets : [];

  return (
    <div className="dl-page">
      <SiteHeader section="Download" position="sticky" glass />
      <main className="dl-main">
        <section className="dl-hero">
          <img src="/orca.png" alt="" className="dl-orca" />
          <h1>Download Orcabot</h1>
          <p className="dl-sub">
            Run Claude Code, Codex, and a full sandboxed stack locally — no setup.
          </p>

          {oldMac && (
            <p className="dl-error">
              You appear to be on macOS {oldMac}. Orcabot requires macOS {MIN_MACOS} or
              later and won’t start on older versions — updating macOS first will save
              you a wasted download.
            </p>
          )}

          {loading && <p className="dl-muted">Loading the latest release…</p>}

          {error && (
            <p className="dl-error">
              Couldn’t load the release.{" "}
              <a href={GITHUB_RELEASES}>Download on GitHub →</a>
            </p>
          )}

          {release && (
            <>
              <div className="dl-cta">
                {primary ? (
                  <a className="dl-btn dl-btn-primary" href={primary.downloadUrl}>
                    Download for macOS
                    <span className="dl-btn-sub">
                      Apple Silicon · {formatBytes(primary.size)}
                    </span>
                  </a>
                ) : (
                  <a className="dl-btn dl-btn-primary" href={release.htmlUrl}>
                    Download on GitHub
                  </a>
                )}
              </div>
              <p className="dl-muted dl-req">
                Requires macOS {MIN_MACOS} or later · Apple Silicon
              </p>
              <div className="dl-meta">
                <span className="dl-version">v{release.version}</span>
                <span className="dl-badge">Latest</span>
                {release.publishedAt && (
                  <span>
                    {" · "}
                    {new Date(release.publishedAt).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                )}
                {" · "}
                <a href={release.htmlUrl} target="_blank" rel="noreferrer">
                  View on GitHub ↗
                </a>
              </div>
            </>
          )}
        </section>

        {release && release.notes && (
          <section className="dl-card">
            <h2>What’s new{release.name ? ` — ${release.name}` : ""}</h2>
            <div className="dl-notes">
              <Markdown>{release.notes}</Markdown>
            </div>
          </section>
        )}

        {release && assets.length > 0 && (
          <section className="dl-card">
            <h2>Assets</h2>
            <ul className="dl-assets">
              {assets.map((a) => (
                <li key={a.name}>
                  <a href={a.downloadUrl}>{a.name}</a>
                  <span className="dl-muted">{formatBytes(a.size)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="dl-foot dl-muted">
          macOS {MIN_MACOS}+ · Apple Silicon. Existing installs update automatically.
        </p>
      </main>
    </div>
  );
}
