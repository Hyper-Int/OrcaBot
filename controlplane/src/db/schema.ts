// Copyright 2026 Rob Macrae. All rights reserved.
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
  type TEXT NOT NULL CHECK (type IN ('note', 'todo', 'terminal', 'link', 'browser', 'workspace', 'prompt', 'schedule', 'decision', 'gmail', 'calendar', 'contacts', 'sheets', 'forms', 'slack', 'discord', 'telegram', 'whatsapp', 'teams', 'matrix', 'google_chat')),
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
-- SECURITY CRITICAL: The PRIMARY KEY on dashboard_id enforces that each dashboard
-- gets exactly ONE dedicated VM. This isolation is essential for secrets security.
-- DO NOT modify this to allow multiple dashboards per sandbox or shared sandboxes.
-- The secrets broker runs per-sandbox and would leak secrets/approvals between
-- dashboards if this 1:1 mapping were ever broken.
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_secrets_unique_name ON user_secrets(user_id, dashboard_id, name);

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
  provider TEXT NOT NULL CHECK (provider IN ('google_drive', 'github', 'gmail', 'google_calendar', 'google_contacts', 'google_sheets', 'google_forms', 'box', 'onedrive', 'slack', 'discord', 'telegram', 'whatsapp', 'teams', 'matrix', 'google_chat')),
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
  cache_last_path TEXT,
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

-- GitHub repo history (per dashboard)
CREATE TABLE IF NOT EXISTS github_repo_history (
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  repo_branch TEXT NOT NULL,
  last_linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (dashboard_id, repo_owner, repo_name)
);

CREATE INDEX IF NOT EXISTS idx_github_repo_history_user ON github_repo_history(user_id);
CREATE INDEX IF NOT EXISTS idx_github_repo_history_dashboard ON github_repo_history(dashboard_id);

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
-- recipe_id is nullable: edge-based schedules use dashboard_item_id instead
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  recipe_id TEXT REFERENCES recipes(id) ON DELETE CASCADE,
  dashboard_id TEXT REFERENCES dashboards(id) ON DELETE CASCADE,
  dashboard_item_id TEXT,
  command TEXT,
  name TEXT NOT NULL,
  cron TEXT,
  event_trigger TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (recipe_id IS NOT NULL OR dashboard_item_id IS NOT NULL),
  CHECK (dashboard_item_id IS NULL OR dashboard_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_schedules_recipe ON schedules(recipe_id);
CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules(next_run_at);
CREATE INDEX IF NOT EXISTS idx_schedules_dashboard ON schedules(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_schedules_item ON schedules(dashboard_item_id);

-- Schedule executions (track each cron/manual trigger)
CREATE TABLE IF NOT EXISTS schedule_executions (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'timed_out')),
  triggered_by TEXT NOT NULL DEFAULT 'cron',
  terminals_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_schedule_executions_schedule ON schedule_executions(schedule_id);
CREATE INDEX IF NOT EXISTS idx_schedule_executions_status ON schedule_executions(status);

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
  viewport_json TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  is_featured INTEGER NOT NULL DEFAULT 0,
  use_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending_review', 'approved', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_templates_category ON dashboard_templates(category);
CREATE INDEX IF NOT EXISTS idx_templates_featured ON dashboard_templates(is_featured);
CREATE INDEX IF NOT EXISTS idx_templates_author ON dashboard_templates(author_id);

-- Terminal integrations (per-terminal integration bindings)
-- SECURITY: Each binding is immutable once created (terminal_id, provider, user_integration_id cannot change)
-- Uses soft delete to preserve audit history
CREATE TABLE IF NOT EXISTS terminal_integrations (
  id TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL,
  item_id TEXT,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('gmail', 'google_calendar', 'google_contacts', 'google_sheets', 'google_forms', 'google_drive', 'onedrive', 'box', 'github', 'browser', 'slack', 'discord', 'telegram', 'whatsapp', 'teams', 'matrix', 'google_chat')),
  user_integration_id TEXT REFERENCES user_integrations(id),
  active_policy_id TEXT,
  account_email TEXT,
  account_label TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT NOT NULL REFERENCES users(id),
  CHECK (provider IN ('browser', 'whatsapp') OR user_integration_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_terminal_integrations_terminal ON terminal_integrations(terminal_id);
CREATE INDEX IF NOT EXISTS idx_terminal_integrations_dashboard ON terminal_integrations(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_terminal_integrations_user ON terminal_integrations(user_id);

-- Integration policies (append-only policy revisions)
CREATE TABLE IF NOT EXISTS integration_policies (
  id TEXT PRIMARY KEY,
  terminal_integration_id TEXT NOT NULL REFERENCES terminal_integrations(id),
  version INTEGER NOT NULL,
  policy TEXT NOT NULL,
  security_level TEXT NOT NULL CHECK (security_level IN ('restricted', 'elevated', 'full')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT NOT NULL REFERENCES users(id),
  UNIQUE(terminal_integration_id, version)
);

CREATE INDEX IF NOT EXISTS idx_policies_terminal_integration ON integration_policies(terminal_integration_id);

-- Integration audit log (all gateway operations)
CREATE TABLE IF NOT EXISTS integration_audit_log (
  id TEXT PRIMARY KEY,
  terminal_integration_id TEXT NOT NULL REFERENCES terminal_integrations(id),
  terminal_id TEXT NOT NULL,
  dashboard_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_id TEXT,
  policy_id TEXT NOT NULL REFERENCES integration_policies(id),
  policy_version INTEGER NOT NULL,
  policy_decision TEXT NOT NULL CHECK (policy_decision IN ('allowed', 'denied', 'filtered')),
  denial_reason TEXT,
  request_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_terminal ON integration_audit_log(terminal_id);
CREATE INDEX IF NOT EXISTS idx_audit_dashboard ON integration_audit_log(dashboard_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_policy ON integration_audit_log(policy_id);
CREATE INDEX IF NOT EXISTS idx_audit_terminal_integration ON integration_audit_log(terminal_integration_id);

-- High-risk capability confirmations (anti-social-engineering audit trail)
CREATE TABLE IF NOT EXISTS high_risk_confirmations (
  id TEXT PRIMARY KEY,
  terminal_integration_id TEXT NOT NULL REFERENCES terminal_integrations(id),
  capability TEXT NOT NULL,
  confirmed_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_by TEXT NOT NULL REFERENCES users(id),
  user_agent TEXT,
  ip_address TEXT
);

CREATE INDEX IF NOT EXISTS idx_high_risk_terminal_integration ON high_risk_confirmations(terminal_integration_id);

-- Messaging subscriptions (inbound channel/chat bindings for messaging blocks)
CREATE TABLE IF NOT EXISTS messaging_subscriptions (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES dashboard_items(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('slack', 'discord', 'telegram', 'whatsapp', 'teams', 'matrix', 'google_chat')),
  channel_id TEXT,
  channel_name TEXT,
  chat_id TEXT,
  team_id TEXT,
  webhook_id TEXT UNIQUE,
  webhook_secret TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'paused', 'error')),
  last_message_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messaging_subs_dashboard ON messaging_subscriptions(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_messaging_subs_item ON messaging_subscriptions(item_id);
CREATE INDEX IF NOT EXISTS idx_messaging_subs_webhook ON messaging_subscriptions(webhook_id);
CREATE INDEX IF NOT EXISTS idx_messaging_subs_provider_channel ON messaging_subscriptions(provider, channel_id);
CREATE INDEX IF NOT EXISTS idx_messaging_subs_provider_team_channel ON messaging_subscriptions(provider, team_id, channel_id);
-- Unique per block + provider + channel + chat (allows multi-channel per block).
-- WhatsApp uses channel_id=phone_number_id + chat_id=sender_phone, so we need both.
-- Telegram/Matrix use chat_id only. Slack/Discord use channel_id only.
-- COALESCE('') prevents SQLite from ignoring NULLs in the unique constraint.
-- Migration guard: deactivate any legacy rows with both fields null before
-- recreating the index, since COALESCE('','') would cause collisions.
-- Exclude bridge (personal WhatsApp) subscriptions which intentionally have
-- both fields null — they use webhook_id prefix 'bridge_' for identification.
UPDATE messaging_subscriptions
  SET status = 'error', error_message = 'migrated: missing channel scope'
  WHERE channel_id IS NULL AND chat_id IS NULL AND status IN ('pending', 'active')
    AND webhook_id NOT LIKE 'bridge_%';
DROP INDEX IF EXISTS idx_messaging_subs_active_channel;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messaging_subs_active_channel
  ON messaging_subscriptions(dashboard_id, item_id, provider, COALESCE(channel_id, ''), COALESCE(chat_id, ''))
  WHERE status IN ('pending', 'active');

-- Inbound messages (buffer for messages arriving while VM is sleeping)
CREATE TABLE IF NOT EXISTS inbound_messages (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES messaging_subscriptions(id) ON DELETE CASCADE,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('slack', 'discord', 'telegram', 'whatsapp', 'teams', 'matrix', 'google_chat')),
  platform_message_id TEXT NOT NULL,
  sender_id TEXT,
  sender_name TEXT,
  channel_id TEXT,
  channel_name TEXT,
  message_text TEXT,
  message_metadata TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('buffered', 'delivering', 'delivered', 'failed', 'expired')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  delivered_terminals TEXT NOT NULL DEFAULT '[]',
  delivered_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inbound_messages_sub ON inbound_messages(subscription_id);
CREATE INDEX IF NOT EXISTS idx_inbound_messages_dashboard ON inbound_messages(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_inbound_messages_status ON inbound_messages(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_messages_dedup ON inbound_messages(subscription_id, platform_message_id);
CREATE INDEX IF NOT EXISTS idx_inbound_messages_expires ON inbound_messages(expires_at);

-- ============================================
-- Agent State: Tasks & Memory
-- ============================================

-- Agent tasks (per-dashboard, optionally scoped to session/terminal)
CREATE TABLE IF NOT EXISTS agent_tasks (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  session_id TEXT,                              -- Optional: scope to specific terminal
  parent_id TEXT REFERENCES agent_tasks(id),    -- Subtasks

  -- Task content
  subject TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'blocked', 'completed', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,

  -- Dependencies (JSON arrays of task IDs)
  blocked_by TEXT NOT NULL DEFAULT '[]',
  blocks TEXT NOT NULL DEFAULT '[]',

  -- Agent metadata
  owner_agent TEXT,                             -- Which agent owns this task
  metadata TEXT NOT NULL DEFAULT '{}',          -- Flexible JSON for agent-specific data

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_dashboard ON agent_tasks(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(dashboard_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_session ON agent_tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_parent ON agent_tasks(parent_id);

-- Agent memory (key-value store with optional categorization)
CREATE TABLE IF NOT EXISTS agent_memory (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  session_id TEXT,                              -- Optional: scope to specific terminal

  -- Memory content
  key TEXT NOT NULL,                            -- e.g., "project_structure", "last_error"
  value TEXT NOT NULL,                          -- JSON blob
  memory_type TEXT NOT NULL DEFAULT 'fact'
    CHECK (memory_type IN ('fact', 'context', 'preference', 'summary', 'checkpoint')),

  -- Categorization
  tags TEXT NOT NULL DEFAULT '[]',              -- JSON array for filtering

  -- Lifecycle
  expires_at TEXT,                              -- Optional TTL
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_dashboard ON agent_memory(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_key ON agent_memory(dashboard_id, key);
CREATE INDEX IF NOT EXISTS idx_agent_memory_session ON agent_memory(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_type ON agent_memory(dashboard_id, memory_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memory_unique_key ON agent_memory(dashboard_id, key) WHERE session_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memory_unique_key_session ON agent_memory(dashboard_id, session_id, key) WHERE session_id IS NOT NULL;

-- ============================================
-- User Subscriptions (Stripe billing)
-- ============================================

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL DEFAULT 'incomplete',
  current_period_end TEXT,
  cancel_at_period_end INTEGER DEFAULT 0,
  stripe_trial_end TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_subscriptions_user ON user_subscriptions(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_subscriptions_stripe_customer ON user_subscriptions(stripe_customer_id);

-- ============================================
-- Chat Messages (Orcabot Chat Interface)
-- ============================================

-- ============================================
-- Egress Proxy (Network Access Control)
-- ============================================

-- Egress allowlist (user-approved domains per dashboard)
CREATE TABLE IF NOT EXISTS egress_allowlist (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_egress_allowlist_dashboard
  ON egress_allowlist(dashboard_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_egress_allowlist_dashboard_domain_active
  ON egress_allowlist(dashboard_id, domain)
  WHERE revoked_at IS NULL;

-- Egress audit log (all proxy decisions)
CREATE TABLE IF NOT EXISTS egress_audit_log (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  port INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allowed','denied','timeout','default_allowed','allow_once','allow_always','deny')),
  decided_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_egress_audit_dashboard
  ON egress_audit_log(dashboard_id, created_at);

-- Analytics events (first-party usage tracking)
CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dashboard_id TEXT,
  event_name TEXT NOT NULL,
  properties TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_analytics_user_created ON analytics_events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_event_created ON analytics_events(event_name, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_dashboard_created ON analytics_events(dashboard_id, created_at);

-- Chat messages for Orcabot conversational interface
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dashboard_id TEXT REFERENCES dashboards(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  tool_calls TEXT,         -- JSON array of tool calls (for assistant messages)
  tool_results TEXT,       -- JSON array of tool results (for tool messages)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_dashboard ON chat_messages(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_user_dashboard ON chat_messages(user_id, dashboard_id, created_at);
`;

// Initialize the database
const SCHEMA_REVISION = "schema-v11-analytics-events";

export async function initializeDatabase(db: D1Database): Promise<void> {
  console.log(`[schema] REVISION: ${SCHEMA_REVISION} loaded at ${new Date().toISOString()}`);
  // Split into individual statements and execute.
  // IMPORTANT: Run CREATE TABLE first, then ALTER TABLE migrations to add missing
  // columns, then CREATE INDEX. On existing DBs, CREATE TABLE IF NOT EXISTS is a
  // no-op so columns added via ALTER TABLE won't exist yet when indexes run.
  // Filter to only include statements that contain actual SQL keywords.
  // This filters out comment-only blocks that would cause "SQL code did not contain a statement" errors.
  const isValidSql = (s: string) => /\b(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|SELECT)\b/i.test(s);

  const statements = SCHEMA
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && isValidSql(s));

  const isCreateTable = (s: string) => /CREATE\s+TABLE/i.test(s);
  const tableStatements = statements.filter(isCreateTable);
  const indexStatements = statements.filter(s => !isCreateTable(s));

  // Phase 1: Create tables (IF NOT EXISTS — safe for existing DBs)
  for (const statement of tableStatements) {
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

  // Add unique index on (user_id, dashboard_id, name) for atomic upserts.
  // A name must be unique per user+dashboard regardless of type — having both a
  // secret and env_var with the same name causes ambiguous lookups everywhere.
  // First, deduplicate any pre-existing rows, keeping the most recently updated one.
  try {
    await db.prepare(`
      DELETE FROM user_secrets WHERE id NOT IN (
        SELECT id FROM (
          SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY user_id, dashboard_id, name
              ORDER BY updated_at DESC, created_at DESC, rowid DESC
            ) AS rn
          FROM user_secrets
        ) ranked
        WHERE rn = 1
      )
    `).run();
  } catch (error) {
    console.log('[schema] user_secrets dedup skipped:', error);
  }
  // Drop and recreate to ensure correct column set (IF NOT EXISTS won't fix
  // an existing index with the same name but different columns).
  try {
    await db.prepare(`DROP INDEX IF EXISTS idx_user_secrets_unique_name`).run();
  } catch {
    // Index doesn't exist — fine.
  }
  try {
    await db.prepare(`
      CREATE UNIQUE INDEX idx_user_secrets_unique_name ON user_secrets(user_id, dashboard_id, name)
    `).run();
  } catch {
    // Index already exists with correct definition.
  }

  // Migrate legacy _asr_* keys to standard env var names so ASR keys and
  // terminal secrets share the same row. Rename if standard name doesn't exist
  // yet; delete the legacy row if it does (standard name takes precedence).
  for (const [legacy, standard] of [
    ['_asr_openai', 'OPENAI_API_KEY'],
    ['_asr_assemblyai', 'ASSEMBLYAI_API_KEY'],
    ['_asr_deepgram', 'DEEPGRAM_API_KEY'],
  ]) {
    try {
      await db.prepare(`
        UPDATE user_secrets
        SET name = ?, description = ?, updated_at = datetime('now')
        WHERE name = ? AND dashboard_id = '_global' AND type = 'secret'
          AND NOT EXISTS (
            SELECT 1 FROM user_secrets s2
            WHERE s2.user_id = user_secrets.user_id
              AND s2.dashboard_id = '_global'
              AND s2.name = ?
          )
      `).bind(standard, `${legacy.replace('_asr_', '')} API key`, legacy, standard).run();

      // Delete any remaining legacy rows (user already had the standard name)
      await db.prepare(`
        DELETE FROM user_secrets WHERE name = ? AND dashboard_id = '_global' AND type = 'secret'
      `).bind(legacy).run();
    } catch (error) {
      console.log(`[schema] ASR key migration ${legacy} → ${standard} skipped:`, error);
    }
  }

  // Migrate dashboard-scoped secrets to global scope.
  // If a user already has a global secret with the same name, keep the global one
  // and delete the dashboard-scoped duplicate. Otherwise, move the row to _global.
  try {
    // First, update dashboard-scoped secrets to _global where no global duplicate exists
    await db.prepare(`
      UPDATE user_secrets
      SET dashboard_id = '_global', updated_at = datetime('now')
      WHERE dashboard_id != '_global'
        AND NOT EXISTS (
          SELECT 1 FROM user_secrets s2
          WHERE s2.user_id = user_secrets.user_id
            AND s2.dashboard_id = '_global'
            AND s2.name = user_secrets.name
        )
    `).run();

    // Then delete any remaining dashboard-scoped secrets (duplicates of global ones)
    const deleted = await db.prepare(`
      DELETE FROM user_secrets WHERE dashboard_id != '_global'
    `).run();
    if (deleted.meta?.changes && deleted.meta.changes > 0) {
      console.log(`[schema] Deleted ${deleted.meta.changes} dashboard-scoped secret duplicates (global copy exists)`);
    }
  } catch (error) {
    console.log('[schema] Dashboard-to-global secrets migration skipped:', error);
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

  // Add item_id column to terminal_integrations BEFORE migrateTerminalIntegrationProviders runs.
  // The migration copies this column, so it must exist first.
  try {
    await db.prepare(`
      ALTER TABLE terminal_integrations ADD COLUMN item_id TEXT
    `).run();
  } catch {
    // Column already exists.
  }

  await migrateTerminalIntegrationProviders(db);

  // Add partial unique index for terminal_integrations (one provider per terminal for active rows)
  try {
    await db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_integrations_unique_active
        ON terminal_integrations(terminal_id, provider)
        WHERE deleted_at IS NULL
    `).run();
  } catch {
    // Index already exists.
  }

  // Add viewport_json column to dashboard_templates for saving view position/zoom
  try {
    await db.prepare(`
      ALTER TABLE dashboard_templates ADD COLUMN viewport_json TEXT
    `).run();
  } catch {
    // Column already exists.
  }

  // Add cache_last_path column to github_mirrors for sync progress visibility
  try {
    await db.prepare(`
      ALTER TABLE github_mirrors ADD COLUMN cache_last_path TEXT
    `).run();
  } catch {
    // Column already exists.
  }

  // Add status column to dashboard_templates for approval workflow
  // Default 'approved' so existing templates remain visible
  try {
    await db.prepare(`
      ALTER TABLE dashboard_templates ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'
    `).run();
  } catch {
    // Column already exists.
  }

  // Index for status column (must come after ALTER TABLE that adds it)
  try {
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_templates_status ON dashboard_templates(status)
    `).run();
  } catch {
    // Index already exists.
  }

  // Create index on item_id column (added earlier before migrateTerminalIntegrationProviders)
  try {
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_terminal_integrations_item ON terminal_integrations(item_id)
    `).run();
  } catch {
    // Index already exists.
  }

  // Backfill item_id from sessions table for existing terminal_integrations
  try {
    await db.prepare(`
      UPDATE terminal_integrations SET item_id = (
        SELECT s.item_id FROM sessions s WHERE s.pty_id = terminal_integrations.terminal_id
        ORDER BY s.created_at DESC LIMIT 1
      ) WHERE item_id IS NULL
    `).run();
  } catch {
    // Backfill may fail if sessions are already cleaned up - not critical.
  }

  // Hybrid WhatsApp mode: Baileys bridge + Business API
  try {
    await db.prepare(`
      ALTER TABLE messaging_subscriptions ADD COLUMN hybrid_mode INTEGER NOT NULL DEFAULT 0
    `).run();
  } catch {
    // Column already exists.
  }
  try {
    await db.prepare(`
      ALTER TABLE messaging_subscriptions ADD COLUMN hybrid_handshake_at TEXT
    `).run();
  } catch {
    // Column already exists.
  }
  try {
    await db.prepare(`
      ALTER TABLE messaging_subscriptions ADD COLUMN user_phone TEXT
    `).run();
  } catch {
    // Column already exists.
  }
  // Link subscription to the exact OAuth integration used at creation time.
  // Without this, outbound send would ambiguously pick one integration when
  // a user has multiple workspaces/servers connected for the same provider.
  try {
    await db.prepare(`
      ALTER TABLE messaging_subscriptions ADD COLUMN user_integration_id TEXT REFERENCES user_integrations(id)
    `).run();
  } catch {
    // Column already exists.
  }

  // Per-dashboard Fly machine provisioning: track volume and machine state
  try {
    await db.prepare(`
      ALTER TABLE dashboard_sandboxes ADD COLUMN fly_volume_id TEXT NOT NULL DEFAULT ''
    `).run();
  } catch {
    // Column already exists.
  }
  try {
    await db.prepare(`
      ALTER TABLE dashboard_sandboxes ADD COLUMN machine_state TEXT NOT NULL DEFAULT 'unknown'
    `).run();
  } catch {
    // Column already exists.
  }  // Add stripe_trial_end column to user_subscriptions
  try {
    await db.prepare(`
      ALTER TABLE user_subscriptions ADD COLUMN stripe_trial_end TEXT
    `).run();
  } catch {
    // Column already exists.
  }

  // Add trial_started_at column to users — trial countdown starts on first login
  // after subscription system is deployed, not from original account creation
  try {
    await db.prepare(`
      ALTER TABLE users ADD COLUMN trial_started_at TEXT
    `).run();
  } catch {
    // Column already exists.
  }

  // Add last_active_at column to users for DAU/WAU/MAU tracking
  try {
    await db.prepare(`
      ALTER TABLE users ADD COLUMN last_active_at TEXT
    `).run();
  } catch {
    // Column already exists.
  }

  // Add agent_type column to sessions for agent usage tracking
  try {
    await db.prepare(`
      ALTER TABLE sessions ADD COLUMN agent_type TEXT
    `).run();
  } catch {
    // Column already exists.
  }

  // Warm machine pool for instant dashboard provisioning
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS warm_machines (
      machine_id TEXT PRIMARY KEY,
      volume_id TEXT NOT NULL,
      region TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();

  // Migrate schedules table: make recipe_id nullable, add edge-based schedule columns
  await migrateSchedulesTable(db);

  // Clean up legacy duplicate active allowlist rows before creating
  // the unique active-domain index.
  try {
    await db.prepare(`
      UPDATE egress_allowlist
      SET revoked_at = datetime('now')
      WHERE id IN (
        SELECT id FROM (
          SELECT
            id,
            ROW_NUMBER() OVER (
              PARTITION BY dashboard_id, domain
              ORDER BY created_at ASC, id ASC
            ) AS rn
          FROM egress_allowlist
          WHERE revoked_at IS NULL
        ) dedupe
        WHERE rn > 1
      )
    `).run();
  } catch (error) {
    console.log('[schema] egress allowlist dedupe skipped:', error);
  }

  // Phase 3: Create indexes (now all columns exist from ALTER TABLE migrations above)
  for (const statement of indexStatements) {
    await db.prepare(statement).run();
  }

  // Analytics indexes on ALTER TABLE columns (must be after ALTER TABLE migrations)
  try {
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active_at)
    `).run();
  } catch {
    // Index already exists.
  }
  try {
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_sessions_agent_type ON sessions(agent_type)
    `).run();
  } catch {
    // Index already exists.
  }
}

// All valid integration providers - add new providers here
const INTEGRATION_PROVIDERS = ['google_drive', 'github', 'gmail', 'google_calendar', 'google_contacts', 'google_sheets', 'google_forms', 'box', 'onedrive', 'slack', 'discord', 'telegram', 'whatsapp', 'teams', 'matrix', 'google_chat'] as const;

// All valid terminal integration providers (includes 'browser' which is not an OAuth provider)
const TERMINAL_INTEGRATION_PROVIDERS = [...INTEGRATION_PROVIDERS, 'browser'] as const;

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
  // Copy ALL columns that exist in both old and new tables to preserve data.
  // Critical: metadata contains team_id for Slack routing, scope/token_type/expires_at
  // are needed for OAuth refresh. Dropping these would break existing integrations.
  const oldColumns = await db.prepare(`PRAGMA table_info(user_integrations)`).all<{ name: string }>();
  const oldColumnNames = new Set((oldColumns.results || []).map(c => c.name));
  const allNewColumns = ['id', 'user_id', 'provider', 'access_token', 'refresh_token', 'scope', 'token_type', 'expires_at', 'metadata', 'created_at', 'updated_at'];
  const columnsToCopy = allNewColumns.filter(c => oldColumnNames.has(c));
  const columnList = columnsToCopy.join(', ');
  await db.prepare(`
    INSERT INTO user_integrations_new (${columnList})
    SELECT ${columnList} FROM user_integrations
  `).run();
  await db.prepare(`DROP TABLE user_integrations`).run();
  await db.prepare(`ALTER TABLE user_integrations_new RENAME TO user_integrations`).run();
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_integrations_user_provider ON user_integrations(user_id, provider)`).run();
  await db.prepare(`PRAGMA foreign_keys=ON`).run();
}

// Migrate schedules table to support edge-based schedules (recipe_id nullable, new columns)
async function migrateSchedulesTable(db: D1Database): Promise<void> {
  const tableInfo = await db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schedules'
  `).first<{ sql: string }>();

  if (!tableInfo?.sql) {
    return; // Table doesn't exist yet — CREATE TABLE will handle it
  }

  // Check if migration is needed (dashboard_item_id column missing)
  if (tableInfo.sql.includes('dashboard_item_id')) {
    return; // Already migrated
  }

  // Recreate table with nullable recipe_id and new columns
  await db.prepare(`PRAGMA foreign_keys=OFF`).run();
  await db.prepare(`DROP TABLE IF EXISTS schedules_new`).run();
  await db.prepare(`
    CREATE TABLE schedules_new (
      id TEXT PRIMARY KEY,
      recipe_id TEXT REFERENCES recipes(id) ON DELETE CASCADE,
      dashboard_id TEXT REFERENCES dashboards(id) ON DELETE CASCADE,
      dashboard_item_id TEXT,
      command TEXT,
      name TEXT NOT NULL,
      cron TEXT,
      event_trigger TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (recipe_id IS NOT NULL OR dashboard_item_id IS NOT NULL),
      CHECK (dashboard_item_id IS NULL OR dashboard_id IS NOT NULL)
    )
  `).run();
  await db.prepare(`
    INSERT INTO schedules_new
      (id, recipe_id, name, cron, event_trigger, enabled, last_run_at, next_run_at, created_at)
    SELECT id, recipe_id, name, cron, event_trigger, enabled, last_run_at, next_run_at, created_at
    FROM schedules
  `).run();
  await db.prepare(`DROP TABLE schedules`).run();
  await db.prepare(`ALTER TABLE schedules_new RENAME TO schedules`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_schedules_recipe ON schedules(recipe_id)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules(next_run_at)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_schedules_dashboard ON schedules(dashboard_id)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_schedules_item ON schedules(dashboard_item_id)`).run();
  await db.prepare(`PRAGMA foreign_keys=ON`).run();
}

// All valid dashboard item types - add new types here
const DASHBOARD_ITEM_TYPES = ['note', 'todo', 'terminal', 'link', 'browser', 'workspace', 'prompt', 'schedule', 'decision', 'gmail', 'calendar', 'contacts', 'sheets', 'forms', 'slack', 'discord', 'telegram', 'whatsapp', 'teams', 'matrix', 'google_chat'] as const;

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

async function migrateTerminalIntegrationProviders(db: D1Database): Promise<void> {
  const tableInfo = await db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'terminal_integrations'
  `).first<{ sql: string }>();

  if (!tableInfo?.sql) {
    console.log(`[migrateTerminalIntegrationProviders] No terminal_integrations table found, skipping`);
    return;
  }

  console.log(`[migrateTerminalIntegrationProviders] Current table SQL: ${tableInfo.sql.substring(0, 500)}`);

  // Check if all required providers are present in the provider enum CHECK
  const allProvidersPresent = TERMINAL_INTEGRATION_PROVIDERS.every(provider => tableInfo.sql.includes(`'${provider}'`));

  // Also check if the platform-credential exemption CHECK is up to date
  // (providers that don't need user_integration_id, e.g. browser + whatsapp)
  const hasCorrectExemption = tableInfo.sql.includes("provider IN ('browser', 'whatsapp') OR user_integration_id IS NOT NULL");

  console.log(`[migrateTerminalIntegrationProviders] allProvidersPresent=${allProvidersPresent}, hasCorrectExemption=${hasCorrectExemption}`);

  if (allProvidersPresent && hasCorrectExemption) {
    console.log(`[migrateTerminalIntegrationProviders] Table is up to date, skipping migration`);
    return;
  }

  // Recreate table with updated CHECK constraint
  console.log(`[migrateTerminalIntegrationProviders] Recreating terminal_integrations table. allProvidersPresent=${allProvidersPresent}, hasCorrectExemption=${hasCorrectExemption}`);
  const providerList = TERMINAL_INTEGRATION_PROVIDERS.map(p => `'${p}'`).join(', ');

  await db.prepare(`PRAGMA foreign_keys=OFF`).run();
  await db.prepare(`DROP TABLE IF EXISTS terminal_integrations_new`).run();
  await db.prepare(`
    CREATE TABLE terminal_integrations_new (
      id TEXT PRIMARY KEY,
      terminal_id TEXT NOT NULL,
      item_id TEXT,
      dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN (${providerList})),
      user_integration_id TEXT REFERENCES user_integrations(id),
      active_policy_id TEXT,
      account_email TEXT,
      account_label TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by TEXT NOT NULL REFERENCES users(id),
      CHECK (provider IN ('browser', 'whatsapp') OR user_integration_id IS NOT NULL)
    )
  `).run();
  await db.prepare(`
    INSERT INTO terminal_integrations_new
      (id, terminal_id, item_id, dashboard_id, user_id, provider, user_integration_id, active_policy_id, account_email, account_label, deleted_at, created_at, updated_at, created_by)
    SELECT id, terminal_id, item_id, dashboard_id, user_id, provider, user_integration_id, active_policy_id, account_email, account_label, deleted_at, created_at, updated_at, created_by
    FROM terminal_integrations
  `).run();
  await db.prepare(`DROP TABLE terminal_integrations`).run();
  await db.prepare(`ALTER TABLE terminal_integrations_new RENAME TO terminal_integrations`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_terminal_integrations_terminal ON terminal_integrations(terminal_id)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_terminal_integrations_dashboard ON terminal_integrations(dashboard_id)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_terminal_integrations_user ON terminal_integrations(user_id)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_terminal_integrations_item ON terminal_integrations(item_id)`).run();
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_integrations_unique_active ON terminal_integrations(terminal_id, provider) WHERE deleted_at IS NULL`).run();
  await db.prepare(`PRAGMA foreign_keys=ON`).run();
}
