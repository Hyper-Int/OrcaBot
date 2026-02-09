// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Dashboard Member Management Handlers
 *
 * Handles invitations, member CRUD, and access control for dashboard sharing.
 */

import type { Env } from '../types';
import { sendEmail, buildInvitationEmail, buildAccessGrantedEmail } from '../email/resend';

function generateId(): string {
  return crypto.randomUUID();
}

function generateToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

// ===== Response Types =====

interface DashboardMemberWithUser {
  userId: string;
  email: string;
  name: string;
  role: 'owner' | 'editor' | 'viewer';
  addedAt: string;
}

interface DashboardInvitation {
  id: string;
  email: string;
  role: 'editor' | 'viewer';
  invitedByName: string;
  createdAt: string;
  expiresAt: string;
}

// ===== Helpers =====

async function getDashboardRole(
  env: Env,
  dashboardId: string,
  userId: string
): Promise<string | null> {
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first<{ role: string }>();

  return access?.role ?? null;
}

async function getDashboardInfo(
  env: Env,
  dashboardId: string
): Promise<{ name: string; ownerId: string } | null> {
  const dashboard = await env.DB.prepare(`
    SELECT name, owner_id FROM dashboards WHERE id = ?
  `).bind(dashboardId).first<{ name: string; owner_id: string }>();

  if (!dashboard) return null;
  return { name: dashboard.name, ownerId: dashboard.owner_id };
}

async function getUserByEmail(
  env: Env,
  email: string
): Promise<{ id: string; name: string; email: string } | null> {
  return env.DB.prepare(`
    SELECT id, name, email FROM users WHERE LOWER(email) = LOWER(?)
  `).bind(email).first();
}

async function getUserById(
  env: Env,
  userId: string
): Promise<{ id: string; name: string; email: string } | null> {
  return env.DB.prepare(`
    SELECT id, name, email FROM users WHERE id = ?
  `).bind(userId).first();
}

function getFrontendUrl(env: Env): string {
  return env.FRONTEND_URL || 'https://orcabot.com';
}

// ===== Handlers =====

/**
 * List members and pending invitations for a dashboard
 */
export async function listMembers(
  env: Env,
  dashboardId: string,
  userId: string
): Promise<Response> {
  // Check access - any member can view the list
  const role = await getDashboardRole(env, dashboardId, userId);
  if (!role) {
    return Response.json({ error: 'E79060: Access denied' }, { status: 403 });
  }

  // Get members with user info
  const membersResult = await env.DB.prepare(`
    SELECT dm.user_id, dm.role, dm.added_at, u.email, u.name
    FROM dashboard_members dm
    JOIN users u ON dm.user_id = u.id
    WHERE dm.dashboard_id = ?
    ORDER BY
      CASE dm.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,
      dm.added_at ASC
  `).bind(dashboardId).all();

  const members: DashboardMemberWithUser[] = (membersResult.results || []).map(row => ({
    userId: row.user_id as string,
    email: row.email as string,
    name: row.name as string,
    role: row.role as 'owner' | 'editor' | 'viewer',
    addedAt: row.added_at as string,
  }));

  // Get pending invitations (non-expired, non-accepted)
  const invitationsResult = await env.DB.prepare(`
    SELECT i.id, i.email, i.role, i.created_at, i.expires_at, u.name as invited_by_name
    FROM dashboard_invitations i
    JOIN users u ON i.invited_by = u.id
    WHERE i.dashboard_id = ?
      AND i.accepted_at IS NULL
      AND i.expires_at > datetime('now')
    ORDER BY i.created_at DESC
  `).bind(dashboardId).all();

  const invitations: DashboardInvitation[] = (invitationsResult.results || []).map(row => ({
    id: row.id as string,
    email: row.email as string,
    role: row.role as 'editor' | 'viewer',
    invitedByName: row.invited_by_name as string,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
  }));

  return Response.json({ members, invitations });
}

/**
 * Add a member or send an invitation
 */
export async function addMember(
  env: Env,
  dashboardId: string,
  userId: string,
  data: { email: string; role: 'editor' | 'viewer' }
): Promise<Response> {
  // Only owners can add members
  const role = await getDashboardRole(env, dashboardId, userId);
  if (role !== 'owner') {
    return Response.json({ error: 'E79061: Only owners can add members' }, { status: 403 });
  }

  const dashboard = await getDashboardInfo(env, dashboardId);
  if (!dashboard) {
    return Response.json({ error: 'E79062: Dashboard not found' }, { status: 404 });
  }

  const inviter = await getUserById(env, userId);
  if (!inviter) {
    return Response.json({ error: 'E79063: User not found' }, { status: 404 });
  }

  const email = data.email.toLowerCase().trim();
  const inviteRole = data.role;

  // Validate role
  if (!['editor', 'viewer'].includes(inviteRole)) {
    return Response.json({ error: 'E79064: Invalid role. Must be editor or viewer.' }, { status: 400 });
  }

  // Check if user exists
  const existingUser = await getUserByEmail(env, email);

  if (existingUser) {
    // Check if already a member
    const existingMember = await env.DB.prepare(`
      SELECT 1 FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?
    `).bind(dashboardId, existingUser.id).first();

    if (existingMember) {
      return Response.json({ error: 'E79065: User is already a member of this dashboard' }, { status: 400 });
    }

    // Add as member directly
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO dashboard_members (dashboard_id, user_id, role, added_at)
      VALUES (?, ?, ?, ?)
    `).bind(dashboardId, existingUser.id, inviteRole, now).run();

    // Send notification email
    const dashboardUrl = `${getFrontendUrl(env)}/dashboards/${dashboardId}`;
    try {
      const emailContent = buildAccessGrantedEmail({
        inviterName: inviter.name,
        dashboardName: dashboard.name,
        role: inviteRole,
        dashboardUrl,
      });
      await sendEmail(env, {
        to: email,
        subject: emailContent.subject,
        html: emailContent.html,
      });
    } catch (e) {
      console.error('Failed to send access granted email:', e);
      // Don't fail the request if email fails
    }

    const member: DashboardMemberWithUser = {
      userId: existingUser.id,
      email: existingUser.email,
      name: existingUser.name,
      role: inviteRole,
      addedAt: now,
    };

    return Response.json({ member }, { status: 201 });
  }

  // User doesn't exist - create invitation
  // First check if there's already a pending invitation
  const existingInvitation = await env.DB.prepare(`
    SELECT id FROM dashboard_invitations
    WHERE dashboard_id = ? AND LOWER(email) = LOWER(?) AND accepted_at IS NULL
  `).bind(dashboardId, email).first();

  if (existingInvitation) {
    return Response.json({ error: 'E79066: An invitation has already been sent to this email' }, { status: 400 });
  }

  const invitationId = generateId();
  const token = generateToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

  await env.DB.prepare(`
    INSERT INTO dashboard_invitations (id, dashboard_id, email, role, invited_by, token, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    invitationId,
    dashboardId,
    email,
    inviteRole,
    userId,
    token,
    now.toISOString(),
    expiresAt.toISOString()
  ).run();

  // Send invitation email
  const acceptUrl = `${getFrontendUrl(env)}/login?invite=${token}`;
  try {
    const emailContent = buildInvitationEmail({
      inviterName: inviter.name,
      dashboardName: dashboard.name,
      role: inviteRole,
      acceptUrl,
    });
    await sendEmail(env, {
      to: email,
      subject: emailContent.subject,
      html: emailContent.html,
    });
  } catch (e) {
    console.error('Failed to send invitation email:', e);
    // Don't fail the request if email fails
  }

  const invitation: DashboardInvitation = {
    id: invitationId,
    email,
    role: inviteRole,
    invitedByName: inviter.name,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  return Response.json({ invitation }, { status: 201 });
}

/**
 * Update a member's role
 */
export async function updateMemberRole(
  env: Env,
  dashboardId: string,
  userId: string,
  memberId: string,
  data: { role: 'editor' | 'viewer' }
): Promise<Response> {
  // Only owners can update roles
  const role = await getDashboardRole(env, dashboardId, userId);
  if (role !== 'owner') {
    return Response.json({ error: 'E79067: Only owners can update member roles' }, { status: 403 });
  }

  // Cannot change owner's role
  const memberRole = await getDashboardRole(env, dashboardId, memberId);
  if (memberRole === 'owner') {
    return Response.json({ error: 'E79068: Cannot change the owner\'s role' }, { status: 400 });
  }

  if (!memberRole) {
    return Response.json({ error: 'E79069: Member not found' }, { status: 404 });
  }

  const newRole = data.role;
  if (!['editor', 'viewer'].includes(newRole)) {
    return Response.json({ error: 'E79070: Invalid role. Must be editor or viewer.' }, { status: 400 });
  }

  await env.DB.prepare(`
    UPDATE dashboard_members SET role = ? WHERE dashboard_id = ? AND user_id = ?
  `).bind(newRole, dashboardId, memberId).run();

  const member = await getUserById(env, memberId);
  if (!member) {
    return Response.json({ error: 'E79071: Member user not found' }, { status: 404 });
  }

  const result = await env.DB.prepare(`
    SELECT added_at FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, memberId).first<{ added_at: string }>();

  const updatedMember: DashboardMemberWithUser = {
    userId: memberId,
    email: member.email,
    name: member.name,
    role: newRole,
    addedAt: result?.added_at || '',
  };

  return Response.json({ member: updatedMember });
}

/**
 * Remove a member from a dashboard
 */
export async function removeMember(
  env: Env,
  dashboardId: string,
  userId: string,
  memberId: string
): Promise<Response> {
  // Only owners can remove members
  const role = await getDashboardRole(env, dashboardId, userId);
  if (role !== 'owner') {
    return Response.json({ error: 'E79072: Only owners can remove members' }, { status: 403 });
  }

  // Cannot remove owner
  const memberRole = await getDashboardRole(env, dashboardId, memberId);
  if (memberRole === 'owner') {
    return Response.json({ error: 'E79073: Cannot remove the owner' }, { status: 400 });
  }

  if (!memberRole) {
    return Response.json({ error: 'E79074: Member not found' }, { status: 404 });
  }

  await env.DB.prepare(`
    DELETE FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, memberId).run();

  return Response.json({ success: true });
}

/**
 * Resend an invitation email
 */
export async function resendInvitation(
  env: Env,
  dashboardId: string,
  userId: string,
  invitationId: string
): Promise<Response> {
  // Only owners can resend invitations
  const role = await getDashboardRole(env, dashboardId, userId);
  if (role !== 'owner') {
    return Response.json({ error: 'E79075: Only owners can resend invitations' }, { status: 403 });
  }

  const invitation = await env.DB.prepare(`
    SELECT * FROM dashboard_invitations
    WHERE id = ? AND dashboard_id = ? AND accepted_at IS NULL
  `).bind(invitationId, dashboardId).first<{
    id: string;
    email: string;
    role: string;
    token: string;
  }>();

  if (!invitation) {
    return Response.json({ error: 'E79076: Invitation not found or already accepted' }, { status: 404 });
  }

  const dashboard = await getDashboardInfo(env, dashboardId);
  if (!dashboard) {
    return Response.json({ error: 'E79077: Dashboard not found' }, { status: 404 });
  }

  const inviter = await getUserById(env, userId);
  if (!inviter) {
    return Response.json({ error: 'E79078: User not found' }, { status: 404 });
  }

  // Generate new token and extend expiry
  const newToken = generateToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  await env.DB.prepare(`
    UPDATE dashboard_invitations
    SET token = ?, expires_at = ?
    WHERE id = ?
  `).bind(newToken, expiresAt.toISOString(), invitationId).run();

  // Send invitation email
  const acceptUrl = `${getFrontendUrl(env)}/login?invite=${newToken}`;
  try {
    const emailContent = buildInvitationEmail({
      inviterName: inviter.name,
      dashboardName: dashboard.name,
      role: invitation.role,
      acceptUrl,
    });
    await sendEmail(env, {
      to: invitation.email,
      subject: emailContent.subject,
      html: emailContent.html,
    });
  } catch (e) {
    console.error('Failed to send invitation email:', e);
    return Response.json({ error: 'E79079: Failed to send email' }, { status: 500 });
  }

  return Response.json({ success: true });
}

/**
 * Cancel a pending invitation
 */
export async function cancelInvitation(
  env: Env,
  dashboardId: string,
  userId: string,
  invitationId: string
): Promise<Response> {
  // Only owners can cancel invitations
  const role = await getDashboardRole(env, dashboardId, userId);
  if (role !== 'owner') {
    return Response.json({ error: 'E79080: Only owners can cancel invitations' }, { status: 403 });
  }

  const invitation = await env.DB.prepare(`
    SELECT id FROM dashboard_invitations
    WHERE id = ? AND dashboard_id = ? AND accepted_at IS NULL
  `).bind(invitationId, dashboardId).first();

  if (!invitation) {
    return Response.json({ error: 'E79081: Invitation not found or already accepted' }, { status: 404 });
  }

  await env.DB.prepare(`
    DELETE FROM dashboard_invitations WHERE id = ?
  `).bind(invitationId).run();

  return Response.json({ success: true });
}

/**
 * Process pending invitations for a user (called after signup/login)
 * This grants access to any dashboards the user was invited to.
 */
export async function processPendingInvitations(
  env: Env,
  userId: string,
  email: string
): Promise<void> {
  // Find all pending (non-expired, non-accepted) invitations for this email
  const invitations = await env.DB.prepare(`
    SELECT id, dashboard_id, role FROM dashboard_invitations
    WHERE LOWER(email) = LOWER(?)
      AND accepted_at IS NULL
      AND expires_at > datetime('now')
  `).bind(email).all();

  const now = new Date().toISOString();

  for (const inv of invitations.results || []) {
    // Check if already a member (shouldn't happen, but safety check)
    const existing = await env.DB.prepare(`
      SELECT 1 FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?
    `).bind(inv.dashboard_id, userId).first();

    if (!existing) {
      // Add as member
      await env.DB.prepare(`
        INSERT INTO dashboard_members (dashboard_id, user_id, role, added_at)
        VALUES (?, ?, ?, ?)
      `).bind(inv.dashboard_id, userId, inv.role, now).run();
    }

    // Mark invitation as accepted
    await env.DB.prepare(`
      UPDATE dashboard_invitations SET accepted_at = ? WHERE id = ?
    `).bind(now, inv.id).run();
  }
}
