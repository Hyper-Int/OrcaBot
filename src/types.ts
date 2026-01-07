// Rate limiter binding type
export interface RateLimiter {
  limit: (options: { key: string }) => Promise<{ success: boolean }>;
}

// Environment bindings
export interface Env {
  DB: D1Database;
  DASHBOARD: DurableObjectNamespace;
  SANDBOX_URL: string;
  RATE_LIMITER: RateLimiter;
  INTERNAL_API_TOKEN: string;
  SANDBOX_INTERNAL_TOKEN: string;
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
  type: 'note' | 'todo' | 'terminal' | 'link';
  content: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  createdAt: string;
  updatedAt: string;
}

export interface DashboardMember {
  dashboardId: string;
  userId: string;
  role: 'owner' | 'editor' | 'viewer';
  addedAt: string;
}

// Session types (maps dashboard terminal items to sandbox sessions)
export interface Session {
  id: string;
  dashboardId: string;
  itemId: string;        // The terminal item in the dashboard
  sandboxSessionId: string; // The session ID in the sandbox
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
  | { type: 'presence'; users: PresenceInfo[] }
  | { type: 'session_update'; session: Session };

// API response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
