// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// Rate limiter binding type
export interface RateLimiter {
  limit: (options: { key: string }) => Promise<{ success: boolean }>;
}

// Environment bindings
export interface Env {
  DB: D1Database;
  DASHBOARD: DurableObjectNamespace;
  DRIVE_CACHE?: R2Bucket;
  SANDBOX_URL: string;
  /** Desktop-only: D1 shim HTTP endpoint (e.g. http://127.0.0.1:9001). */
  D1_HTTP_URL?: string;
  /** Desktop-only: D1 shim service binding (workerd external). */
  D1_SHIM?: Fetcher;
  /** Desktop-only: enable D1 shim debug logging. */
  D1_SHIM_DEBUG?: string;
  /** Desktop-only: enable browser auth debug logging. */
  BROWSER_AUTH_DEBUG?: string;
  /** Rate limiter for unauthenticated requests (10/min) */
  RATE_LIMITER: RateLimiter;
  /** Rate limiter for authenticated requests (200/min) */
  RATE_LIMITER_AUTH: RateLimiter;
  INTERNAL_API_TOKEN: string;
  SANDBOX_INTERNAL_TOKEN: string;
  DEV_AUTH_ENABLED?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  AUTH_ALLOWED_EMAILS?: string;
  AUTH_ALLOWED_DOMAINS?: string;
  GOOGLE_API_KEY?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  BOX_CLIENT_ID?: string;
  BOX_CLIENT_SECRET?: string;
  ONEDRIVE_CLIENT_ID?: string;
  ONEDRIVE_CLIENT_SECRET?: string;
  OAUTH_REDIRECT_BASE?: string;
  FRONTEND_URL?: string;
  /** Comma-separated list of allowed CORS origins. If not set, allows all origins (dev mode). */
  ALLOWED_ORIGINS?: string;
  /** Cloudflare Access team domain (e.g., "myteam" for myteam.cloudflareaccess.com) */
  CF_ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Access Application Audience (AUD) tag */
  CF_ACCESS_AUD?: string;
  /** Base64-encoded 256-bit key for encrypting user secrets at rest.
   *  Generate with: openssl rand -base64 32
   *  Set via: wrangler secret put SECRETS_ENCRYPTION_KEY */
  SECRETS_ENCRYPTION_KEY?: string;
}

// User types
export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

// Dashboard types
export interface Dashboard {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardItem {
  id: string;
  dashboardId: string;
  type: 'note' | 'todo' | 'terminal' | 'link' | 'browser' | 'workspace';
  content: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  createdAt: string;
  updatedAt: string;
}

export interface DashboardEdge {
  id: string;
  dashboardId: string;
  sourceItemId: string;
  targetItemId: string;
  sourceHandle?: string;
  targetHandle?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardMember {
  dashboardId: string;
  userId: string;
  role: 'owner' | 'editor' | 'viewer';
  addedAt: string;
}

export interface UserSubagent {
  id: string;
  userId: string;
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserAgentSkill {
  id: string;
  userId: string;
  name: string;
  description: string;
  command: string;
  args: string[];
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserMcpTool {
  id: string;
  userId: string;
  name: string;
  description: string;
  serverUrl: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  config: Record<string, unknown>;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserSecret {
  id: string;
  userId: string;
  dashboardId: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserIntegration {
  id: string;
  userId: string;
  provider: 'google_drive' | 'github';
  accessToken: string;
  refreshToken: string | null;
  scope: string | null;
  tokenType: string | null;
  expiresAt: string | null;
  metadata: string;
  createdAt: string;
  updatedAt: string;
}

// Session types (maps dashboard terminal items to sandbox sessions)
export interface Session {
  id: string;
  dashboardId: string;
  itemId: string;        // The terminal item in the dashboard
  ownerUserId: string;
  ownerName: string;
  sandboxSessionId: string; // The session ID in the sandbox
  sandboxMachineId: string;
  ptyId: string;         // The PTY ID in the sandbox session
  status: 'creating' | 'active' | 'stopped' | 'error';
  region: string;
  createdAt: string;
  stoppedAt: string | null;
}

// Recipe/Workflow types
export interface Recipe {
  id: string;
  dashboardId: string;
  name: string;
  description: string;
  steps: RecipeStep[];
  createdAt: string;
  updatedAt: string;
}

export type RecipeStepType = 'run_agent' | 'wait' | 'branch' | 'notify' | 'human_approval';

export interface RecipeStep {
  id: string;
  type: RecipeStepType;
  name: string;
  config: Record<string, unknown>;
  nextStepId: string | null;
  onError: 'fail' | 'retry' | 'skip';
}

/**
 * Context for execution triggers.
 * - Manual triggers include actorUserId (the user who triggered)
 * - Cron/event triggers do not have actorUserId
 */
export interface ExecutionContext {
  /** How the execution was triggered */
  triggeredBy?: 'manual' | 'cron' | 'event';
  /** Schedule ID if triggered by a schedule */
  scheduleId?: string;
  /** User ID who manually triggered (only for manual triggers) */
  actorUserId?: string;
  /** Event name (only for event triggers) */
  eventName?: string;
  /** Event payload (only for event triggers) */
  payload?: Record<string, unknown>;
  /** Additional custom context */
  [key: string]: unknown;
}

export interface Execution {
  id: string;
  recipeId: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  currentStepId: string | null;
  context: ExecutionContext;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

// Schedule types
export interface Schedule {
  id: string;
  recipeId: string;
  name: string;
  cron: string | null;
  eventTrigger: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

// Agent profile types
export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  tools: string[];
  systemPrompt: string;
  policy: Record<string, unknown>;
  createdAt: string;
}

// Artifact types
export interface Artifact {
  id: string;
  executionId: string;
  stepId: string;
  type: 'file' | 'log' | 'summary' | 'output';
  name: string;
  content: string;
  createdAt: string;
}

// Durable Object state for real-time collaboration
export interface DashboardDOState {
  dashboard: Dashboard | null;
  items: Map<string, DashboardItem>;
  presence: Map<string, PresenceInfo>;
  sessions: Map<string, Session>;
  edges: Map<string, DashboardEdge>;
}

export interface PresenceInfo {
  userId: string;
  userName: string;
  cursor: { x: number; y: number } | null;
  selectedItemId: string | null;
  connectedAt: string;
}

// WebSocket messages for collaboration
export type CollabMessage =
  | { type: 'join'; userId: string; userName: string }
  | { type: 'leave'; userId: string }
  | { type: 'cursor'; userId: string; x: number; y: number }
  | { type: 'select'; userId: string; itemId: string | null }
  | { type: 'item_update'; item: DashboardItem }
  | { type: 'item_create'; item: DashboardItem }
  | { type: 'item_delete'; itemId: string }
  | { type: 'edge_create'; edge: DashboardEdge }
  | { type: 'edge_delete'; edge_id: string }
  | { type: 'presence'; users: PresenceInfo[] }
  | { type: 'session_update'; session: Session }
  | { type: 'browser_open'; url: string };

// API response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
