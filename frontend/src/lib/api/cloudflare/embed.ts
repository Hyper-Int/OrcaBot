// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { API } from "@/config/env";
import { apiGet } from "../client";

export interface EmbedCheckResponse {
  embeddable: boolean;
  reason?: string;
}

export async function checkEmbeddable(url: string): Promise<EmbedCheckResponse> {
  const origin = window.location.origin;
  const params = new URLSearchParams({
    url,
    origin,
  });
  return apiGet<EmbedCheckResponse>(`${API.cloudflare.embedCheck}?${params.toString()}`);
}
