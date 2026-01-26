// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { API } from "@/config/env";
import { apiGet, apiPost, apiPut, apiDelete } from "../client";

export interface DashboardMember {
  userId: string;
  email: string;
  name: string;
  role: "owner" | "editor" | "viewer";
  addedAt: string;
}

export interface DashboardInvitation {
  id: string;
  email: string;
  role: "editor" | "viewer";
  invitedByName: string;
  createdAt: string;
  expiresAt: string;
}

interface MembersResponse {
  members: DashboardMember[];
  invitations: DashboardInvitation[];
}

interface MemberResponse {
  member: DashboardMember;
}

/**
 * List members and pending invitations for a dashboard
 */
export async function listMembers(
  dashboardId: string
): Promise<MembersResponse> {
  return apiGet<MembersResponse>(
    `${API.cloudflare.dashboards}/${dashboardId}/members`
  );
}

/**
 * Add a member or send an invitation
 */
export async function addMember(
  dashboardId: string,
  data: { email: string; role: "editor" | "viewer" }
): Promise<{ member?: DashboardMember; invitation?: DashboardInvitation }> {
  return apiPost<{ member?: DashboardMember; invitation?: DashboardInvitation }>(
    `${API.cloudflare.dashboards}/${dashboardId}/members`,
    data
  );
}

/**
 * Update a member's role
 */
export async function updateMemberRole(
  dashboardId: string,
  memberId: string,
  data: { role: "editor" | "viewer" }
): Promise<MemberResponse> {
  return apiPut<MemberResponse>(
    `${API.cloudflare.dashboards}/${dashboardId}/members/${memberId}`,
    data
  );
}

/**
 * Remove a member from a dashboard
 */
export async function removeMember(
  dashboardId: string,
  memberId: string
): Promise<void> {
  await apiDelete<void>(
    `${API.cloudflare.dashboards}/${dashboardId}/members/${memberId}`
  );
}

/**
 * Resend an invitation email
 */
export async function resendInvitation(
  dashboardId: string,
  invitationId: string
): Promise<void> {
  await apiPost<void>(
    `${API.cloudflare.dashboards}/${dashboardId}/invitations/${invitationId}/resend`
  );
}

/**
 * Cancel a pending invitation
 */
export async function cancelInvitation(
  dashboardId: string,
  invitationId: string
): Promise<void> {
  await apiDelete<void>(
    `${API.cloudflare.dashboards}/${dashboardId}/invitations/${invitationId}`
  );
}
