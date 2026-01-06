/**
 * Auth Middleware
 *
 * Simple auth for development.
 * In production, this would validate JWT tokens, OAuth, etc.
 */

import type { Env, User } from '../types';

export interface AuthContext {
  user: User | null;
  isAuthenticated: boolean;
}

// Extract user from request (simplified for development)
export async function authenticate(
  request: Request,
  env: Env
): Promise<AuthContext> {
  // Check for user ID in header (development mode)
  let userId = request.headers.get('X-User-ID');
  let userEmail = request.headers.get('X-User-Email');
  let userName = request.headers.get('X-User-Name');

  // For WebSocket connections, also check query parameters
  // (browsers can't set custom headers on WebSocket requests)
  if (!userId) {
    const url = new URL(request.url);
    userId = url.searchParams.get('user_id');
    userEmail = url.searchParams.get('user_email');
    userName = url.searchParams.get('user_name');
  }

  if (!userId) {
    return { user: null, isAuthenticated: false };
  }

  // Check if user exists in DB
  interface DbUser {
    id: string;
    email: string;
    name: string;
    created_at: string;
  }
  const dbUser = await env.DB.prepare(`
    SELECT * FROM users WHERE id = ?
  `).bind(userId).first<DbUser>();

  let user: User | null = dbUser ? {
    id: dbUser.id,
    email: dbUser.email,
    name: dbUser.name,
    createdAt: dbUser.created_at,
  } : null;

  // Auto-create user if not exists (development mode)
  if (!user && userEmail) {
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO users (id, email, name, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(userId, userEmail, userName || 'Anonymous', now).run();

    user = {
      id: userId,
      email: userEmail,
      name: userName || 'Anonymous',
      createdAt: now,
    };
  }

  if (!user) {
    return { user: null, isAuthenticated: false };
  }

  return {
    user,
    isAuthenticated: true,
  };
}

// Middleware to require authentication
export function requireAuth(ctx: AuthContext): Response | null {
  if (!ctx.isAuthenticated || !ctx.user) {
    return Response.json(
      { error: 'Authentication required' },
      { status: 401 }
    );
  }
  return null;
}

// Validate internal API token for service-to-service calls
export function requireInternalAuth(
  request: Request,
  env: Env
): Response | null {
  const token = request.headers.get('X-Internal-Token');

  if (!env.INTERNAL_API_TOKEN) {
    // If no token configured, reject all internal requests
    return Response.json(
      { error: 'Internal API not configured' },
      { status: 503 }
    );
  }

  if (!token || token !== env.INTERNAL_API_TOKEN) {
    return Response.json(
      { error: 'Invalid internal token' },
      { status: 401 }
    );
  }

  return null;
}
