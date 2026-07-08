// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: download-page-v1
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

export default function DownloadPage() {
  const [release, setRelease] = React.useState<LatestRelease | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

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
          macOS 13+ · Apple Silicon. Existing installs update automatically.
        </p>
      </main>
    </div>
  );
}
