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

-- Dashboard items (notes, todos, terminal attachments, links)
CREATE TABLE IF NOT EXISTS dashboard_items (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('note', 'todo', 'terminal', 'link')),
  content TEXT NOT NULL DEFAULT '',
  position_x INTEGER NOT NULL DEFAULT 0,
  position_y INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 200,
  height INTEGER NOT NULL DEFAULT 150,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_dashboard ON dashboard_items(dashboard_id);

-- Sessions (map dashboard terminals to sandbox sessions)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES dashboard_items(id) ON DELETE CASCADE,
  sandbox_session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('creating', 'active', 'stopped', 'error')),
  region TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  stopped_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_dashboard ON sessions(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_sessions_item ON sessions(item_id);

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
}
