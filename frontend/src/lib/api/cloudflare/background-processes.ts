// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: background-processes-api-v1-restart-choice
const MODULE_REVISION = "background-processes-api-v1-restart-choice";
console.log(`[background-processes-api] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import { API } from "@/config/env";
import { apiGet, apiPost } from "../client";

/** A process a terminal left running that a restart won't stop (detached from it). */
export interface BackgroundProcess {
  pid: number;
  ppid: number;
  uid: number;
  name: string;
  command: string;
  startTicks: number;
  startedAt: string;
  /** false: left by an earlier run of this terminal (it already outlived a restart) */
  fromCurrentRun: boolean;
}

export interface BackgroundStopResult {
  pid: number;
  outcome: "stopped" | "gone" | "refused" | "failed";
  detail?: string;
}

/**
 * What a restart of this terminal would leave running. Never throws and never takes
 * long: on any error or after timeoutMs it returns [] so the restart just goes ahead.
 */
export async function listBackgroundProcesses(sessionId: string, timeoutMs = 5000): Promise<BackgroundProcess[]> {
  console.log(`[listBackgroundProcesses] called at ${new Date().toISOString()}`);
  try {
    const res = await Promise.race([
      apiGet<{ processes?: BackgroundProcess[] }>(`${API.cloudflare.base}/sessions/${sessionId}/background-processes`),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return res?.processes ?? [];
  } catch (e) {
    console.warn("[listBackgroundProcesses] failed; restarting without asking", e);
    return [];
  }
}

export async function stopBackgroundProcesses(
  sessionId: string,
  processes: Array<Pick<BackgroundProcess, "pid" | "startTicks">>,
): Promise<BackgroundStopResult[]> {
  console.log(`[stopBackgroundProcesses] called at ${new Date().toISOString()} (${processes.length})`);
  const res = await apiPost<{ results?: BackgroundStopResult[] }>(
    `${API.cloudflare.base}/sessions/${sessionId}/background-processes/stop`,
    { processes: processes.map((p) => ({ pid: p.pid, startTicks: p.startTicks })) },
  );
  return res.results ?? [];
}
