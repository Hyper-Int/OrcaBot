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
  /** Rate limit counter DO for integration policy enforcement */
  RATE_LIMIT_COUNTER: DurableObjectNamespace;
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
  /** Resend API key for sending emails.
   *  Set via: wrangler secret put RESEND_API_KEY */
  RESEND_API_KEY?: string;
  /** Email sender address for outbound emails */
  EMAIL_FROM?: string;
  /** GCP Pub/Sub topic for Gmail push notifications.
   *  Format: projects/{project-id}/topics/{topic-name} */
  GMAIL_PUBSUB_TOPIC?: string;
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
  type: 'note' | 'todo' | 'terminal' | 'link' | 'browser' | 'workspace' | 'prompt' | 'schedule' | 'gmail' | 'calendar' | 'contacts' | 'sheets' | 'forms';
  content: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  /** Type-specific metadata (e.g., note color, terminal settings) */
  metadata?: Record<string, unknown>;
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

export type SecretType = 'secret' | 'env_var';

export interface UserSecret {
  id: string;
  userId: string;
  dashboardId: string;
  name: string;
  description: string;
  type: SecretType; // 'secret' = brokered, 'env_var' = set directly
  brokerProtected: boolean; // If true, secret is routed through broker (LLM cannot read it directly)
  createdAt: string;
  updatedAt: string;
}

export interface UserIntegration {
  id: string;
  userId: string;
  provider: 'google_drive' | 'github' | 'gmail' | 'google_calendar' | 'google_contacts' | 'google_sheets' | 'google_forms' | 'box' | 'onedrive';
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
  | { type: 'browser_open'; url: string }
  | { type: 'pending_approval'; secret_name: string; domain: string }
  | UICommandMessage
  | UICommandResultMessage;

// API response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// ============================================
// MCP UI Control Types
// ============================================

/**
 * UI Command types that can be sent from agents to control the dashboard.
 * These are broadcast via the DashboardDO to connected frontend clients.
 */
export type UICommandType =
  | 'create_browser'
  | 'create_todo'
  | 'create_note'
  | 'create_terminal'
  | 'update_item'
  | 'delete_item'
  | 'connect_nodes'
  | 'disconnect_nodes'
  | 'navigate_browser'
  | 'add_todo_item'
  | 'toggle_todo_item';

/**
 * Base UI command structure
 */
export interface UICommandBase {
  type: UICommandType;
  command_id: string; // Unique ID for tracking command execution
  source_terminal_id?: string; // Terminal that issued the command
}

/**
 * Create a browser block
 */
export interface CreateBrowserCommand extends UICommandBase {
  type: 'create_browser';
  url: string;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
}

/**
 * Create a todo block
 */
export interface CreateTodoCommand extends UICommandBase {
  type: 'create_todo';
  title: string;
  items?: Array<{ text: string; completed?: boolean }>;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
}

/**
 * Create a note block
 */
export interface CreateNoteCommand extends UICommandBase {
  type: 'create_note';
  text: string;
  color?: 'yellow' | 'blue' | 'green' | 'pink' | 'purple';
  position?: { x: number; y: number };
  size?: { width: number; height: number };
}

/**
 * Create a terminal block
 */
export interface CreateTerminalCommand extends UICommandBase {
  type: 'create_terminal';
  name?: string;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
}

/**
 * Update an existing item
 */
export interface UpdateItemCommand extends UICommandBase {
  type: 'update_item';
  item_id: string;
  content?: string;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
}

/**
 * Delete an item
 */
export interface DeleteItemCommand extends UICommandBase {
  type: 'delete_item';
  item_id: string;
}

/**
 * Connect two nodes with an edge
 */
export interface ConnectNodesCommand extends UICommandBase {
  type: 'connect_nodes';
  source_item_id: string;
  target_item_id: string;
  source_handle?: string;
  target_handle?: string;
}

/**
 * Disconnect two nodes
 */
export interface DisconnectNodesCommand extends UICommandBase {
  type: 'disconnect_nodes';
  source_item_id: string;
  target_item_id: string;
}

/**
 * Navigate a browser block to a new URL
 */
export interface NavigateBrowserCommand extends UICommandBase {
  type: 'navigate_browser';
  item_id: string;
  url: string;
}

/**
 * Add an item to a todo block
 */
export interface AddTodoItemCommand extends UICommandBase {
  type: 'add_todo_item';
  item_id: string;
  text: string;
  completed?: boolean;
}

/**
 * Toggle a todo item's completion status
 */
export interface ToggleTodoItemCommand extends UICommandBase {
  type: 'toggle_todo_item';
  item_id: string;
  todo_item_id: string;
}

/**
 * Union of all UI commands
 */
export type UICommand =
  | CreateBrowserCommand
  | CreateTodoCommand
  | CreateNoteCommand
  | CreateTerminalCommand
  | UpdateItemCommand
  | DeleteItemCommand
  | ConnectNodesCommand
  | DisconnectNodesCommand
  | NavigateBrowserCommand
  | AddTodoItemCommand
  | ToggleTodoItemCommand;

/**
 * UI command message sent over WebSocket
 */
export interface UICommandMessage {
  type: 'ui_command';
  command: UICommand;
}

/**
 * UI command result message
 */
export interface UICommandResultMessage {
  type: 'ui_command_result';
  command_id: string;
  success: boolean;
  error?: string;
  created_item_id?: string;
}

// ============================================
// Integration Policies Types
// ============================================

/**
 * Provider types for terminal integrations
 * Note: Includes 'browser' which doesn't require OAuth (unlike UserIntegration.provider)
 */
export type IntegrationProvider =
  | 'gmail'
  | 'google_calendar'
  | 'google_contacts'
  | 'google_sheets'
  | 'google_forms'
  | 'google_drive'
  | 'onedrive'
  | 'box'
  | 'github'
  | 'browser';

/**
 * Security level for integration policies
 */
export type SecurityLevel = 'restricted' | 'elevated' | 'full';

/**
 * Base policy interface shared by all providers
 */
export interface BasePolicy {
  rateLimits?: {
    readsPerMinute?: number;
    writesPerHour?: number;
    // Provider-specific limits added in each policy
  };
}

/**
 * Gmail policy configuration
 */
export interface GmailPolicy extends BasePolicy {
  canRead: boolean;
  senderFilter?: {
    mode: 'all' | 'allowlist' | 'blocklist';
    domains?: string[];
    addresses?: string[];
  };
  labelFilter?: {
    mode: 'all' | 'allowlist';
    labels?: string[];
  };
  canArchive: boolean;
  canTrash: boolean;
  canMarkRead: boolean;
  canLabel: boolean;
  canSend: boolean;
  sendPolicy?: {
    allowedRecipients?: string[];
    allowedDomains?: string[];
    requiredCc?: string[];
    maxPerHour?: number;
  };
  rateLimits?: BasePolicy['rateLimits'] & {
    sendsPerDay?: number;
    archivesPerHour?: number;
  };
}

/**
 * Calendar policy configuration
 */
export interface CalendarPolicy extends BasePolicy {
  canRead: boolean;
  calendarFilter?: {
    mode: 'all' | 'allowlist';
    calendarIds?: string[];
  };
  canCreate: boolean;
  createPolicy?: {
    maxDuration?: string; // ISO 8601 duration, e.g., "PT2H"
    requireDescription?: boolean;
    allowedCalendars?: string[];
    blockedTimeRanges?: {
      start: string; // "HH:MM"
      end: string;
    }[];
  };
  canUpdate: boolean;
  canDelete: boolean;
  rateLimits?: BasePolicy['rateLimits'] & {
    createsPerDay?: number;
    updatesPerHour?: number;
  };
}

/**
 * Contacts policy configuration
 */
export interface ContactsPolicy extends BasePolicy {
  canRead: boolean;
  contactFilter?: {
    mode: 'all' | 'allowlist' | 'blocklist';
    groups?: string[];
    domains?: string[];
  };
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

/**
 * Sheets policy configuration
 */
export interface SheetsPolicy extends BasePolicy {
  canRead: boolean;
  spreadsheetFilter?: {
    mode: 'all' | 'allowlist';
    spreadsheetIds?: string[];
    folderIds?: string[];
  };
  canWrite: boolean;
  writePolicy?: {
    allowedSpreadsheets?: string[];
    canCreateNew: boolean;
    canDeleteSheets: boolean;
  };
  canUseFormulas: boolean;
  blockedFormulas?: string[];
}

/**
 * Forms policy configuration
 */
export interface FormsPolicy extends BasePolicy {
  canRead: boolean;
  canReadResponses: boolean;
  formFilter?: {
    mode: 'all' | 'allowlist';
    formIds?: string[];
  };
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

/**
 * Google Drive policy configuration
 */
export interface GoogleDrivePolicy extends BasePolicy {
  canRead: boolean;
  canDownload: boolean;
  folderFilter?: {
    mode: 'all' | 'allowlist' | 'blocklist';
    folderIds?: string[];
    folderPaths?: string[];
  };
  fileTypeFilter?: {
    mode: 'all' | 'allowlist' | 'blocklist';
    mimeTypes?: string[];
    extensions?: string[];
  };
  maxFileSize?: number;
  canUpload: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canMove: boolean;
  uploadPolicy?: {
    allowedFolders?: string[];
    allowedTypes?: string[];
    maxFileSize?: number;
  };
  canShare: boolean;
  sharePolicy?: {
    allowedDomains?: string[];
    maxPermission?: 'reader' | 'commenter' | 'writer';
    noPublicSharing: boolean;
  };
  rateLimits?: BasePolicy['rateLimits'] & {
    downloadsPerHour?: number;
  };
}

/**
 * OneDrive policy configuration
 */
export interface OneDrivePolicy extends BasePolicy {
  canRead: boolean;
  canDownload: boolean;
  folderFilter?: {
    mode: 'all' | 'allowlist' | 'blocklist';
    folderPaths?: string[];
  };
  fileTypeFilter?: {
    mode: 'all' | 'allowlist' | 'blocklist';
    extensions?: string[];
  };
  maxFileSize?: number;
  canUpload: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canMove: boolean;
  uploadPolicy?: {
    allowedFolders?: string[];
    allowedTypes?: string[];
    maxFileSize?: number;
  };
  canShare: boolean;
  sharePolicy?: {
    allowedDomains?: string[];
    maxPermission?: 'read' | 'write';
    noAnonymousLinks: boolean;
  };
}

/**
 * Box policy configuration
 */
export interface BoxPolicy extends BasePolicy {
  canRead: boolean;
  canDownload: boolean;
  folderFilter?: {
    mode: 'all' | 'allowlist' | 'blocklist';
    folderIds?: string[];
  };
  fileTypeFilter?: {
    mode: 'all' | 'allowlist' | 'blocklist';
    extensions?: string[];
  };
  maxFileSize?: number;
  canUpload: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canMove: boolean;
  canShare: boolean;
  sharePolicy?: {
    maxAccessLevel?: 'previewer' | 'viewer' | 'editor';
    noOpenAccess: boolean;
  };
}

/**
 * GitHub policy configuration
 */
export interface GitHubPolicy extends BasePolicy {
  canReadRepos: boolean;
  repoFilter?: {
    mode: 'all' | 'allowlist' | 'blocklist';
    repos?: string[];
    orgs?: string[];
    visibility?: 'all' | 'public' | 'private';
  };
  canReadCode: boolean;
  canClone: boolean;
  canPush: boolean;
  pushPolicy?: {
    allowedBranches?: string[];
    blockedBranches?: string[];
    requireBranchPrefix?: string;
  };
  canReadIssues: boolean;
  canCreateIssues: boolean;
  canCommentIssues: boolean;
  canCloseIssues: boolean;
  canReadPRs: boolean;
  canCreatePRs: boolean;
  canApprovePRs: boolean;
  canMergePRs: boolean;
  canCreateReleases: boolean;
  canTriggerActions: boolean;
  canCreateRepos: boolean;
  canDeleteRepos: boolean;
  canManageSettings: boolean;
  rateLimits?: BasePolicy['rateLimits'] & {
    pushesPerDay?: number;
    mergesPerDay?: number;
    prsPerDay?: number;
  };
}

/**
 * Browser policy configuration
 * CRITICAL: Browser is highest-risk - requires URL allowlist
 */
export interface BrowserPolicy extends BasePolicy {
  canNavigate: boolean;
  urlFilter: {
    mode: 'allowlist'; // Must be allowlist for security
    patterns: string[];
    blockedPatterns?: string[];
  };
  canClick: boolean;
  canType: boolean;
  canScroll: boolean;
  canScreenshot: boolean;
  canExtractText: boolean;
  canFillForms: boolean;
  canSubmitForms: boolean;
  formPolicy?: {
    allowedDomains?: string[];
    noPasswordFields: boolean;
    noPaymentFields: boolean;
  };
  canDownload: boolean;
  downloadPolicy?: {
    allowedTypes?: string[];
    maxFileSize?: number;
    allowedDomains?: string[];
  };
  canUpload: boolean;
  uploadPolicy?: {
    allowedDomains?: string[];
    maxFileSize?: number;
  };
  canExecuteJs: boolean;
  jsPolicy?: {
    allowedDomains?: string[];
    noEval: boolean;
  };
  canUseStoredCredentials: boolean;
  canInputCredentials: boolean;
  canReadCookies: boolean;
  canInspectNetwork: boolean;
  canModifyRequests: boolean;
  rateLimits?: BasePolicy['rateLimits'] & {
    navigationsPerMinute?: number;
    requestsPerHour?: number;
  };
}

/**
 * Type-safe policy lookup by provider
 */
export type PolicyForProvider<P extends IntegrationProvider> =
  P extends 'gmail' ? GmailPolicy :
  P extends 'google_calendar' ? CalendarPolicy :
  P extends 'google_contacts' ? ContactsPolicy :
  P extends 'google_sheets' ? SheetsPolicy :
  P extends 'google_forms' ? FormsPolicy :
  P extends 'google_drive' ? GoogleDrivePolicy :
  P extends 'onedrive' ? OneDrivePolicy :
  P extends 'box' ? BoxPolicy :
  P extends 'github' ? GitHubPolicy :
  P extends 'browser' ? BrowserPolicy :
  never;

/**
 * Union of all policy types
 */
export type AnyPolicy =
  | GmailPolicy
  | CalendarPolicy
  | ContactsPolicy
  | SheetsPolicy
  | FormsPolicy
  | GoogleDrivePolicy
  | OneDrivePolicy
  | BoxPolicy
  | GitHubPolicy
  | BrowserPolicy;

/**
 * Terminal integration binding (immutable once created)
 */
export interface TerminalIntegration {
  id: string;
  terminalId: string;
  dashboardId: string;
  userId: string;
  provider: IntegrationProvider;
  userIntegrationId: string | null; // NULL for browser
  activePolicyId: string | null;
  accountEmail: string | null;
  accountLabel: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

/**
 * Integration policy revision (append-only)
 */
export interface IntegrationPolicy {
  id: string;
  terminalIntegrationId: string;
  version: number;
  policy: AnyPolicy;
  securityLevel: SecurityLevel;
  createdAt: string;
  createdBy: string;
}

/**
 * Integration audit log entry
 */
export interface IntegrationAuditLog {
  id: string;
  terminalIntegrationId: string;
  terminalId: string;
  dashboardId: string;
  userId: string;
  provider: IntegrationProvider;
  action: string;
  resourceId: string | null;
  policyId: string;
  policyVersion: number;
  policyDecision: 'allowed' | 'denied' | 'filtered';
  denialReason: string | null;
  requestSummary: string | null;
  createdAt: string;
}

/**
 * High-risk confirmation record
 */
export interface HighRiskConfirmation {
  id: string;
  terminalIntegrationId: string;
  capability: string;
  confirmedAt: string;
  confirmedBy: string;
  userAgent: string | null;
  ipAddress: string | null;
}

/**
 * Terminal integration with active policy (for API responses)
 */
export interface TerminalIntegrationWithPolicy extends TerminalIntegration {
  policy: AnyPolicy | null;
  policyVersion: number | null;
  securityLevel: SecurityLevel | null;
}

/**
 * Available integration for attaching (API response)
 */
export interface AvailableIntegration {
  provider: IntegrationProvider;
  userIntegrationId?: string;
  accountEmail?: string;
  accountLabel?: string;
  connected: boolean;
  attached: boolean;
  terminalIntegrationId?: string;
  policyId?: string;
}

/**
 * High-risk capabilities that require explicit confirmation
 */
export const HIGH_RISK_CAPABILITIES: Record<IntegrationProvider, string[]> = {
  gmail: ['canSend', 'canTrash'],
  google_calendar: ['canDelete'],
  google_contacts: ['canDelete'],
  google_sheets: ['writePolicy.canDeleteSheets'],
  google_forms: ['canDelete'],
  google_drive: ['canDelete', 'canShare'],
  onedrive: ['canDelete', 'canShare'],
  box: ['canDelete', 'canShare'],
  github: ['canPush', 'canMergePRs', 'canApprovePRs', 'canDeleteRepos'],
  browser: ['canSubmitForms', 'canExecuteJs', 'canUpload', 'canInputCredentials'],
};
