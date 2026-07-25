"use client";

// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: sandbox-status-light-v1
//
// Traffic-light indicator for the dashboard's sandbox VM, shown in the control bar.
//   green  — VM ready/running (alive, warmed up)
//   orange — in between (starting/resuming, or status temporarily unknown)
//   red    — asleep (stopped/suspended) or not provisioned yet
// Polls the read-only status endpoint (server-side cached, so polling is cheap).

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { getDashboardSandboxStatus, type SandboxState } from "@/lib/api/cloudflare/dashboards";

const COLORS: Record<SandboxState, { dot: string; label: string }> = {
  ready: { dot: "bg-green-500", label: "Sandbox ready" },
  starting: { dot: "bg-amber-500", label: "Sandbox starting…" },
  asleep: { dot: "bg-red-500", label: "Sandbox asleep" },
  unknown: { dot: "bg-amber-500", label: "Sandbox status unknown" },
};

interface SandboxStatusLightProps {
  dashboardId: string;
  /** Poll interval in ms (default 12s — server caches the underlying Fly call). */
  pollMs?: number;
}

export function SandboxStatusLight({ dashboardId, pollMs = 12000 }: SandboxStatusLightProps) {
  const { data } = useQuery({
    queryKey: ["sandbox-status", dashboardId],
    queryFn: () => getDashboardSandboxStatus(dashboardId),
    enabled: Boolean(dashboardId),
    refetchInterval: pollMs,
    refetchOnWindowFocus: true,
    staleTime: pollMs,
    retry: false,
  });

  const state: SandboxState = data?.state ?? "unknown";
  const { dot, label } = COLORS[state];
  const title = data?.flyState ? `${label} (${data.flyState})` : label;

  return (
    <span
      className="inline-flex items-center gap-1.5 px-1.5"
      title={title}
      aria-label={label}
      role="status"
    >
      <span
        className={`inline-block w-2.5 h-2.5 rounded-full ${dot} ${
          state === "starting" ? "animate-pulse" : ""
        }`}
      />
    </span>
  );
}

export default SandboxStatusLight;
