// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: user-setup-v2-debug-logging

import { API } from "@/config/env";
import { apiGet, apiPost } from "../client";

export interface UserSetupResponse {
  needsAiSetup: boolean;
}

/**
 * Check if the user needs to complete the AI provider setup flow.
 * Returns true if user has no AI keys stored and has not dismissed the prompt.
 */
export async function getUserSetup(): Promise<UserSetupResponse> {
  const result = await apiGet<UserSetupResponse>(API.cloudflare.userSetup);
  console.log(`[user-setup] getUserSetup result:`, result);
  return result;
}

/**
 * Mark the AI provider setup prompt as dismissed.
 * Called when the setup prompt is auto-sent to the chat, preventing re-triggers on refresh.
 */
export async function dismissAiSetup(): Promise<void> {
  await apiPost(`${API.cloudflare.userSetup}/ai-dismissed`, {});
}
