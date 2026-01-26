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
  type TEXT NOT NULL CHECK (type IN ('note', 'todo', 'terminal', 'link', 'browser', 'workspace', 'prompt', 'schedule')),
  content TEXT NOT NULL DEFAULT '',
  position_x INTEGER NOT NULL DEFAULT 0,
  position_y INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 200,
  height INTEGER NOT NULL DEFAULT 150,
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

-- User secrets (environment variables)
CREATE TABLE IF NOT EXISTS user_secrets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dashboard_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
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
  provider TEXT NOT NULL CHECK (provider IN ('google_drive', 'github')),
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

  await migrateWorkspaceItemType(db);
}

async function migrateWorkspaceItemType(db: D1Database): Promise<void> {
  const tableInfo = await db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dashboard_items'
  `).first<{ sql: string }>();

  if (!tableInfo?.sql || tableInfo.sql.includes("'workspace'")) {
    return;
  }

  await db.prepare(`PRAGMA foreign_keys=OFF`).run();
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS dashboard_items_new (
      id TEXT PRIMARY KEY,
      dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('note', 'todo', 'terminal', 'link', 'browser', 'workspace', 'prompt', 'schedule')),
      content TEXT NOT NULL DEFAULT '',
      position_x INTEGER NOT NULL DEFAULT 0,
      position_y INTEGER NOT NULL DEFAULT 0,
      width INTEGER NOT NULL DEFAULT 200,
      height INTEGER NOT NULL DEFAULT 150,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
  await db.prepare(`
    INSERT INTO dashboard_items_new
      (id, dashboard_id, type, content, position_x, position_y, width, height, created_at, updated_at)
    SELECT id, dashboard_id, type, content, position_x, position_y, width, height, created_at, updated_at
    FROM dashboard_items
  `).run();
  await db.prepare(`DROP TABLE dashboard_items`).run();
  await db.prepare(`ALTER TABLE dashboard_items_new RENAME TO dashboard_items`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_items_dashboard ON dashboard_items(dashboard_id)`).run();
  await db.prepare(`PRAGMA foreign_keys=ON`).run();
}
