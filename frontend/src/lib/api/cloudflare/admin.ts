// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: admin-metrics-v1-initial
const MODULE_REVISION = "admin-metrics-v1-initial";
console.log(`[admin-api] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import { apiGet } from "../client";
import { API } from "@/config/env";

export interface AdminMetrics {
  revision: string;
  generatedAt: string;
  dau: number;
  wau: number;
  mau: number;
  signupsByDay: { day: string; count: number }[];
  activeDashboardsByDay: { day: string; count: number }[];
  sessionsByDay: { day: string; agent_type: string | null; count: number }[];
  blockTypeDistribution: { type: string; count: number }[];
  integrationAdoption: { provider: string; count: number }[];
  subscriptionBreakdown: { status: string; count: number }[];
  topUsers: {
    user_id: string;
    email: string;
    name: string;
    session_count: number;
    event_count: number;
  }[];
  retention7d: { totalEligible: number; retained: number; rate: number };
  totals: { users: number; dashboards: number; sessions: number };
}

export async function getAdminMetrics(excludeAdmins?: boolean): Promise<AdminMetrics> {
  const url = excludeAdmins
    ? `${API.cloudflare.adminMetrics}?excludeAdmins=1`
    : API.cloudflare.adminMetrics;
  return apiGet<AdminMetrics>(url);
}
