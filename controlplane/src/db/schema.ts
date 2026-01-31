// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Database Schema
 *
 * D1 (SQLite) schema for durable state.
 * This is the source of truth - Durable Objects can be rebuilt from this.
 */

export const SCHEMA = `
-- Users
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Dashboards
CREATE TABLE IF NOT EXISTS dashboards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dashboards_owner ON dashboards(owner_id);

-- Dashboard members (for sharing)
CREATE TABLE IF NOT EXISTS dashboard_members (
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (dashboard_id, user_id)
);

-- Dashboard invitations (pending access for non-existing users)
CREATE TABLE IF NOT EXISTS dashboard_invitations (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  invited_by TEXT NOT NULL REFERENCES users(id),
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  accepted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_invitations_dashboard ON dashboard_invitations(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON dashboard_invitations(email);

-- Dashboard items (notes, todos, terminal attachments, links, browsers)
CREATE TABLE IF NOT EXISTS dashboard_items (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('note', 'todo', 'terminal', 'link', 'browser', 'workspace', 'prompt', 'schedule', 'gmail', 'calendar', 'contacts', 'sheets', 'forms')),
  content TEXT NOT NULL DEFAULT '',
  position_x INTEGER NOT NULL DEFAULT 0,
  position_y INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 200,
  height INTEGER NOT NULL DEFAULT 150,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_dashboard ON dashboard_items(dashboard_id);

-- Dashboard edges (connections between blocks)
CREATE TABLE IF NOT EXISTS dashboard_edges (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  source_item_id TEXT NOT NULL REFERENCES dashboard_items(id) ON DELETE CASCADE,
  target_item_id TEXT NOT NULL REFERENCES dashboard_items(id) ON DELETE CASCADE,
  source_handle TEXT,
  target_handle TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_edges_dashboard ON dashboard_edges(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_edges_source ON dashboard_edges(source_item_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON dashboard_edges(target_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique
  ON dashboard_edges(dashboard_id, source_item_id, target_item_id, source_handle, target_handle);

-- Sessions (map dashboard terminals to sandbox sessions)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES dashboard_items(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  owner_name TEXT NOT NULL DEFAULT '',
  sandbox_session_id TEXT NOT NULL,
  sandbox_machine_id TEXT NOT NULL DEFAULT '',
  pty_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('creating', 'active', 'stopped', 'error')),
  region TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  stopped_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_dashboard ON sessions(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_sessions_item ON sessions(item_id);

-- Dashboard sandbox mapping (one sandbox per dashboard)
CREATE TABLE IF NOT EXISTS dashboard_sandboxes (
  dashboard_id TEXT PRIMARY KEY REFERENCES dashboards(id) ON DELETE CASCADE,
  sandbox_session_id TEXT NOT NULL,
  sandbox_machine_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Agent profiles (reusable agent configurations)
CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tools TEXT NOT NULL DEFAULT '[]',
  system_prompt TEXT NOT NULL DEFAULT '',
  policy TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- User subagents (Claude Code subagent favorites)
CREATE TABLE IF NOT EXISTS user_subagents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  tools TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'custom',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_subagents_user ON user_subagents(user_id);

-- User agent skills (Claude Code slash command favorites)
CREATE TABLE IF NOT EXISTS user_agent_skills (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  command TEXT NOT NULL DEFAULT '',
  args TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'custom',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_agent_skills_user ON user_agent_skills(user_id);

-- User MCP tools (Model Context Protocol tool configurations)
CREATE TABLE IF NOT EXISTS user_mcp_tools (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  server_url TEXT NOT NULL DEFAULT '',
  transport TEXT NOT NULL DEFAULT 'stdio' CHECK (transport IN ('stdio', 'sse', 'streamable-http')),
  config TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'custom',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_mcp_tools_user ON user_mcp_tools(user_id);

-- User secrets and environment variables
-- type='secret' → brokered (for API keys, credentials)
-- type='env_var' → set directly (for regular config)
CREATE TABLE IF NOT EXISTS user_secrets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dashboard_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'secret' CHECK (type IN ('secret', 'env_var')),
  broker_protected INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_secrets_user ON user_secrets(user_id);
CREATE INDEX IF NOT EXISTS idx_user_secrets_dashboard ON user_secrets(dashboard_id);

-- OAuth state (short-lived)
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_user ON oauth_states(user_id);

-- User integrations (OAuth tokens)
CREATE TABLE IF NOT EXISTS user_integrations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google_drive', 'github', 'gmail', 'google_calendar', 'google_contacts', 'google_sheets', 'box', 'onedrive')),
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  scope TEXT,
  token_type TEXT,
  expires_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_integrations_user_provider
  ON user_integrations(user_id, provider);

-- Drive mirrors (per dashboard)
CREATE TABLE IF NOT EXISTS drive_mirrors (
  dashboard_id TEXT PRIMARY KEY REFERENCES dashboards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('idle', 'syncing_cache', 'syncing_workspace', 'ready', 'error')),
  total_files INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  cache_synced_files INTEGER NOT NULL DEFAULT 0,
  cache_synced_bytes INTEGER NOT NULL DEFAULT 0,
  workspace_synced_files INTEGER NOT NULL DEFAULT 0,
  workspace_synced_bytes INTEGER NOT NULL DEFAULT 0,
  large_files INTEGER NOT NULL DEFAULT 0,
  large_bytes INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  sync_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_drive_mirrors_user ON drive_mirrors(user_id);

-- GitHub mirrors (per dashboard)
CREATE TABLE IF NOT EXISTS github_mirrors (
  dashboard_id TEXT PRIMARY KEY REFERENCES dashboards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  repo_branch TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('idle', 'syncing_cache', 'syncing_workspace', 'ready', 'error')),
  total_files INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  cache_synced_files INTEGER NOT NULL DEFAULT 0,
  cache_synced_bytes INTEGER NOT NULL DEFAULT 0,
  workspace_synced_files INTEGER NOT NULL DEFAULT 0,
  workspace_synced_bytes INTEGER NOT NULL DEFAULT 0,
  large_files INTEGER NOT NULL DEFAULT 0,
  large_bytes INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  sync_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_github_mirrors_user ON github_mirrors(user_id);

-- Box mirrors (per dashboard)
CREATE TABLE IF NOT EXISTS box_mirrors (
  dashboard_id TEXT PRIMARY KEY REFERENCES dashboards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('idle', 'syncing_cache', 'syncing_workspace', 'ready', 'error')),
  total_files INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  cache_synced_files INTEGER NOT NULL DEFAULT 0,
  cache_synced_bytes INTEGER NOT NULL DEFAULT 0,
  workspace_synced_files INTEGER NOT NULL DEFAULT 0,
  workspace_synced_bytes INTEGER NOT NULL DEFAULT 0,
  large_files INTEGER NOT NULL DEFAULT 0,
  large_bytes INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  sync_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_box_mirrors_user ON box_mirrors(user_id);

-- OneDrive mirrors (per dashboard)
CREATE TABLE IF NOT EXISTS onedrive_mirrors (
  dashboard_id TEXT PRIMARY KEY REFERENCES dashboards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('idle', 'syncing_cache', 'syncing_workspace', 'ready', 'error')),
  total_files INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  cache_synced_files INTEGER NOT NULL DEFAULT 0,
  cache_synced_bytes INTEGER NOT NULL DEFAULT 0,
  workspace_synced_files INTEGER NOT NULL DEFAULT 0,
  workspace_synced_bytes INTEGER NOT NULL DEFAULT 0,
  large_files INTEGER NOT NULL DEFAULT 0,
  large_bytes INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  sync_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_onedrive_mirrors_user ON onedrive_mirrors(user_id);

-- Gmail mirrors (per dashboard)
CREATE TABLE IF NOT EXISTS gmail_mirrors (
  dashboard_id TEXT PRIMARY KEY REFERENCES dashboards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_address TEXT NOT NULL,
  label_ids TEXT NOT NULL DEFAULT '["INBOX"]',
  history_id TEXT,
  watch_expiration TEXT,
  status TEXT NOT NULL CHECK (status IN ('idle', 'syncing', 'watching', 'ready', 'error')),
  last_synced_at TEXT,
  sync_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gmail_mirrors_user ON gmail_mirrors(user_id);
CREATE INDEX IF NOT EXISTS idx_gmail_mirrors_email ON gmail_mirrors(email_address);

-- Gmail messages (metadata cache)
CREATE TABLE IF NOT EXISTS gmail_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  internal_date TEXT NOT NULL,
  from_header TEXT,
  to_header TEXT,
  subject TEXT,
  snippet TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  size_estimate INTEGER,
  body_state TEXT NOT NULL DEFAULT 'none' CHECK (body_state IN ('none', 'snippet', 'full')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gmail_messages_user ON gmail_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_gmail_messages_dashboard ON gmail_messages(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_gmail_messages_thread ON gmail_messages(thread_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gmail_messages_message ON gmail_messages(dashboard_id, message_id);

-- Gmail action audit log
CREATE TABLE IF NOT EXISTS gmail_actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('label_add', 'label_remove', 'archive', 'trash', 'mark_read', 'mark_unread')),
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gmail_actions_user ON gmail_actions(user_id);
CREATE INDEX IF NOT EXISTS idx_gmail_actions_dashboard ON gmail_actions(dashboard_id);

-- Calendar mirrors (per dashboard)
CREATE TABLE IF NOT EXISTS calendar_mirrors (
  dashboard_id TEXT PRIMARY KEY REFERENCES dashboards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_address TEXT NOT NULL,
  calendar_id TEXT NOT NULL DEFAULT 'primary',
  status TEXT NOT NULL CHECK (status IN ('idle', 'syncing', 'watching', 'ready', 'error')),
  sync_token TEXT,
  last_synced_at TEXT,
  sync_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_calendar_mirrors_user ON calendar_mirrors(user_id);

-- Calendar events (metadata cache)
CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  summary TEXT,
  description TEXT,
  location TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  status TEXT,
  html_link TEXT,
  organizer_email TEXT,
  attendees TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_user ON calendar_events(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_dashboard ON calendar_events(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events(start_time);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_events_event ON calendar_events(dashboard_id, event_id);

-- Contacts mirrors (per dashboard)
CREATE TABLE IF NOT EXISTS contacts_mirrors (
  dashboard_id TEXT PRIMARY KEY REFERENCES dashboards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_address TEXT NOT NULL,
  sync_token TEXT,
  status TEXT NOT NULL CHECK (status IN ('idle', 'syncing', 'ready', 'error')),
  last_synced_at TEXT,
  sync_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contacts_mirrors_user ON contacts_mirrors(user_id);

-- Contacts cache
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  resource_name TEXT NOT NULL,
  display_name TEXT,
  given_name TEXT,
  family_name TEXT,
  email_addresses TEXT NOT NULL DEFAULT '[]',
  phone_numbers TEXT NOT NULL DEFAULT '[]',
  organizations TEXT NOT NULL DEFAULT '[]',
  photo_url TEXT,
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_dashboard ON contacts(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(display_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_resource ON contacts(dashboard_id, resource_name);

-- Sheets mirrors (per dashboard)
CREATE TABLE IF NOT EXISTS sheets_mirrors (
  dashboard_id TEXT PRIMARY KEY REFERENCES dashboards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_address TEXT NOT NULL,
  spreadsheet_id TEXT,
  spreadsheet_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('idle', 'linked', 'error')),
  last_accessed_at TEXT,
  sync_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sheets_mirrors_user ON sheets_mirrors(user_id);

-- Forms mirrors (per dashboard)
CREATE TABLE IF NOT EXISTS forms_mirrors (
  dashboard_id TEXT PRIMARY KEY REFERENCES dashboards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_address TEXT NOT NULL,
  form_id TEXT,
  form_title TEXT,
  status TEXT NOT NULL CHECK (status IN ('idle', 'linked', 'error')),
  last_accessed_at TEXT,
  sync_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_forms_mirrors_user ON forms_mirrors(user_id);

-- Form responses cache
CREATE TABLE IF NOT EXISTS form_responses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  form_id TEXT NOT NULL,
  response_id TEXT NOT NULL,
  respondent_email TEXT,
  submitted_at TEXT NOT NULL,
  answers TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_form_responses_user ON form_responses(user_id);
CREATE INDEX IF NOT EXISTS idx_form_responses_dashboard ON form_responses(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_form_responses_form ON form_responses(form_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_form_responses_response ON form_responses(dashboard_id, response_id);

-- Auth sessions (first-party login)
CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);

-- OAuth login states (short-lived)
CREATE TABLE IF NOT EXISTS auth_states (
  state TEXT PRIMARY KEY,
  redirect_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Recipes (workflow definitions)
CREATE TABLE IF NOT EXISTS recipes (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT REFERENCES dashboards(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_recipes_dashboard ON recipes(dashboard_id);

-- Executions (workflow runs)
CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed')),
  current_step_id TEXT,
  context TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_executions_recipe ON executions(recipe_id);
CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);

-- Artifacts (outputs from executions)
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('file', 'log', 'summary', 'output')),
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_artifacts_execution ON artifacts(execution_id);

-- Schedules (cron or event triggers)
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cron TEXT,
  event_trigger TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_schedules_recipe ON schedules(recipe_id);
CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules(next_run_at);

-- System health (cached health check results)
CREATE TABLE IF NOT EXISTS system_health (
  service TEXT PRIMARY KEY,
  is_healthy INTEGER NOT NULL DEFAULT 0,
  last_check_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

-- Secret domain allowlist (approved domains for custom secrets)
CREATE TABLE IF NOT EXISTS user_secret_allowlist (
  id TEXT PRIMARY KEY,
  secret_id TEXT NOT NULL REFERENCES user_secrets(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  header_name TEXT NOT NULL DEFAULT 'Authorization',
  header_format TEXT NOT NULL DEFAULT 'Bearer %s',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_secret_allowlist_secret ON user_secret_allowlist(secret_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_secret_allowlist_unique ON user_secret_allowlist(secret_id, domain) WHERE revoked_at IS NULL;

-- Pending domain approval requests (for notification)
CREATE TABLE IF NOT EXISTS pending_domain_approvals (
  id TEXT PRIMARY KEY,
  secret_id TEXT NOT NULL REFERENCES user_secrets(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  dismissed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_approvals_secret ON pending_domain_approvals(secret_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_approvals_unique ON pending_domain_approvals(secret_id, domain) WHERE dismissed_at IS NULL;

-- Dashboard templates (global, shareable)
CREATE TABLE IF NOT EXISTS dashboard_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'custom' CHECK (category IN ('coding', 'automation', 'documentation', 'custom')),
  preview_image_url TEXT,
  author_id TEXT NOT NULL REFERENCES users(id),
  author_name TEXT NOT NULL DEFAULT '',
  items_json TEXT NOT NULL DEFAULT '[]',
  edges_json TEXT NOT NULL DEFAULT '[]',
  item_count INTEGER NOT NULL DEFAULT 0,
  is_featured INTEGER NOT NULL DEFAULT 0,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_templates_category ON dashboard_templates(category);
CREATE INDEX IF NOT EXISTS idx_templates_featured ON dashboard_templates(is_featured);
CREATE INDEX IF NOT EXISTS idx_templates_author ON dashboard_templates(author_id);
`;

// Initialize the database
export async function initializeDatabase(db: D1Database): Promise<void> {
  // Split into individual statements and execute
  const statements = SCHEMA
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const statement of statements) {
    await db.prepare(statement).run();
  }

  try {
    await db.prepare(`
      ALTER TABLE sessions ADD COLUMN sandbox_machine_id TEXT NOT NULL DEFAULT ''
    `).run();
  } catch {
    // Column already exists.
  }

  try {
    await db.prepare(`
      ALTER TABLE oauth_states ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'
    `).run();
  } catch {
    // Column already exists.
  }

  try {
    await db.prepare(`
      ALTER TABLE user_secrets ADD COLUMN dashboard_id TEXT NOT NULL DEFAULT ''
    `).run();
  } catch {
    // Column already exists.
  }

  // Add encrypted_at column for tracking secret encryption status
  try {
    await db.prepare(`
      ALTER TABLE user_secrets ADD COLUMN encrypted_at TEXT
    `).run();
  } catch {
    // Column already exists.
  }

  // Add broker_protected column for secrets protection
  try {
    await db.prepare(`
      ALTER TABLE user_secrets ADD COLUMN broker_protected INTEGER NOT NULL DEFAULT 1
    `).run();
  } catch {
    // Column already exists.
  }

  // Add type column to distinguish secrets from env vars
  try {
    await db.prepare(`
      ALTER TABLE user_secrets ADD COLUMN type TEXT NOT NULL DEFAULT 'secret'
    `).run();
  } catch {
    // Column already exists.
  }

  // Create index on type column (must be after the column exists)
  try {
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_user_secrets_type ON user_secrets(type)
    `).run();
  } catch {
    // Index already exists or column doesn't exist yet.
  }

  // Add applied_secret_names column to track which secrets were applied
  // Used to compute unset list when secrets are deleted
  try {
    await db.prepare(`
      ALTER TABLE dashboard_sandboxes ADD COLUMN applied_secret_names TEXT NOT NULL DEFAULT '[]'
    `).run();
  } catch {
    // Column already exists.
  }

  // Add metadata column to dashboard_items BEFORE type migration
  // (type migration copies this column, so it must exist first)
  try {
    await db.prepare(`
      ALTER TABLE dashboard_items ADD COLUMN metadata TEXT
    `).run();
  } catch {
    // Column already exists.
  }

  await migrateDashboardItemTypes(db);
  await migrateUserIntegrationProviders(db);
}

// All valid integration providers - add new providers here
const INTEGRATION_PROVIDERS = ['google_drive', 'github', 'gmail', 'google_calendar', 'google_contacts', 'google_sheets', 'google_forms', 'box', 'onedrive'] as const;

async function migrateUserIntegrationProviders(db: D1Database): Promise<void> {
  const tableInfo = await db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_integrations'
  `).first<{ sql: string }>();

  if (!tableInfo?.sql) {
    return;
  }

  // Check if all required providers are present in the CHECK constraint
  const allProvidersPresent = INTEGRATION_PROVIDERS.every(provider => tableInfo.sql.includes(`'${provider}'`));
  // Also check if required columns exist (scope column was missing in some migrations)
  const hasRequiredColumns = tableInfo.sql.includes('scope TEXT');

  if (allProvidersPresent && hasRequiredColumns) {
    return;
  }

  // Recreate table with updated CHECK constraint
  const providerList = INTEGRATION_PROVIDERS.map(p => `'${p}'`).join(', ');

  await db.prepare(`PRAGMA foreign_keys=OFF`).run();
  // Clean up any leftover table from a failed migration
  await db.prepare(`DROP TABLE IF EXISTS user_integrations_new`).run();
  await db.prepare(`
    CREATE TABLE user_integrations_new (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN (${providerList})),
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      scope TEXT,
      token_type TEXT,
      expires_at TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
  // Only copy columns that exist in the old table - new columns will use defaults
  await db.prepare(`
    INSERT INTO user_integrations_new
      (id, user_id, provider, access_token, refresh_token, created_at, updated_at)
    SELECT id, user_id, provider, access_token, refresh_token, created_at, updated_at
    FROM user_integrations
  `).run();
  await db.prepare(`DROP TABLE user_integrations`).run();
  await db.prepare(`ALTER TABLE user_integrations_new RENAME TO user_integrations`).run();
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_integrations_user_provider ON user_integrations(user_id, provider)`).run();
  await db.prepare(`PRAGMA foreign_keys=ON`).run();
}

// All valid dashboard item types - add new types here
const DASHBOARD_ITEM_TYPES = ['note', 'todo', 'terminal', 'link', 'browser', 'workspace', 'prompt', 'schedule', 'gmail', 'calendar', 'contacts', 'sheets', 'forms'] as const;

async function migrateDashboardItemTypes(db: D1Database): Promise<void> {
  const tableInfo = await db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dashboard_items'
  `).first<{ sql: string }>();

  if (!tableInfo?.sql) {
    return;
  }

  // Check if all required types are present in the CHECK constraint
  const allTypesPresent = DASHBOARD_ITEM_TYPES.every(type => tableInfo.sql.includes(`'${type}'`));
  if (allTypesPresent) {
    return;
  }

  // Recreate table with updated CHECK constraint
  const typeList = DASHBOARD_ITEM_TYPES.map(t => `'${t}'`).join(', ');

  await db.prepare(`PRAGMA foreign_keys=OFF`).run();
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS dashboard_items_new (
      id TEXT PRIMARY KEY,
      dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN (${typeList})),
      content TEXT NOT NULL DEFAULT '',
      position_x INTEGER NOT NULL DEFAULT 0,
      position_y INTEGER NOT NULL DEFAULT 0,
      width INTEGER NOT NULL DEFAULT 200,
      height INTEGER NOT NULL DEFAULT 150,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
  await db.prepare(`
    INSERT INTO dashboard_items_new
      (id, dashboard_id, type, content, position_x, position_y, width, height, metadata, created_at, updated_at)
    SELECT id, dashboard_id, type, content, position_x, position_y, width, height, metadata, created_at, updated_at
    FROM dashboard_items
  `).run();
  await db.prepare(`DROP TABLE dashboard_items`).run();
  await db.prepare(`ALTER TABLE dashboard_items_new RENAME TO dashboard_items`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_items_dashboard ON dashboard_items(dashboard_id)`).run();
  await db.prepare(`PRAGMA foreign_keys=ON`).run();
}
