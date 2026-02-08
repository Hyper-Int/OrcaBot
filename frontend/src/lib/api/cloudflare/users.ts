// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { API } from "@/config/env";
import { apiGet } from "../client";
import type { User } from "@/types";

interface UserResponse {
  user: User;
}

/**
 * Fetch current user (ensures dev-auth user exists).
 */
export async function getCurrentUser(): Promise<User> {
  const response = await apiGet<UserResponse>(API.cloudflare.usersMe);
  return response.user;
}
