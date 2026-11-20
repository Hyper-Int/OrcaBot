"use client";

// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: auto-sleep-toggle-v1
//
// "Auto sleep" checkbox in the dashboard's menu bar. Ticked (the default): a dashboard
// nobody is watching goes to sleep (terminals with no viewer stop after 10 minutes,
// the VM suspends). Unticked (benchmark templates start that way): its terminals and VM
// keep running unattended, e.g. an overnight benchmark, until 48 hours after the last
// terminal activity. The dashboard query cache is the source of truth; no local state.

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Moon } from "lucide-react";
import { Tooltip } from "@/components/ui";
import { updateDashboard } from "@/lib/api/cloudflare/dashboards";
import type { Dashboard } from "@/types/dashboard";

const MODULE_REVISION = "auto-sleep-toggle-v1";
console.log(`[auto-sleep-toggle] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

interface AutoSleepToggleProps {
  dashboardId: string;
  /** dashboard.autoSleep; undefined (older control plane) counts as on. */
  autoSleep: boolean | undefined;
  /** Owners and editors can change it; others see it read-only. */
  canEdit: boolean;
}

type DashboardCache = { dashboard: Dashboard } & Record<string, unknown>;

export function AutoSleepToggle({ dashboardId, autoSleep, canEdit }: AutoSleepToggleProps) {
  const queryClient = useQueryClient();
  const checked = autoSleep !== false;

  const mutation = useMutation({
    mutationFn: (next: boolean) => updateDashboard(dashboardId, { autoSleep: next }),
    onMutate: async (next: boolean) => {
      await queryClient.cancelQueries({ queryKey: ["dashboard", dashboardId] });
      const previous = queryClient.getQueryData<DashboardCache>(["dashboard", dashboardId]);
      if (previous?.dashboard) {
        queryClient.setQueryData<DashboardCache>(["dashboard", dashboardId], {
          ...previous,
          dashboard: { ...previous.dashboard, autoSleep: next },
        });
      }
      return { previous };
    },
    onError: (err, _next, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["dashboard", dashboardId], context.previous);
      }
      toast.error(`Couldn't change Auto sleep: ${err instanceof Error ? err.message : String(err)}`);
    },
    onSuccess: (dashboard, next) => {
      const current = queryClient.getQueryData<DashboardCache>(["dashboard", dashboardId]);
      if (current?.dashboard) {
        queryClient.setQueryData<DashboardCache>(["dashboard", dashboardId], {
          ...current,
          dashboard: { ...current.dashboard, autoSleep: dashboard.autoSleep ?? next },
        });
      }
      toast.success(
        next
          ? "Auto sleep on: terminals nobody is watching stop after 10 minutes"
          : "Auto sleep off: terminals keep running when nobody is watching (up to 48 hours idle)"
      );
    },
  });

  const tip = checked
    ? "Auto sleep is on: when nobody is watching, terminals stop after 10 minutes and the sandbox sleeps. Untick for long unattended runs (benchmarks)."
    : "Auto sleep is off: terminals and the sandbox keep running when nobody is watching, until 48 hours after the last terminal activity.";

  return (
    <Tooltip content={<div className="max-w-[260px]">{tip}</div>} side="bottom">
      <label
        className={`flex items-center gap-1.5 px-2 py-1 bg-[var(--background)] rounded text-xs text-[var(--foreground-muted)] select-none ${
          canEdit ? "cursor-pointer" : "opacity-70 cursor-default"
        }`}
      >
        <input
          type="checkbox"
          className="w-3.5 h-3.5 accent-[var(--accent-primary)]"
          checked={checked}
          disabled={!canEdit || mutation.isPending}
          onChange={(e) => mutation.mutate(e.target.checked)}
          aria-label="Auto sleep"
        />
        <Moon className="w-3 h-3" />
        <span>Auto sleep</span>
      </label>
    </Tooltip>
  );
}
