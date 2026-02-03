// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: bug-report-v2-response

import { API } from "@/config/env";
import { apiPost } from "../client";

const MODULE_REVISION = "bug-report-v2-response";
console.log(
  `[bug-reports] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

// ===== Types =====

export interface BugReportRequest {
  notes: string;
  screenshot?: string; // Base64 PNG data URL
  dashboardId: string;
  dashboardName: string;
  userAgent: string;
  url: string;
}

export interface BugReportResponse {
  success: boolean;
  screenshotIncluded: boolean;
  screenshotExcluded: boolean;
}

// ===== API Functions =====

/**
 * Submit a bug report
 */
export async function submitBugReport(
  data: Omit<BugReportRequest, "userAgent" | "url">
): Promise<BugReportResponse> {
  console.log(
    `[bug-reports] submitBugReport called at ${new Date().toISOString()}`
  );

  return apiPost<BugReportResponse>(`${API.cloudflare.base}/bug-reports`, {
    ...data,
    userAgent: navigator.userAgent,
    url: window.location.href,
  });
}
