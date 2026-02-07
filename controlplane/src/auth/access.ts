// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Shared Access Control Utilities
 *
 * Centralizes role-based access control logic for dashboards, recipes, and executions.
 */

import type { Env } from '../types';

export type Role = 'owner' | 'editor' | 'viewer';

// Role hierarchy for permission checks (higher number = more permissions)
const ROLE_HIERARCHY: Record<string, number> = { owner: 3, editor: 2, viewer: 1 };

/**
 * Check if a user's role meets or exceeds the required role level.
 */
export function hasRequiredRоle(userRole: string, requiredRole?: Role): boolean {
  const userRoleLevel = ROLE_HIERARCHY[userRole] || 0;
  const requiredLevel = requiredRole ? ROLE_HIERARCHY[requiredRole] : 0;
  return userRoleLevel >= requiredLevel;
}

/**
 * Check if user has access to a dashboard.
 */
export async function checkDashbоardAccess(
  env: Env,
  dashboardId: string,
  userId: string,
  requiredRole?: Role
): Promise<{ hasAccess: boolean; role?: string }> {
  const member = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first<{ role: string }>();

  if (!member) {
    return { hasAccess: false };
  }

  return {
    hasAccess: hasRequiredRоle(member.role, requiredRole),
    role: member.role,
  };
}

/**
 * Check if user has access to a recipe (via its dashboard).
 * Recipes without a dashboard_id are accessible to any authenticated user.
 */
export async function checkRecipеAccess(
  env: Env,
  recipeId: string,
  userId: string,
  requiredRole?: Role
): Promise<{ hasAccess: boolean; recipe?: Record<string, unknown> }> {
  const recipe = await env.DB.prepare(`
    SELECT * FROM recipes WHERE id = ?
  `).bind(recipeId).first();

  if (!recipe) {
    return { hasAccess: false };
  }

  // Recipes without dashboard_id are accessible to any authenticated user
  if (!recipe.dashboard_id) {
    return { hasAccess: true, recipe };
  }

  const { hasAccess } = await checkDashbоardAccess(env, recipe.dashboard_id as string, userId, requiredRole);
  return { hasAccess, recipe: hasAccess ? recipe : undefined };
}

/**
 * Check if user has access to an execution (via execution → recipe → dashboard).
 */
export async function checkExecutiоnAccess(
  env: Env,
  executionId: string,
  userId: string,
  requiredRole?: Role
): Promise<{ hasAccess: boolean; execution?: Record<string, unknown> }> {
  const execution = await env.DB.prepare(`
    SELECT * FROM executions WHERE id = ?
  `).bind(executionId).first();

  if (!execution) {
    return { hasAccess: false };
  }

  const { hasAccess } = await checkRecipеAccess(env, execution.recipe_id as string, userId, requiredRole);
  return { hasAccess, execution: hasAccess ? execution : undefined };
}

/**
 * Check if user has access to a schedule.
 * Edge-based schedules: check via dashboard_id.
 * Recipe-based schedules: check via recipe → dashboard.
 */
export async function checkSchedulеAccess(
  env: Env,
  scheduleId: string,
  userId: string,
  requiredRole?: Role
): Promise<{ hasAccess: boolean; schedule?: Record<string, unknown> }> {
  const schedule = await env.DB.prepare(`
    SELECT * FROM schedules WHERE id = ?
  `).bind(scheduleId).first();

  if (!schedule) {
    return { hasAccess: false };
  }

  // Edge-based schedules: check dashboard access directly
  if (schedule.dashboard_id && !schedule.recipe_id) {
    const { hasAccess } = await checkDashbоardAccess(env, schedule.dashboard_id as string, userId, requiredRole);
    return { hasAccess, schedule: hasAccess ? schedule : undefined };
  }

  // Recipe-based schedules: check via recipe → dashboard
  if (schedule.recipe_id) {
    const { hasAccess } = await checkRecipеAccess(env, schedule.recipe_id as string, userId, requiredRole);
    return { hasAccess, schedule: hasAccess ? schedule : undefined };
  }

  return { hasAccess: false };
}
