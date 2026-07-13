// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: cloud-dashboards-section-v1
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Check, Loader2, Cloud } from "lucide-react";
import { DESKTOP_MODE } from "@/config/env";
import { getCloudAccount, listCloudDashboards } from "@/lib/tauri-bridge";
import { downloadCloudDashboard } from "@/lib/cloud-sync";
import type { Dashboard } from "@/types";

const MODULE_REVISION = "cloud-dashboards-section-v1";
if (typeof window !== "undefined") {
  console.log(
    `[cloud-dashboards-section] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
  );
}

interface CloudDashboard {
  id: string;
  name: string;
  updatedAt?: string;
}

/**
 * Desktop-only picker section: lists the signed-in user's CLOUD dashboards with a
 * download (⬇) button, and a downloaded (✓) state for ones already pulled into the
 * local DB. Downloading materializes the dashboard locally (see cloud-sync) and it
 * then runs on the local VM. Renders nothing unless signed in to a cloud account.
 */
export function CloudDashboardsSection({
  localDashboards,
  onOpen,
  onDownloaded,
}: {
  localDashboards: Dashboard[];
  onOpen: (localDashboardId: string) => void;
  onDownloaded: () => void;
}) {
  const [cloudEmail, setCloudEmail] = React.useState<string | null>(null);
  const [downloading, setDownloading] = React.useState<Set<string>>(new Set());
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!DESKTOP_MODE) return;
    let alive = true;
    getCloudAccount()
      .then((acc) => {
        if (alive) setCloudEmail(acc?.email ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const { data: cloudDashboards, isLoading } = useQuery({
    queryKey: ["cloud-dashboards"],
    queryFn: async () => (await listCloudDashboards()) as CloudDashboard[],
    enabled: DESKTOP_MODE && !!cloudEmail,
    staleTime: 30_000,
  });

  if (!DESKTOP_MODE || !cloudEmail) return null;

  // Map cloud dashboard id → the local dashboard that was downloaded from it.
  const localByCloudId = new Map<string, Dashboard>();
  for (const d of localDashboards) {
    if (d.cloudId) localByCloudId.set(d.cloudId, d);
  }

  const download = async (cd: CloudDashboard) => {
    setError(null);
    setDownloading((s) => new Set(s).add(cd.id));
    try {
      await downloadCloudDashboard(cd.id, cd.name);
      onDownloaded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setDownloading((s) => {
        const next = new Set(s);
        next.delete(cd.id);
        return next;
      });
    }
  };

  return (
    <section className="mb-8">
      <div className="flex items-center gap-2 mb-4">
        <Cloud className="w-4 h-4 text-[var(--foreground-muted)]" />
        <h2 className="text-h2 text-[var(--foreground)]">Your cloud dashboards</h2>
        <span className="text-caption text-[var(--foreground-muted)]">{cloudEmail}</span>
      </div>

      {error && (
        <div className="mb-3 text-sm text-[var(--status-error,#ef4444)]">{error}</div>
      )}

      {isLoading ? (
        <div className="text-sm text-[var(--foreground-muted)] flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : !cloudDashboards || cloudDashboards.length === 0 ? (
        <div className="text-sm text-[var(--foreground-muted)]">
          No dashboards in your cloud account yet.
        </div>
      ) : (
        <div className="border border-[var(--border)] rounded-lg divide-y divide-[var(--border)]">
          {cloudDashboards.map((cd) => {
            const local = localByCloudId.get(cd.id);
            const isDownloading = downloading.has(cd.id);
            return (
              <div key={cd.id} className="flex items-center justify-between px-4 py-3">
                <span className="text-sm font-medium truncate">{cd.name}</span>
                {local ? (
                  <button
                    type="button"
                    onClick={() => onOpen(local.id)}
                    className="flex items-center gap-1.5 text-xs font-medium text-[var(--status-success,#34d399)] hover:underline"
                    title="Downloaded — open the local copy"
                  >
                    <Check className="w-4 h-4" /> Downloaded
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={isDownloading}
                    onClick={() => void download(cd)}
                    className="flex items-center gap-1.5 text-xs font-medium text-[var(--accent,#5b8cff)] hover:underline disabled:opacity-50"
                    title="Download into this machine"
                  >
                    {isDownloading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Download className="w-4 h-4" />
                    )}
                    {isDownloading ? "Downloading…" : "Download"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default CloudDashboardsSection;
