// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
"use client";

// REVISION: admin-metrics-v1-initial
const MODULE_REVISION = "admin-metrics-v1-initial";
console.log(
  `[admin] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, RefreshCw } from "lucide-react";

import {
  Button,
  Skeleton,
  ThemeToggle,
  Tooltip,
} from "@/components/ui";
import { useAuthStore } from "@/stores/auth-store";
import { getAdminMetrics, type AdminMetrics } from "@/lib/api/cloudflare";

// ===== Sub-components =====

function StatCard({
  label,
  value,
  subtitle,
}: {
  label: string;
  value: string | number;
  subtitle?: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--background-elevated)] p-5">
      <p className="text-caption text-[var(--foreground-muted)] mb-1">{label}</p>
      <p className="text-3xl font-semibold text-[var(--foreground)]">{value}</p>
      {subtitle && (
        <p className="text-caption text-[var(--foreground-subtle)] mt-1">
          {subtitle}
        </p>
      )}
    </div>
  );
}

function DataTable<T extends Record<string, unknown>>({
  title,
  columns,
  rows,
  emptyText = "No data",
}: {
  title: string;
  columns: { key: string; label: string; align?: "left" | "right" }[];
  rows: T[];
  emptyText?: string;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--background-elevated)] overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--border)]">
        <h3 className="text-body font-medium text-[var(--foreground)]">
          {title}
        </h3>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-caption text-[var(--foreground-muted)]">
          {emptyText}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--background)]">
                {columns.map((col) => (
                  <th
                    key={col.key}
                    className={`px-4 py-2 font-medium text-[var(--foreground-muted)] ${
                      col.align === "right" ? "text-right" : "text-left"
                    }`}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={i}
                  className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--background-hover)]"
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={`px-4 py-2 text-[var(--foreground)] ${
                        col.align === "right" ? "text-right" : "text-left"
                      }`}
                    >
                      {String(row[col.key] ?? "—")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ===== Main Page =====

export default function AdminMetricsPage() {
  const router = useRouter();
  const { isAuthenticated, isAuthResolved, isAdmin } = useAuthStore();

  // Auth + admin gate
  React.useEffect(() => {
    if (!isAuthResolved) return;
    if (!isAuthenticated || !isAdmin) {
      router.push("/dashboards");
    }
  }, [isAuthenticated, isAuthResolved, isAdmin, router]);

  const {
    data: metrics,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useQuery<AdminMetrics>({
    queryKey: ["admin-metrics"],
    queryFn: getAdminMetrics,
    enabled: isAuthenticated && isAuthResolved && isAdmin,
    refetchInterval: 5 * 60 * 1000, // 5 minutes
  });

  if (!isAuthResolved || !isAuthenticated || !isAdmin) {
    return null;
  }

  return (
    <div className="min-h-screen bg-[var(--background)]">
      {/* Header */}
      <header className="border-b border-[var(--border)] bg-[var(--background-elevated)]">
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img
              src="/orca.png"
              alt="Orcabot"
              className="w-7 h-7 object-contain"
            />
            <span className="text-h4 text-[var(--foreground)]">
              Admin Metrics
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Tooltip content="Refresh metrics">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => refetch()}
                disabled={isFetching}
                leftIcon={
                  <RefreshCw
                    className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`}
                  />
                }
              >
                Refresh
              </Button>
            </Tooltip>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push("/dashboards")}
              leftIcon={<ArrowLeft className="w-4 h-4" />}
            >
              Dashboards
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {/* Loading State */}
        {isLoading && (
          <div className="space-y-8">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-24 rounded-lg" />
              ))}
            </div>
            <div className="grid grid-cols-3 gap-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-24 rounded-lg" />
              ))}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Skeleton className="h-64 rounded-lg" />
              <Skeleton className="h-64 rounded-lg" />
            </div>
          </div>
        )}

        {/* Error State */}
        {error && !isLoading && (
          <div className="text-center py-16">
            <p className="text-body text-[var(--status-error)] mb-2">
              {(error as { status?: number })?.status === 403
                ? "Access Denied — admin privileges required."
                : "Failed to load metrics."}
            </p>
            <Button variant="secondary" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        )}

        {/* Data */}
        {metrics && !isLoading && (
          <>
            {/* Overview Cards */}
            <section>
              <h2 className="text-h3 text-[var(--foreground)] mb-3">
                Overview
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard label="DAU" value={metrics.dau.toLocaleString()} />
                <StatCard label="WAU" value={metrics.wau.toLocaleString()} />
                <StatCard label="MAU" value={metrics.mau.toLocaleString()} />
                <StatCard
                  label="7-Day Retention"
                  value={`${metrics.retention7d.rate.toFixed(1)}%`}
                  subtitle={`${metrics.retention7d.retained} / ${metrics.retention7d.totalEligible} eligible`}
                />
              </div>
            </section>

            {/* Platform Totals */}
            <section>
              <h2 className="text-h3 text-[var(--foreground)] mb-3">
                Platform Totals
              </h2>
              <div className="grid grid-cols-3 gap-4">
                <StatCard
                  label="Total Users"
                  value={metrics.totals.users.toLocaleString()}
                />
                <StatCard
                  label="Total Dashboards"
                  value={metrics.totals.dashboards.toLocaleString()}
                />
                <StatCard
                  label="Total Sessions"
                  value={metrics.totals.sessions.toLocaleString()}
                />
              </div>
            </section>

            {/* Retention Progress Bar */}
            <section>
              <div className="rounded-lg border border-[var(--border)] bg-[var(--background-elevated)] p-5">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-body font-medium text-[var(--foreground)]">
                    7-Day Retention Rate
                  </span>
                  <span className="text-body font-semibold text-[var(--foreground)]">
                    {metrics.retention7d.rate.toFixed(1)}%
                  </span>
                </div>
                <div className="w-full h-3 bg-[var(--background)] rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.min(100, metrics.retention7d.rate)}%`,
                      backgroundColor:
                        metrics.retention7d.rate >= 50
                          ? "var(--status-success)"
                          : metrics.retention7d.rate >= 25
                            ? "var(--status-warning)"
                            : "var(--status-error)",
                    }}
                  />
                </div>
                <p className="text-caption text-[var(--foreground-muted)] mt-2">
                  {metrics.retention7d.retained} retained of{" "}
                  {metrics.retention7d.totalEligible} eligible users (signed up
                  &gt;7 days ago)
                </p>
              </div>
            </section>

            {/* Signups + Active Dashboards by Day */}
            <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <DataTable
                title="Signups by Day (last 14 days)"
                columns={[
                  { key: "day", label: "Day" },
                  { key: "count", label: "Signups", align: "right" },
                ]}
                rows={metrics.signupsByDay.slice(0, 14)}
              />
              <DataTable
                title="Active Dashboards by Day (last 14 days)"
                columns={[
                  { key: "day", label: "Day" },
                  { key: "count", label: "Dashboards", align: "right" },
                ]}
                rows={metrics.activeDashboardsByDay.slice(0, 14)}
              />
            </section>

            {/* Sessions by Day & Agent Type */}
            <section>
              <DataTable
                title="Sessions by Day & Agent Type"
                columns={[
                  { key: "day", label: "Day" },
                  { key: "agent_type", label: "Agent Type" },
                  { key: "count", label: "Count", align: "right" },
                ]}
                rows={metrics.sessionsByDay.map((r) => ({
                  ...r,
                  agent_type: r.agent_type || "unknown",
                }))}
              />
            </section>

            {/* Block Types + Integration Adoption */}
            <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <DataTable
                title="Block Type Distribution"
                columns={[
                  { key: "type", label: "Block Type" },
                  { key: "count", label: "Count", align: "right" },
                ]}
                rows={metrics.blockTypeDistribution}
              />
              <DataTable
                title="Integration Adoption"
                columns={[
                  { key: "provider", label: "Provider" },
                  { key: "count", label: "Connected", align: "right" },
                ]}
                rows={metrics.integrationAdoption}
              />
            </section>

            {/* Subscription Breakdown */}
            <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <DataTable
                title="Subscription Breakdown"
                columns={[
                  { key: "status", label: "Status" },
                  { key: "count", label: "Count", align: "right" },
                ]}
                rows={metrics.subscriptionBreakdown}
              />
              <div className="rounded-lg border border-[var(--border)] bg-[var(--background-elevated)] overflow-hidden">
                <div className="px-4 py-3 border-b border-[var(--border)]">
                  <h3 className="text-body font-medium text-[var(--foreground)]">
                    Retention Detail
                  </h3>
                </div>
                <div className="p-4 space-y-3">
                  <div className="flex justify-between">
                    <span className="text-sm text-[var(--foreground-muted)]">
                      Total Eligible
                    </span>
                    <span className="text-sm font-medium text-[var(--foreground)]">
                      {metrics.retention7d.totalEligible.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-[var(--foreground-muted)]">
                      Retained (7d)
                    </span>
                    <span className="text-sm font-medium text-[var(--foreground)]">
                      {metrics.retention7d.retained.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-[var(--foreground-muted)]">
                      Retention Rate
                    </span>
                    <span className="text-sm font-semibold text-[var(--foreground)]">
                      {metrics.retention7d.rate.toFixed(1)}%
                    </span>
                  </div>
                </div>
              </div>
            </section>

            {/* Top 20 Users */}
            <section>
              <DataTable
                title="Top 20 Users (last 30 days)"
                columns={[
                  { key: "rank", label: "#", align: "right" },
                  { key: "email", label: "Email" },
                  { key: "name", label: "Name" },
                  { key: "event_count", label: "Events", align: "right" },
                ]}
                rows={metrics.topUsers.slice(0, 20).map((u, i) => ({
                  ...u,
                  rank: i + 1,
                }))}
              />
            </section>

            {/* Footer */}
            <footer className="text-center text-caption text-[var(--foreground-subtle)] py-4 border-t border-[var(--border)]">
              Generated at {new Date(metrics.generatedAt).toLocaleString()} |
              API revision: {metrics.revision}
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
