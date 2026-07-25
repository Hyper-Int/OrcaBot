// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// Client for the control plane's /releases/latest endpoint (a public, cached
// proxy of the GitHub Releases API) — powers the on-site /download page.

import { API } from "@/config/env";

export interface ReleaseAsset {
  name: string;
  size: number;
  downloadUrl: string;
  contentType: string;
  downloadCount: number;
}

export interface LatestRelease {
  version: string;
  name: string;
  notes: string;
  htmlUrl: string;
  publishedAt: string;
  assets: ReleaseAsset[];
}

export async function getLatestRelease(): Promise<LatestRelease> {
  const res = await fetch(API.cloudflare.releasesLatest, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to load latest release (${res.status})`);
  }
  return (await res.json()) as LatestRelease;
}

/** Human-readable file size, e.g. 1038066117 → "990 MB". */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

/**
 * The primary macOS installer to feature on the download button. Prefers a
 * `.dmg`, falls back to a `.zip` (salvaged builds ship a zip). Ignores the
 * updater tarball (`.app.tar.gz`) and signature/manifest files.
 */
export function pickMacInstaller(assets: ReleaseAsset[]): ReleaseAsset | null {
  const installable = assets.filter(
    (a) => !a.name.endsWith(".tar.gz") && !a.name.endsWith(".sig") && a.name !== "latest.json"
  );
  return (
    installable.find((a) => a.name.endsWith(".dmg")) ||
    installable.find((a) => a.name.endsWith(".zip")) ||
    null
  );
}
