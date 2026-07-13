// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: dashboards-tabs-v2-local-tab-on-free
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, HardDrive, Trash2, Link2, Plus, Loader2 } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@/components/ui";
import { DESKTOP_MODE } from "@/config/env";
import { getCloudAccount, listCloudDashboards } from "@/lib/tauri-bridge";
import { downloadCloudDashboard } from "@/lib/cloud-sync";
import { formatRelativeTime, cn } from "@/lib/utils";
import type { Dashboard } from "@/types/dashboard";

const MODULE_REVISION = "dashboards-tabs-v2-local-tab-on-free";
if (typeof window !== "undefined") {
  console.log(
    `[dashboards-tabs] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
  );
}

interface CloudDashboard {
  id: string;
  name: string;
  updatedAt?: string;
}

/**
 * "Your Dashboards" with two tabs — **Online** (your cloud account's dashboards)
 * and **Local Storage** (what's on this machine). Only shown when signed in to a
 * cloud account; a Free/local-only session sees just the local grid (no tabs, no
 * Online tab). Signing in defaults to the Online tab.
 *
 * A cloud dashboard shows a ⬇ Download until it's pulled local; once downloaded it
 * reads "Local Storage" and appears in BOTH tabs (launchable from either) since it
 * now exists as a local dashboard with a matching `cloudId`.
 */
export function DashboardsTabs({
  localDashboards,
  isLoading,
  error,
  onRetry,
  onOpen,
  onDelete,
  onCreateFirst,
  onDownloaded,
}: {
  localDashboards: Dashboard[];
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  onOpen: (localDashboardId: string) => void;
  onDelete: (dashboard: Dashboard) => void;
  onCreateFirst: () => void;
  onDownloaded: () => void;
}) {
  const [cloudEmail, setCloudEmail] = React.useState<string | null>(null);
  const [downloading, setDownloading] = React.useState<Set<string>>(new Set());
  const [downloadError, setDownloadError] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<"online" | "local">("local");
  const defaultedToOnline = React.useRef(false);

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

  const hasCloud = DESKTOP_MODE && !!cloudEmail;

  const { data: cloudDashboards, isLoading: cloudLoading } = useQuery({
    queryKey: ["cloud-dashboards"],
    queryFn: async (): Promise<CloudDashboard[]> => {
      // /dashboards wraps the list as { dashboards: [...] }; tolerate a bare array
      // too. Never return a non-array (guards the .map below).
      const raw = await listCloudDashboards();
      if (Array.isArray(raw)) return raw as CloudDashboard[];
      const wrapped = (raw as { dashboards?: unknown })?.dashboards;
      return Array.isArray(wrapped) ? (wrapped as CloudDashboard[]) : [];
    },
    enabled: hasCloud,
    staleTime: 30_000,
  });

  // Signing in defaults to the Online tab (once); logging out drops back to Local
  // and re-arms the default so the next sign-in lands on Online again.
  React.useEffect(() => {
    if (hasCloud && !defaultedToOnline.current) {
      defaultedToOnline.current = true;
      setTab("online");
    } else if (!hasCloud) {
      defaultedToOnline.current = false;
      setTab("local");
    }
  }, [hasCloud]);

  const localByCloudId = React.useMemo(() => {
    const m = new Map<string, Dashboard>();
    for (const d of localDashboards) if (d.cloudId) m.set(d.cloudId, d);
    return m;
  }, [localDashboards]);

  const cloudList = cloudDashboards ?? [];

  const download = async (cd: CloudDashboard) => {
    setDownloadError(null);
    setDownloading((s) => new Set(s).add(cd.id));
    try {
      await downloadCloudDashboard(cd.id, cd.name);
      onDownloaded();
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setDownloading((s) => {
        const next = new Set(s);
        next.delete(cd.id);
        return next;
      });
    }
  };

  const gridClass = "grid grid-cols-1 md:grid-cols-2 gap-4";

  const localGrid = () => {
    if (isLoading) {
      return (
        <div className={gridClass}>
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      );
    }
    if (error) {
      return (
        <div className="text-center py-12">
          <p className="text-body text-[var(--status-error)]">
            Failed to load dashboards. Please try again.
          </p>
          <Button variant="secondary" className="mt-4" onClick={onRetry}>
            Retry
          </Button>
        </div>
      );
    }
    if (localDashboards.length > 0) {
      return (
        <div className={gridClass}>
          {localDashboards.map((dashboard) => (
            <DashboardCard
              key={dashboard.id}
              dashboard={dashboard}
              onClick={() => onOpen(dashboard.id)}
              onDelete={() => onDelete(dashboard)}
            />
          ))}
        </div>
      );
    }
    return (
      <div className="text-center py-12 border border-dashed border-[var(--border)] rounded-lg">
        <p className="text-body text-[var(--foreground-muted)] mb-4">
          No dashboards yet. Create your first one!
        </p>
        <Button
          variant="primary"
          onClick={onCreateFirst}
          leftIcon={<Plus className="w-4 h-4" />}
        >
          New Dashboard
        </Button>
      </div>
    );
  };

  const onlineGrid = () => {
    if (cloudLoading && cloudList.length === 0) {
      return (
        <div className={gridClass}>
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      );
    }
    if (cloudList.length === 0) {
      return (
        <div className="text-center py-12 border border-dashed border-[var(--border)] rounded-lg">
          <p className="text-body text-[var(--foreground-muted)]">
            No dashboards in your cloud account yet.
          </p>
        </div>
      );
    }
    return (
      <div className={gridClass}>
        {cloudList.map((cd) => (
          <CloudDashboardCard
            key={cd.id}
            cd={cd}
            local={localByCloudId.get(cd.id)}
            isDownloading={downloading.has(cd.id)}
            onDownload={() => void download(cd)}
            onOpen={onOpen}
          />
        ))}
      </div>
    );
  };

  return (
    <section>
      <h2 className="text-h2 text-[var(--foreground)] mb-4">Your Dashboards</h2>

      {/* Desktop always shows the tab bar (Local Storage tab + count is always
          present, even on Free); the Online tab only appears once signed in. Web
          has no cloud/local split, so it renders just the grid below. */}
      {DESKTOP_MODE && (
        <div className="flex items-center gap-1 mb-4 border-b border-[var(--border)]">
          {hasCloud && (
            <TabButton
              active={tab === "online"}
              onClick={() => setTab("online")}
              label="Online"
              count={cloudList.length}
            />
          )}
          <TabButton
            active={tab === "local"}
            onClick={() => setTab("local")}
            label="Local Storage"
            count={localDashboards.length}
          />
        </div>
      )}

      {downloadError && hasCloud && tab === "online" && (
        <div className="mb-3 text-sm text-[var(--status-error,#ef4444)]">
          {downloadError}
        </div>
      )}

      {hasCloud && tab === "online" ? onlineGrid() : localGrid()}
    </section>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
        active
          ? "border-[var(--accent,#5b8cff)] text-[var(--foreground)]"
          : "border-transparent text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
      )}
    >
      {label}{" "}
      <span className="text-[var(--foreground-subtle)]">({count})</span>
    </button>
  );
}

function CloudDashboardCard({
  cd,
  local,
  isDownloading,
  onDownload,
  onOpen,
}: {
  cd: CloudDashboard;
  local: Dashboard | undefined;
  isDownloading: boolean;
  onDownload: () => void;
  onOpen: (localDashboardId: string) => void;
}) {
  const downloaded = !!local;
  return (
    <Card
      className={cn(
        "group transition-colors",
        downloaded && "cursor-pointer hover:border-[var(--border-strong)]"
      )}
    >
      <div onClick={downloaded ? () => onOpen(local!.id) : undefined}>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="truncate">{cd.name}</CardTitle>
            {downloaded ? (
              <span
                className="inline-flex items-center gap-1 text-xs font-medium text-[var(--status-success,#34d399)] shrink-0"
                title="Downloaded to this machine — click to open"
              >
                <HardDrive className="w-3.5 h-3.5" /> Local Storage
              </span>
            ) : (
              <button
                type="button"
                disabled={isDownloading}
                onClick={(e) => {
                  e.stopPropagation();
                  onDownload();
                }}
                className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent,#5b8cff)] hover:underline disabled:opacity-50 shrink-0"
                title="Download into this machine"
              >
                {isDownloading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                {isDownloading ? "Downloading…" : "Download"}
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-caption text-[var(--foreground-subtle)]">
            {cd.updatedAt
              ? `Updated ${formatRelativeTime(cd.updatedAt)}`
              : "In your cloud account"}
          </p>
        </CardContent>
      </div>
    </Card>
  );
}

function DashboardCard({
  dashboard,
  onClick,
  onDelete,
}: {
  dashboard: Dashboard;
  onClick: () => void;
  onDelete: () => void;
}) {
  const isLinked = (dashboard.linkedCount ?? 0) > 0;

  return (
    <Card className="group cursor-pointer hover:border-[var(--border-strong)] transition-colors">
      <div onClick={onClick}>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-1.5 min-w-0">
              <CardTitle className="truncate">{dashboard.name}</CardTitle>
              {isLinked && (
                <span
                  title={`${dashboard.linkedCount} linked dashboard${dashboard.linkedCount !== 1 ? "s" : ""}`}
                >
                  <Link2 className="w-3.5 h-3.5 flex-shrink-0 text-[var(--foreground-muted)]" />
                </span>
              )}
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="opacity-0 group-hover:opacity-100 p-1 hover:bg-[var(--background-hover)] rounded transition-all"
            >
              <Trash2 className="w-4 h-4 text-[var(--foreground-subtle)] hover:text-[var(--status-error)]" />
            </button>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-caption text-[var(--foreground-subtle)]">
            Updated {formatRelativeTime(dashboard.updatedAt)}
          </p>
        </CardContent>
      </div>
    </Card>
  );
}

export default DashboardsTabs;
