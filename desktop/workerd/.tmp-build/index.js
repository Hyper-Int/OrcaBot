var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/auth/cf-access.ts
var cachedKeys = null;
var keysCachedAt = 0;
var KEYS_CACHE_TTL = 24 * 60 * 60 * 1e3;
async function getAccessKeys(teamDomain) {
  const now = Date.now();
  if (cachedKeys && now - keysCachedAt < KEYS_CACHE_TTL) {
    return cachedKeys;
  }
  const certsUrl = `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`;
  const response = await fetch(certsUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch CF Access keys: ${response.status}`);
  }
  cachedKeys = await response.json();
  keysCachedAt = now;
  return cachedKeys;
}
__name(getAccessKeys, "getAccessKeys");
function base64UrlDecode(str) {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
__name(base64UrlDecode, "base64UrlDecode");
function parseJwt(token) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format");
  }
  const headerJson = new TextDecoder().decode(base64UrlDecode(parts[0]));
  const payloadJson = new TextDecoder().decode(base64UrlDecode(parts[1]));
  return {
    header: JSON.parse(headerJson),
    payload: JSON.parse(payloadJson)
  };
}
__name(parseJwt, "parseJwt");
async function verifyJwtSignature(token, keys) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format");
  }
  const { header, payload } = parseJwt(token);
  const jwk = keys.keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    throw new Error(`No matching key found for kid: ${header.kid}`);
  }
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = base64UrlDecode(parts[2]);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    signature,
    signedData
  );
  if (!valid) {
    throw new Error("Invalid JWT signature");
  }
  return payload;
}
__name(verifyJwtSignature, "verifyJwtSignature");
async function validateCfAccessT\u043Eken(request, env) {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const expectedAud = env.CF_ACCESS_AUD;
  if (!teamDomain || !expectedAud) {
    console.error("CF Access not configured: missing CF_ACCESS_TEAM_DOMAIN or CF_ACCESS_AUD");
    return null;
  }
  const jwt = request.headers.get("CF-Access-JWT-Assertion");
  if (!jwt) {
    return null;
  }
  try {
    const keys = await getAccessKeys(teamDomain);
    const payload = await verifyJwtSignature(jwt, keys);
    if (!payload.aud.includes(expectedAud)) {
      console.error("JWT audience mismatch");
      return null;
    }
    const now = Math.floor(Date.now() / 1e3);
    if (payload.exp < now) {
      console.error("JWT expired");
      return null;
    }
    return {
      email: payload.email,
      sub: payload.sub,
      name: payload.name
    };
  } catch (error) {
    console.error("CF Access JWT validation failed:", error);
    return null;
  }
}
__name(validateCfAccessT\u043Eken, "validateCfAccessT\u043Eken");
function cfAccessUserIdFr\u043EmSub(sub) {
  return `cfa-${sub}`;
}
__name(cfAccessUserIdFr\u043EmSub, "cfAccessUserIdFr\u043EmSub");

// src/auth/sessions.ts
var SESSION_COOKIE_NAME = "orcabot_session";
var SESSION_MAX_AGE_DAYS = 30;
function parseCookies(header) {
  const cookies = /* @__PURE__ */ new Map();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (!name)
      continue;
    const value = valueParts.join("=");
    cookies.set(name, value);
  }
  return cookies;
}
__name(parseCookies, "parseCookies");
function readSessionId(request) {
  const cookies = parseCookies(request.headers.get("Cookie"));
  return cookies.get(SESSION_COOKIE_NAME) || null;
}
__name(readSessionId, "readSessionId");
async function getUserForSession(request, env) {
  const sessionId = readSessionId(request);
  if (!sessionId) {
    return null;
  }
  const record = await env.DB.prepare(`
    SELECT
      users.id as id,
      users.email as email,
      users.name as name,
      users.created_at as created_at
    FROM user_sessions
    JOIN users ON users.id = user_sessions.user_id
    WHERE user_sessions.id = ? AND user_sessions.expires_at > datetime('now')
  `).bind(sessionId).first();
  if (!record) {
    return null;
  }
  return {
    id: record.id,
    email: record.email,
    name: record.name,
    createdAt: record.created_at
  };
}
__name(getUserForSession, "getUserForSession");
async function createUserSession(env, userId) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(
    Date.now() + SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1e3
  ).toISOString();
  await env.DB.prepare(`
    INSERT INTO user_sessions (id, user_id, expires_at)
    VALUES (?, ?, ?)
  `).bind(id, userId, expiresAt).run();
  return { id, expiresAt };
}
__name(createUserSession, "createUserSession");
function buildSessionCookie(request, sessionId, expiresAt) {
  const expiresDate = new Date(expiresAt);
  const maxAgeSeconds = Math.max(
    0,
    Math.floor((expiresDate.getTime() - Date.now()) / 1e3)
  );
  const isSecure = new URL(request.url).protocol === "https:";
  const sameSite = isSecure ? "None" : "Lax";
  const parts = [
    `${SESSION_COOKIE_NAME}=${sessionId}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    `SameSite=${sameSite}`
  ];
  if (isSecure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}
__name(buildSessionCookie, "buildSessionCookie");
async function deleteUserSession(env, sessionId) {
  await env.DB.prepare(`
    DELETE FROM user_sessions WHERE id = ?
  `).bind(sessionId).run();
}
__name(deleteUserSession, "deleteUserSession");
function buildClearSessionCookie(request) {
  const isSecure = new URL(request.url).protocol === "https:";
  const sameSite = isSecure ? "None" : "Lax";
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    `SameSite=${sameSite}`
  ];
  if (isSecure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}
__name(buildClearSessionCookie, "buildClearSessionCookie");

// src/auth/middleware.ts
async function authenticate(request, env) {
  const sessionUser = await getUserForSession(request, env);
  if (sessionUser) {
    return { user: sessionUser, isAuthenticated: true };
  }
  if (env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD) {
    return authenticateWithCfAcc\u0435ss(request, env);
  }
  const devAuthEnabled = env.DEV_AUTH_ENABLED === "true";
  if (devAuthEnabled) {
    return authenticateDevM\u043Ede(request, env);
  }
  return { user: null, isAuthenticated: false };
}
__name(authenticate, "authenticate");
async function authenticateWithCfAcc\u0435ss(request, env) {
  const identity = await validateCfAccessT\u043Eken(request, env);
  if (!identity) {
    return { user: null, isAuthenticated: false };
  }
  const userId = cfAccessUserIdFr\u043EmSub(identity.sub);
  const dbUser = await env.DB.prepare(`
    SELECT * FROM users WHERE id = ?
  `).bind(userId).first();
  let user = dbUser ? {
    id: dbUser.id,
    email: dbUser.email,
    name: dbUser.name,
    createdAt: dbUser.created_at
  } : null;
  if (!user) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await env.DB.prepare(`
      INSERT INTO users (id, email, name, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(userId, identity.email, identity.name || identity.email.split("@")[0], now).run();
    user = {
      id: userId,
      email: identity.email,
      name: identity.name || identity.email.split("@")[0],
      createdAt: now
    };
  }
  return {
    user,
    isAuthenticated: true
  };
}
__name(authenticateWithCfAcc\u0435ss, "authenticateWithCfAcc\u0435ss");
async function authenticateDevM\u043Ede(request, env) {
  let userId = request.headers.get("X-User-ID");
  let userEmail = request.headers.get("X-User-Email");
  let userName = request.headers.get("X-User-Name");
  if (!userId) {
    const url = new URL(request.url);
    userId = url.searchParams.get("user_id");
    userEmail = url.searchParams.get("user_email");
    userName = url.searchParams.get("user_name");
  }
  if (!userId) {
    return { user: null, isAuthenticated: false };
  }
  const dbUser = await env.DB.prepare(`
    SELECT * FROM users WHERE id = ?
  `).bind(userId).first();
  let user = dbUser ? {
    id: dbUser.id,
    email: dbUser.email,
    name: dbUser.name,
    createdAt: dbUser.created_at
  } : null;
  if (!user && userEmail) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await env.DB.prepare(`
      INSERT INTO users (id, email, name, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(userId, userEmail, userName || "Anonymous", now).run();
    user = {
      id: userId,
      email: userEmail,
      name: userName || "Anonymous",
      createdAt: now
    };
  }
  if (!user) {
    return { user: null, isAuthenticated: false };
  }
  return {
    user,
    isAuthenticated: true
  };
}
__name(authenticateDevM\u043Ede, "authenticateDevM\u043Ede");
function requireAuth(ctx) {
  if (!ctx.isAuthenticated || !ctx.user) {
    return Response.json(
      { error: "E79401: Authentication required" },
      { status: 401 }
    );
  }
  return null;
}
__name(requireAuth, "requireAuth");
function requireInternalAuth(request, env) {
  const token = request.headers.get("X-Internal-Token");
  if (!env.INTERNAL_API_TOKEN) {
    return Response.json(
      { error: "E79402: Internal API not configured" },
      { status: 503 }
    );
  }
  if (!token || token !== env.INTERNAL_API_TOKEN) {
    return Response.json(
      { error: "E79403: Invalid internal token" },
      { status: 401 }
    );
  }
  return null;
}
__name(requireInternalAuth, "requireInternalAuth");

// src/ratelimit/middleware.ts
function buildRateLimitResponse(message) {
  return new Response(
    JSON.stringify({
      error: "E79601: Too many requests",
      message
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "60"
      }
    }
  );
}
__name(buildRateLimitResponse, "buildRateLimitResponse");
async function applyRateLimit(limiter, key, message) {
  try {
    const result = await limiter.limit({ key });
    if (!result.success) {
      return {
        allowed: false,
        response: buildRateLimitResponse(message)
      };
    }
    return { allowed: true };
  } catch (error) {
    console.error("Rate limiting error:", error);
    return { allowed: true };
  }
}
__name(applyRateLimit, "applyRateLimit");
async function checkRateLimitIp(request, env) {
  if (!env.RATE_LIMITER) {
    return { allowed: true };
  }
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return applyRateLimit(
    env.RATE_LIMITER,
    `ip:${ip}`,
    "Too many unauthenticated requests from your IP."
  );
}
__name(checkRateLimitIp, "checkRateLimitIp");
async function checkRateLimitUser(userId, env) {
  const limiter = env.RATE_LIMITER_AUTH || env.RATE_LIMITER;
  if (!limiter) {
    return { allowed: true };
  }
  return applyRateLimit(
    limiter,
    `user:${userId}`,
    "Rate limit exceeded. Please slow down."
  );
}
__name(checkRateLimitUser, "checkRateLimitUser");

// src/db/schema.ts
var SCHEMA = `
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

-- Dashboard items (notes, todos, terminal attachments, links, browsers)
CREATE TABLE IF NOT EXISTS dashboard_items (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('note', 'todo', 'terminal', 'link', 'browser', 'workspace')),
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
`;
async function initializeDatabase(db) {
  const statements = SCHEMA.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
  for (const statement of statements) {
    await db.prepare(statement).run();
  }
  try {
    await db.prepare(`
      ALTER TABLE sessions ADD COLUMN sandbox_machine_id TEXT NOT NULL DEFAULT ''
    `).run();
  } catch {
  }
  try {
    await db.prepare(`
      ALTER TABLE oauth_states ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'
    `).run();
  } catch {
  }
  try {
    await db.prepare(`
      ALTER TABLE user_secrets ADD COLUMN dashboard_id TEXT NOT NULL DEFAULT ''
    `).run();
  } catch {
  }
  await migrateWorkspaceItemType(db);
}
__name(initializeDatabase, "initializeDatabase");
async function migrateWorkspaceItemType(db) {
  const tableInfo = await db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dashboard_items'
  `).first();
  if (!tableInfo?.sql || tableInfo.sql.includes("'workspace'")) {
    return;
  }
  await db.prepare(`PRAGMA foreign_keys=OFF`).run();
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS dashboard_items_new (
      id TEXT PRIMARY KEY,
      dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('note', 'todo', 'terminal', 'link', 'browser', 'workspace')),
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
__name(migrateWorkspaceItemType, "migrateWorkspaceItemType");

// src/db/remote.ts
var didLogRemoteD1 = false;
var RemoteD1Client = class {
  baseUrl;
  fetcher;
  debug;
  constructor(baseUrl, fetcher, debug = false) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetcher = fetcher;
    this.debug = debug;
  }
  async query(payload) {
    return this.request("/query", payload);
  }
  async batch(payload) {
    return this.request("/batch", { statements: payload });
  }
  async exec(payload) {
    return this.request("/exec", payload);
  }
  async request(path, body) {
    const url = `${this.baseUrl}${path}`;
    if (this.debug) {
      console.log(`[d1-shim] POST ${url}`, {
        useFetcher: Boolean(this.fetcher)
      });
    }
    const request = new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const response = this.fetcher ? await this.fetcher.fetch(request) : await fetch(request);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`D1 shim error ${response.status}: ${text}`);
    }
    return response.json();
  }
};
__name(RemoteD1Client, "RemoteD1Client");
var RemoteD1PreparedStatement = class {
  constructor(client, sql) {
    this.client = client;
    this.sql = sql;
  }
  bindings = [];
  bind(...values) {
    this.bindings = values;
    return this;
  }
  async first(colName) {
    const result = await this.all();
    const row = result.results[0] ?? null;
    if (colName && row) {
      return row[colName];
    }
    return row;
  }
  async all() {
    return this.client.query({ sql: this.sql, params: this.bindings });
  }
  async run() {
    return this.all();
  }
  async raw() {
    const result = await this.all();
    return result.results.map((row) => Object.values(row));
  }
  toPayload() {
    return { sql: this.sql, params: this.bindings };
  }
};
__name(RemoteD1PreparedStatement, "RemoteD1PreparedStatement");
function isRemoteStatement(statement) {
  return typeof statement.toPayload === "function";
}
__name(isRemoteStatement, "isRemoteStatement");
var RemoteD1Database = class {
  client;
  constructor(baseUrl, fetcher, debug = false) {
    this.client = new RemoteD1Client(baseUrl, fetcher, debug);
  }
  prepare(query) {
    return new RemoteD1PreparedStatement(this.client, query);
  }
  async batch(statements) {
    const payload = statements.map((statement) => {
      if (!isRemoteStatement(statement)) {
        throw new Error("D1 shim batch requires statements from the same database instance.");
      }
      return statement.toPayload();
    });
    return this.client.batch(payload);
  }
  exec(query) {
    return this.client.exec({ sql: query });
  }
  dump() {
    throw new Error("D1 dump not supported in desktop mode.");
  }
};
__name(RemoteD1Database, "RemoteD1Database");
function ensureDb(env) {
  const existing = env.DB;
  if (existing) {
    return env;
  }
  if (!env.D1_HTTP_URL) {
    throw new Error("D1 binding missing and D1_HTTP_URL not set.");
  }
  if (env.D1_SHIM_DEBUG === "true" && !didLogRemoteD1) {
    console.log("[d1-shim] using remote D1", {
      url: env.D1_HTTP_URL,
      hasFetcher: Boolean(env.D1_SHIM)
    });
    didLogRemoteD1 = true;
  }
  return {
    ...env,
    DB: new RemoteD1Database(
      env.D1_HTTP_URL,
      env.D1_SHIM,
      env.D1_SHIM_DEBUG === "trace"
    )
  };
}
__name(ensureDb, "ensureDb");

// src/storage/drive-cache.ts
var DesktopFeatureDisabledError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "DesktopFeatureDisabledError";
  }
};
__name(DesktopFeatureDisabledError, "DesktopFeatureDisabledError");
var disabledError = new DesktopFeatureDisabledError(
  "Drive cache is not available in desktop mode."
);
var disabledDriveCache = {
  async get() {
    throw disabledError;
  },
  async put() {
    throw disabledError;
  },
  async delete() {
    throw disabledError;
  },
  async head() {
    throw disabledError;
  },
  async createMultipartUpload() {
    throw disabledError;
  }
};
function ensureDriveCache(env) {
  if (env.DRIVE_CACHE) {
    return env;
  }
  return {
    ...env,
    DRIVE_CACHE: disabledDriveCache
  };
}
__name(ensureDriveCache, "ensureDriveCache");
function isDesktopFeatureDisabledError(error) {
  return error instanceof DesktopFeatureDisabledError || error instanceof Error && error.name === "DesktopFeatureDisabledError";
}
__name(isDesktopFeatureDisabledError, "isDesktopFeatureDisabledError");

// src/dashboards/handler.ts
function generateId() {
  return crypto.randomUUID();
}
__name(generateId, "generateId");
function f\u043ErmatDashb\u043Eard(row) {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
__name(f\u043ErmatDashb\u043Eard, "f\u043ErmatDashb\u043Eard");
function formatItem(row) {
  return {
    id: row.id,
    dashboardId: row.dashboard_id,
    type: row.type,
    content: row.content,
    position: {
      x: row.position_x,
      y: row.position_y
    },
    size: {
      width: row.width,
      height: row.height
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
__name(formatItem, "formatItem");
function f\u043ErmatSessi\u043En(row) {
  return {
    id: row.id,
    dashboardId: row.dashboard_id,
    itemId: row.item_id,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    sandboxSessionId: row.sandbox_session_id,
    sandboxMachineId: row.sandbox_machine_id,
    ptyId: row.pty_id,
    status: row.status,
    region: row.region,
    createdAt: row.created_at,
    stoppedAt: row.stopped_at
  };
}
__name(f\u043ErmatSessi\u043En, "f\u043ErmatSessi\u043En");
function formatEdge(row) {
  return {
    id: row.id,
    dashboardId: row.dashboard_id,
    sourceItemId: row.source_item_id,
    targetItemId: row.target_item_id,
    sourceHandle: row.source_handle ?? void 0,
    targetHandle: row.target_handle ?? void 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
__name(formatEdge, "formatEdge");
async function getDashb\u043EardRole(env, dashboardId, userId) {
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first();
  return access?.role ?? null;
}
__name(getDashb\u043EardRole, "getDashb\u043EardRole");
function hasDashb\u043EardRole(role, allowed) {
  return role !== null && allowed.includes(role);
}
__name(hasDashb\u043EardRole, "hasDashb\u043EardRole");
async function listDashb\u043Eards(env, userId) {
  const result = await env.DB.prepare(`
    SELECT d.* FROM dashboards d
    JOIN dashboard_members dm ON d.id = dm.dashboard_id
    WHERE dm.user_id = ?
    ORDER BY d.updated_at DESC
  `).bind(userId).all();
  const dashboards = result.results.map(f\u043ErmatDashb\u043Eard);
  return Response.json({ dashboards });
}
__name(listDashb\u043Eards, "listDashb\u043Eards");
async function getDashb\u043Eard(env, dashboardId, userId) {
  const role = await getDashb\u043EardRole(env, dashboardId, userId);
  if (!role) {
    return Response.json({ error: "E79301: Not found or no access" }, { status: 404 });
  }
  const dashboardRow = await env.DB.prepare(`
    SELECT * FROM dashboards WHERE id = ?
  `).bind(dashboardId).first();
  if (!dashboardRow) {
    return Response.json({ error: "E79302: Dashboard not found" }, { status: 404 });
  }
  const itemRows = await env.DB.prepare(`
    SELECT * FROM dashboard_items WHERE dashboard_id = ?
  `).bind(dashboardId).all();
  const sessionRows = await env.DB.prepare(`
    SELECT * FROM sessions WHERE dashboard_id = ? AND status != 'stopped'
  `).bind(dashboardId).all();
  const edgeRows = await env.DB.prepare(`
    SELECT * FROM dashboard_edges WHERE dashboard_id = ?
  `).bind(dashboardId).all();
  return Response.json({
    dashboard: f\u043ErmatDashb\u043Eard(dashboardRow),
    items: itemRows.results.map(formatItem),
    sessions: sessionRows.results.map(f\u043ErmatSessi\u043En),
    edges: edgeRows.results.map(formatEdge),
    role
  });
}
__name(getDashb\u043Eard, "getDashb\u043Eard");
async function createDashb\u043Eard(env, userId, data) {
  const id = generateId();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare(`
    INSERT INTO dashboards (id, name, owner_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(id, data.name, userId, now, now).run();
  await env.DB.prepare(`
    INSERT INTO dashboard_members (dashboard_id, user_id, role, added_at)
    VALUES (?, ?, 'owner', ?)
  `).bind(id, userId, now).run();
  const dashboard = {
    id,
    name: data.name,
    ownerId: userId,
    createdAt: now,
    updatedAt: now
  };
  return Response.json({ dashboard }, { status: 201 });
}
__name(createDashb\u043Eard, "createDashb\u043Eard");
async function updateDashb\u043Eard(env, dashboardId, userId, data) {
  const role = await getDashb\u043EardRole(env, dashboardId, userId);
  if (!hasDashb\u043EardRole(role, ["owner", "editor"])) {
    return Response.json({ error: "E79303: Not found or no edit access" }, { status: 404 });
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  if (data.name) {
    await env.DB.prepare(`
      UPDATE dashboards SET name = ?, updated_at = ? WHERE id = ?
    `).bind(data.name, now, dashboardId).run();
  }
  const dashboardRow = await env.DB.prepare(`
    SELECT * FROM dashboards WHERE id = ?
  `).bind(dashboardId).first();
  return Response.json({ dashboard: f\u043ErmatDashb\u043Eard(dashboardRow) });
}
__name(updateDashb\u043Eard, "updateDashb\u043Eard");
async function deleteDashb\u043Eard(env, dashboardId, userId) {
  const role = await getDashb\u043EardRole(env, dashboardId, userId);
  if (!hasDashb\u043EardRole(role, ["owner"])) {
    return Response.json({ error: "E79304: Not found or not owner" }, { status: 404 });
  }
  await env.DB.prepare(`DELETE FROM user_secrets WHERE dashboard_id = ?`).bind(dashboardId).run();
  await env.DB.prepare(`DELETE FROM dashboards WHERE id = ?`).bind(dashboardId).run();
  return new Response(null, { status: 204 });
}
__name(deleteDashb\u043Eard, "deleteDashb\u043Eard");
async function upsertItem(env, dashboardId, userId, item) {
  const role = await getDashb\u043EardRole(env, dashboardId, userId);
  if (!hasDashb\u043EardRole(role, ["owner", "editor"])) {
    return Response.json({ error: "E79303: Not found or no edit access" }, { status: 404 });
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const id = item.id || generateId();
  const existing = await env.DB.prepare(`
    SELECT id FROM dashboard_items WHERE id = ? AND dashboard_id = ?
  `).bind(id, dashboardId).first();
  if (existing) {
    await env.DB.prepare(`
      UPDATE dashboard_items SET
        content = COALESCE(?, content),
        position_x = COALESCE(?, position_x),
        position_y = COALESCE(?, position_y),
        width = COALESCE(?, width),
        height = COALESCE(?, height),
        updated_at = ?
      WHERE id = ?
    `).bind(
      item.content !== void 0 ? item.content : null,
      item.position?.x ?? null,
      item.position?.y ?? null,
      item.size?.width ?? null,
      item.size?.height ?? null,
      now,
      id
    ).run();
  } else {
    await env.DB.prepare(`
      INSERT INTO dashboard_items (id, dashboard_id, type, content, position_x, position_y, width, height, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      dashboardId,
      item.type || "note",
      item.content || "",
      item.position?.x ?? 0,
      item.position?.y ?? 0,
      item.size?.width ?? 200,
      item.size?.height ?? 150,
      now,
      now
    ).run();
  }
  await env.DB.prepare(`
    UPDATE dashboards SET updated_at = ? WHERE id = ?
  `).bind(now, dashboardId).run();
  const doId = env.DASHBOARD.idFromName(dashboardId);
  const stub = env.DASHBOARD.get(doId);
  const savedItem = await env.DB.prepare(`
    SELECT * FROM dashboard_items WHERE id = ?
  `).bind(id).first();
  const formattedItem = formatItem(savedItem);
  await stub.fetch(new Request("http://do/item", {
    method: existing ? "PUT" : "POST",
    body: JSON.stringify(formattedItem)
  }));
  return Response.json({ item: formattedItem }, { status: existing ? 200 : 201 });
}
__name(upsertItem, "upsertItem");
async function deleteItem(env, dashboardId, itemId, userId) {
  const role = await getDashb\u043EardRole(env, dashboardId, userId);
  if (!hasDashb\u043EardRole(role, ["owner", "editor"])) {
    return Response.json({ error: "E79303: Not found or no edit access" }, { status: 404 });
  }
  const edgeRows = await env.DB.prepare(`
    SELECT id FROM dashboard_edges
    WHERE dashboard_id = ? AND (source_item_id = ? OR target_item_id = ?)
  `).bind(dashboardId, itemId, itemId).all();
  await env.DB.prepare(`
    DELETE FROM dashboard_items WHERE id = ? AND dashboard_id = ?
  `).bind(itemId, dashboardId).run();
  const doId = env.DASHBOARD.idFromName(dashboardId);
  const stub = env.DASHBOARD.get(doId);
  await stub.fetch(new Request("http://do/item", {
    method: "DELETE",
    body: JSON.stringify({ itemId })
  }));
  for (const edge of edgeRows.results) {
    await stub.fetch(new Request("http://do/edge", {
      method: "DELETE",
      body: JSON.stringify({ edgeId: edge.id })
    }));
  }
  return new Response(null, { status: 204 });
}
__name(deleteItem, "deleteItem");
async function createEdge(env, dashboardId, userId, edge) {
  const role = await getDashb\u043EardRole(env, dashboardId, userId);
  if (!hasDashb\u043EardRole(role, ["owner", "editor"])) {
    return Response.json({ error: "E79303: Not found or no edit access" }, { status: 404 });
  }
  const existingEdge = await env.DB.prepare(`
    SELECT * FROM dashboard_edges
    WHERE dashboard_id = ?
      AND source_item_id = ?
      AND target_item_id = ?
      AND COALESCE(source_handle, '') = COALESCE(?, '')
      AND COALESCE(target_handle, '') = COALESCE(?, '')
  `).bind(
    dashboardId,
    edge.sourceItemId,
    edge.targetItemId,
    edge.sourceHandle ?? "",
    edge.targetHandle ?? ""
  ).first();
  if (existingEdge) {
    return Response.json({ edge: formatEdge(existingEdge) }, { status: 200 });
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const id = generateId();
  await env.DB.prepare(`
    INSERT INTO dashboard_edges (id, dashboard_id, source_item_id, target_item_id, source_handle, target_handle, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    dashboardId,
    edge.sourceItemId,
    edge.targetItemId,
    edge.sourceHandle ?? null,
    edge.targetHandle ?? null,
    now,
    now
  ).run();
  const savedEdge = await env.DB.prepare(`
    SELECT * FROM dashboard_edges WHERE id = ?
  `).bind(id).first();
  const formattedEdge = formatEdge(savedEdge);
  const doId = env.DASHBOARD.idFromName(dashboardId);
  const stub = env.DASHBOARD.get(doId);
  await stub.fetch(new Request("http://do/edge", {
    method: "POST",
    body: JSON.stringify(formattedEdge)
  }));
  return Response.json({ edge: formattedEdge }, { status: 201 });
}
__name(createEdge, "createEdge");
async function deleteEdge(env, dashboardId, edgeId, userId) {
  const role = await getDashb\u043EardRole(env, dashboardId, userId);
  if (!hasDashb\u043EardRole(role, ["owner", "editor"])) {
    return Response.json({ error: "E79303: Not found or no edit access" }, { status: 404 });
  }
  await env.DB.prepare(`
    DELETE FROM dashboard_edges WHERE id = ? AND dashboard_id = ?
  `).bind(edgeId, dashboardId).run();
  const doId = env.DASHBOARD.idFromName(dashboardId);
  const stub = env.DASHBOARD.get(doId);
  await stub.fetch(new Request("http://do/edge", {
    method: "DELETE",
    body: JSON.stringify({ edgeId })
  }));
  return new Response(null, { status: 204 });
}
__name(deleteEdge, "deleteEdge");
async function c\u043EnnectWebS\u043Ecket(env, dashboardId, userId, userName, request) {
  const role = await getDashb\u043EardRole(env, dashboardId, userId);
  if (!role) {
    return Response.json({ error: "E79301: Not found or no access" }, { status: 404 });
  }
  const doId = env.DASHBOARD.idFromName(dashboardId);
  const stub = env.DASHBOARD.get(doId);
  const wsUrl = new URL(request.url);
  wsUrl.pathname = "/ws";
  wsUrl.searchParams.set("user_id", userId);
  wsUrl.searchParams.set("user_name", userName);
  return stub.fetch(new Request(wsUrl.toString(), request));
}
__name(c\u043EnnectWebS\u043Ecket, "c\u043EnnectWebS\u043Ecket");

// src/sandbox/client.ts
var SandboxClient = class {
  baseUrl;
  token;
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token || "";
  }
  // Health check
  async health() {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }
  authHeaders() {
    if (!this.token) {
      return {};
    }
    return { "X-Internal-Token": this.token };
  }
  // Session management
  async createSessi\u043En() {
    const res = await fetch(`${this.baseUrl}/sessions`, {
      method: "POST",
      headers: this.authHeaders()
    });
    if (!res.ok) {
      throw new Error(`Failed to create session: ${res.status}`);
    }
    const data = await res.json();
    return {
      id: data.id,
      machineId: data.machine_id
    };
  }
  async deleteSession(sessionId, machineId) {
    const headers = new Headers(this.authHeaders());
    if (machineId) {
      headers.set("X-Sandbox-Machine-ID", machineId);
    }
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}`, {
      method: "DELETE",
      headers
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete session: ${res.status}`);
    }
  }
  // Environment management
  async updateEnv(sessionId, payload, machineId) {
    const headers = new Headers(this.authHeaders());
    headers.set("Content-Type", "application/json");
    if (machineId) {
      headers.set("X-Sandbox-Machine-ID", machineId);
    }
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/env`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      throw new Error(`Failed to update env: ${res.status}`);
    }
  }
  // PTY management
  async createPty(sessionId, creatorId, command, machineId) {
    const shouldSendBody = Boolean(creatorId || command);
    const body = shouldSendBody ? JSON.stringify({
      creator_id: creatorId,
      command
    }) : void 0;
    const headers = new Headers(this.authHeaders());
    if (machineId) {
      headers.set("X-Sandbox-Machine-ID", machineId);
    }
    if (shouldSendBody) {
      headers.set("Content-Type", "application/json");
    }
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/ptys`, {
      method: "POST",
      headers,
      body
    });
    if (!res.ok) {
      throw new Error(`Failed to create PTY: ${res.status}`);
    }
    return res.json();
  }
  async deletePty(sessionId, ptyId) {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/ptys/${ptyId}`, {
      method: "DELETE",
      headers: this.authHeaders()
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete PTY: ${res.status}`);
    }
  }
};
__name(SandboxClient, "SandboxClient");

// src/sessions/handler.ts
function generateId2() {
  return crypto.randomUUID();
}
__name(generateId2, "generateId");
function parseB\u043E\u043EtC\u043Emmand(content) {
  if (typeof content !== "string") {
    return "";
  }
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) {
    return "";
  }
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed.bootCommand === "string" ? parsed.bootCommand : "";
  } catch {
    return "";
  }
}
__name(parseB\u043E\u043EtC\u043Emmand, "parseB\u043E\u043EtC\u043Emmand");
function f\u043ErmatDashb\u043EardItem(row) {
  return {
    id: row.id,
    dashboardId: row.dashboard_id,
    type: row.type,
    content: row.content,
    position: {
      x: row.position_x,
      y: row.position_y
    },
    size: {
      width: row.width,
      height: row.height
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
__name(f\u043ErmatDashb\u043EardItem, "f\u043ErmatDashb\u043EardItem");
async function getDashb\u043EardSandb\u043Ex(env, dashboardId) {
  return env.DB.prepare(`
    SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes WHERE dashboard_id = ?
  `).bind(dashboardId).first();
}
__name(getDashb\u043EardSandb\u043Ex, "getDashb\u043EardSandb\u043Ex");
async function ensureDashb\u043EardSandb\u043Ex(env, dashboardId, userId) {
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first();
  if (!access) {
    return Response.json({ error: "E79201: Not found or no access" }, { status: 404 });
  }
  const existingSandbox = await getDashb\u043EardSandb\u043Ex(env, dashboardId);
  if (existingSandbox?.sandbox_session_id) {
    return {
      sandboxSessionId: existingSandbox.sandbox_session_id,
      sandboxMachineId: existingSandbox.sandbox_machine_id || ""
    };
  }
  const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const sandboxSession = await sandbox.createSessi\u043En();
  const insertResult = await env.DB.prepare(`
    INSERT OR IGNORE INTO dashboard_sandboxes (dashboard_id, sandbox_session_id, sandbox_machine_id, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(dashboardId, sandboxSession.id, sandboxSession.machineId || "", now).run();
  if (insertResult.meta.changes === 0) {
    const reused = await getDashb\u043EardSandb\u043Ex(env, dashboardId);
    if (reused?.sandbox_session_id) {
      if (reused.sandbox_session_id !== sandboxSession.id) {
        await sandbox.deleteSession(sandboxSession.id, sandboxSession.machineId);
      }
      return {
        sandboxSessionId: reused.sandbox_session_id,
        sandboxMachineId: reused.sandbox_machine_id || ""
      };
    }
  }
  return {
    sandboxSessionId: sandboxSession.id,
    sandboxMachineId: sandboxSession.machineId || ""
  };
}
__name(ensureDashb\u043EardSandb\u043Ex, "ensureDashb\u043EardSandb\u043Ex");
function driveManifestKey(dashboardId) {
  return `drive/${dashboardId}/manifest.json`;
}
__name(driveManifestKey, "driveManifestKey");
function mirrorManifestKey(provider, dashboardId) {
  return `mirror/${provider}/${dashboardId}/manifest.json`;
}
__name(mirrorManifestKey, "mirrorManifestKey");
async function triggerDriveMirrorSync(env, dashboardId, sandboxSessionId, sandboxMachineId) {
  const mirror = await env.DB.prepare(`
    SELECT folder_name FROM drive_mirrors
    WHERE dashboard_id = ?
  `).bind(dashboardId).first();
  if (!mirror) {
    return;
  }
  const manifest = await env.DRIVE_CACHE.head(driveManifestKey(dashboardId));
  if (!manifest) {
    return;
  }
  await env.DB.prepare(`
    UPDATE drive_mirrors
    SET status = 'syncing_workspace', sync_error = null, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(dashboardId).run();
  await fetch(`${env.SANDBOX_URL.replace(/\/$/, "")}/sessions/${sandboxSessionId}/drive/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": env.SANDBOX_INTERNAL_TOKEN,
      ...sandboxMachineId ? { "X-Sandbox-Machine-ID": sandboxMachineId } : {}
    },
    body: JSON.stringify({
      dashboard_id: dashboardId,
      folder_name: mirror.folder_name
    })
  });
}
__name(triggerDriveMirrorSync, "triggerDriveMirrorSync");
async function triggerMirrorSync(env, provider, dashboardId, sandboxSessionId, sandboxMachineId, folderName) {
  const manifest = await env.DRIVE_CACHE.head(mirrorManifestKey(provider, dashboardId));
  if (!manifest) {
    return;
  }
  await env.DB.prepare(`
    UPDATE ${provider}_mirrors
    SET status = 'syncing_workspace', sync_error = null, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(dashboardId).run();
  await fetch(`${env.SANDBOX_URL.replace(/\/$/, "")}/sessions/${sandboxSessionId}/mirror/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": env.SANDBOX_INTERNAL_TOKEN,
      ...sandboxMachineId ? { "X-Sandbox-Machine-ID": sandboxMachineId } : {}
    },
    body: JSON.stringify({
      provider,
      dashboard_id: dashboardId,
      folder_name: folderName
    })
  });
}
__name(triggerMirrorSync, "triggerMirrorSync");
async function createSessi\u043En(env, dashboardId, itemId, userId, userName) {
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, userId).first();
  if (!access) {
    return Response.json({ error: "E79201: Not found or no access" }, { status: 404 });
  }
  const item = await env.DB.prepare(`
    SELECT * FROM dashboard_items WHERE id = ? AND dashboard_id = ? AND type = 'terminal'
  `).bind(itemId, dashboardId).first();
  if (!item) {
    return Response.json({ error: "E79202: Terminal item not found" }, { status: 404 });
  }
  const existingSession = await env.DB.prepare(`
    SELECT * FROM sessions WHERE item_id = ? AND status IN ('creating', 'active')
  `).bind(itemId).first();
  if (existingSession) {
    return Response.json({
      session: {
        id: existingSession.id,
        dashboardId: existingSession.dashboard_id,
        itemId: existingSession.item_id,
        ownerUserId: existingSession.owner_user_id,
        ownerName: existingSession.owner_name,
        sandboxSessionId: existingSession.sandbox_session_id,
        sandboxMachineId: existingSession.sandbox_machine_id,
        ptyId: existingSession.pty_id,
        status: existingSession.status,
        region: existingSession.region,
        createdAt: existingSession.created_at,
        stoppedAt: existingSession.stopped_at
      }
    });
  }
  const id = generateId2();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare(`
    INSERT INTO sessions (id, dashboard_id, item_id, owner_user_id, owner_name, sandbox_session_id, sandbox_machine_id, pty_id, status, region, created_at)
    VALUES (?, ?, ?, ?, ?, '', '', '', 'creating', 'local', ?)
  `).bind(id, dashboardId, itemId, userId, userName, now).run();
  const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
  try {
    const bootCommand = parseB\u043E\u043EtC\u043Emmand(item.content);
    const existingSandbox = await getDashb\u043EardSandb\u043Ex(env, dashboardId);
    let sandboxSessionId = existingSandbox?.sandbox_session_id || "";
    let sandboxMachineId = existingSandbox?.sandbox_machine_id || "";
    if (!sandboxSessionId) {
      const sandboxSession = await sandbox.createSessi\u043En();
      const insertResult = await env.DB.prepare(`
        INSERT OR IGNORE INTO dashboard_sandboxes (dashboard_id, sandbox_session_id, sandbox_machine_id, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(dashboardId, sandboxSession.id, sandboxSession.machineId || "", now).run();
      if (insertResult.meta.changes === 0) {
        const reused = await getDashb\u043EardSandb\u043Ex(env, dashboardId);
        if (reused?.sandbox_session_id) {
          sandboxSessionId = reused.sandbox_session_id;
          sandboxMachineId = reused.sandbox_machine_id || "";
        } else {
          sandboxSessionId = sandboxSession.id;
          sandboxMachineId = sandboxSession.machineId || "";
        }
        if (sandboxSessionId !== sandboxSession.id) {
          await sandbox.deleteSession(sandboxSession.id, sandboxSession.machineId);
        }
      } else {
        sandboxSessionId = sandboxSession.id;
        sandboxMachineId = sandboxSession.machineId || "";
      }
    }
    const pty = await sandbox.createPty(sandboxSessionId, userId, bootCommand, sandboxMachineId);
    await env.DB.prepare(`
      UPDATE sessions SET sandbox_session_id = ?, sandbox_machine_id = ?, pty_id = ?, status = 'active' WHERE id = ?
    `).bind(sandboxSessionId, sandboxMachineId, pty.id, id).run();
    const session = {
      id,
      dashboardId,
      itemId,
      ownerUserId: userId,
      ownerName: userName,
      sandboxSessionId,
      sandboxMachineId,
      ptyId: pty.id,
      status: "active",
      region: "local",
      createdAt: now,
      stoppedAt: null
    };
    const doId = env.DASHBOARD.idFromName(dashboardId);
    const stub = env.DASHBOARD.get(doId);
    await stub.fetch(new Request("http://do/session", {
      method: "PUT",
      body: JSON.stringify(session)
    }));
    try {
      await triggerDriveMirrorSync(env, dashboardId, sandboxSessionId, sandboxMachineId);
    } catch {
    }
    try {
      const githubMirror = await env.DB.prepare(`
        SELECT repo_owner, repo_name FROM github_mirrors
        WHERE dashboard_id = ?
      `).bind(dashboardId).first();
      if (githubMirror) {
        await triggerMirrorSync(
          env,
          "github",
          dashboardId,
          sandboxSessionId,
          sandboxMachineId,
          `${githubMirror.repo_owner}/${githubMirror.repo_name}`
        );
      }
    } catch {
    }
    try {
      const boxMirror = await env.DB.prepare(`
        SELECT folder_name FROM box_mirrors
        WHERE dashboard_id = ?
      `).bind(dashboardId).first();
      if (boxMirror) {
        await triggerMirrorSync(
          env,
          "box",
          dashboardId,
          sandboxSessionId,
          sandboxMachineId,
          boxMirror.folder_name
        );
      }
    } catch {
    }
    try {
      const onedriveMirror = await env.DB.prepare(`
        SELECT folder_name FROM onedrive_mirrors
        WHERE dashboard_id = ?
      `).bind(dashboardId).first();
      if (onedriveMirror) {
        await triggerMirrorSync(
          env,
          "onedrive",
          dashboardId,
          sandboxSessionId,
          sandboxMachineId,
          onedriveMirror.folder_name
        );
      }
    } catch {
    }
    return Response.json({ session }, { status: 201 });
  } catch (error) {
    await env.DB.prepare(`
      UPDATE sessions SET status = 'error' WHERE id = ?
    `).bind(id).run();
    return Response.json({
      error: `Failed to create sandbox session: ${error instanceof Error ? error.message : "Unknown error"}`
    }, { status: 500 });
  }
}
__name(createSessi\u043En, "createSessi\u043En");
async function startDashb\u043EardBrowser(env, dashboardId, userId) {
  const sandboxInfo = await ensureDashb\u043EardSandb\u043Ex(env, dashboardId, userId);
  if (sandboxInfo instanceof Response) {
    return sandboxInfo;
  }
  const { sandboxSessionId, sandboxMachineId } = sandboxInfo;
  const statusResponse = await fetch(`${env.SANDBOX_URL.replace(/\/$/, "")}/sessions/${sandboxSessionId}/browser/status`, {
    headers: {
      "X-Internal-Token": env.SANDBOX_INTERNAL_TOKEN,
      ...sandboxMachineId ? { "X-Sandbox-Machine-ID": sandboxMachineId } : {}
    }
  });
  if (statusResponse.ok) {
    try {
      const status = await statusResponse.json();
      if (status?.running) {
        return Response.json({ status: "running" });
      }
    } catch {
    }
  }
  const response = await fetch(`${env.SANDBOX_URL.replace(/\/$/, "")}/sessions/${sandboxSessionId}/browser/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": env.SANDBOX_INTERNAL_TOKEN,
      ...sandboxMachineId ? { "X-Sandbox-Machine-ID": sandboxMachineId } : {}
    }
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      detail = "";
    }
    return Response.json(
      { error: "E79815: Failed to start browser", detail: detail || void 0 },
      { status: 500 }
    );
  }
  return Response.json({ status: "starting" });
}
__name(startDashb\u043EardBrowser, "startDashb\u043EardBrowser");
async function st\u043EpDashb\u043EardBrowser(env, dashboardId, userId) {
  const sandboxInfo = await ensureDashb\u043EardSandb\u043Ex(env, dashboardId, userId);
  if (sandboxInfo instanceof Response) {
    return sandboxInfo;
  }
  const { sandboxSessionId, sandboxMachineId } = sandboxInfo;
  await fetch(`${env.SANDBOX_URL.replace(/\/$/, "")}/sessions/${sandboxSessionId}/browser/stop`, {
    method: "POST",
    headers: {
      "X-Internal-Token": env.SANDBOX_INTERNAL_TOKEN,
      ...sandboxMachineId ? { "X-Sandbox-Machine-ID": sandboxMachineId } : {}
    }
  });
  return new Response(null, { status: 204 });
}
__name(st\u043EpDashb\u043EardBrowser, "st\u043EpDashb\u043EardBrowser");
async function getDashb\u043EardBrowserStatus(env, dashboardId, userId) {
  const sandboxInfo = await ensureDashb\u043EardSandb\u043Ex(env, dashboardId, userId);
  if (sandboxInfo instanceof Response) {
    return sandboxInfo;
  }
  const { sandboxSessionId, sandboxMachineId } = sandboxInfo;
  const response = await fetch(`${env.SANDBOX_URL.replace(/\/$/, "")}/sessions/${sandboxSessionId}/browser/status`, {
    headers: {
      "X-Internal-Token": env.SANDBOX_INTERNAL_TOKEN,
      ...sandboxMachineId ? { "X-Sandbox-Machine-ID": sandboxMachineId } : {}
    }
  });
  if (!response.ok) {
    return Response.json({ running: false }, { status: 200 });
  }
  return response;
}
__name(getDashb\u043EardBrowserStatus, "getDashb\u043EardBrowserStatus");
async function openDashb\u043EardBrowser(env, dashboardId, userId, url) {
  const sandboxInfo = await ensureDashb\u043EardSandb\u043Ex(env, dashboardId, userId);
  if (sandboxInfo instanceof Response) {
    return sandboxInfo;
  }
  const { sandboxSessionId, sandboxMachineId } = sandboxInfo;
  const response = await fetch(`${env.SANDBOX_URL.replace(/\/$/, "")}/sessions/${sandboxSessionId}/browser/open`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": env.SANDBOX_INTERNAL_TOKEN,
      ...sandboxMachineId ? { "X-Sandbox-Machine-ID": sandboxMachineId } : {}
    },
    body: JSON.stringify({ url })
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      detail = "";
    }
    return Response.json(
      { error: "E79817: Failed to open browser URL", detail: detail || void 0 },
      { status: 500 }
    );
  }
  const doId = env.DASHBOARD.idFromName(dashboardId);
  const stub = env.DASHBOARD.get(doId);
  await stub.fetch(new Request("http://do/browser", {
    method: "POST",
    body: JSON.stringify({ url })
  }));
  return new Response(null, { status: 204 });
}
__name(openDashb\u043EardBrowser, "openDashb\u043EardBrowser");
async function openBrowserFromSandb\u043ExSessionInternal(env, sandboxSessionId, url) {
  if (!sandboxSessionId || !url) {
    return Response.json({ error: "E79821: Missing session or URL" }, { status: 400 });
  }
  const session = await env.DB.prepare(`
    SELECT dashboard_id FROM sessions WHERE sandbox_session_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(sandboxSessionId).first();
  if (!session?.dashboard_id) {
    return Response.json({ error: "E79820: Session not found" }, { status: 404 });
  }
  const dashboardId = session.dashboard_id;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const existingBrowser = await env.DB.prepare(`
    SELECT * FROM dashboard_items
    WHERE dashboard_id = ? AND type = 'browser'
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(dashboardId).first();
  let browserItemId = existingBrowser?.id;
  if (browserItemId) {
    await env.DB.prepare(`
      UPDATE dashboard_items
      SET content = ?, updated_at = ?
      WHERE id = ?
    `).bind(url, now, browserItemId).run();
  } else {
    const terminalAnchor = await env.DB.prepare(`
      SELECT position_x, position_y, width FROM dashboard_items
      WHERE dashboard_id = ? AND type = 'terminal'
      ORDER BY updated_at DESC
      LIMIT 1
    `).bind(dashboardId).first();
    const anchorX = typeof terminalAnchor?.position_x === "number" ? terminalAnchor.position_x : 140;
    const anchorY = typeof terminalAnchor?.position_y === "number" ? terminalAnchor.position_y : 140;
    const anchorWidth = typeof terminalAnchor?.width === "number" ? terminalAnchor.width : 520;
    const positionX = anchorX + anchorWidth + 24;
    const positionY = anchorY;
    browserItemId = generateId2();
    await env.DB.prepare(`
      INSERT INTO dashboard_items
        (id, dashboard_id, type, content, position_x, position_y, width, height, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      browserItemId,
      dashboardId,
      "browser",
      url,
      positionX,
      positionY,
      520,
      360,
      now,
      now
    ).run();
  }
  await env.DB.prepare(`
    UPDATE dashboards SET updated_at = ? WHERE id = ?
  `).bind(now, dashboardId).run();
  const savedItem = await env.DB.prepare(`
    SELECT * FROM dashboard_items WHERE id = ?
  `).bind(browserItemId).first();
  const formattedItem = savedItem ? f\u043ErmatDashb\u043EardItem(savedItem) : null;
  const doId = env.DASHBOARD.idFromName(dashboardId);
  const stub = env.DASHBOARD.get(doId);
  if (formattedItem) {
    await stub.fetch(new Request("http://do/item", {
      method: existingBrowser ? "PUT" : "POST",
      body: JSON.stringify(formattedItem)
    }));
  }
  await stub.fetch(new Request("http://do/browser", {
    method: "POST",
    body: JSON.stringify({ url })
  }));
  return new Response(null, { status: 204 });
}
__name(openBrowserFromSandb\u043ExSessionInternal, "openBrowserFromSandb\u043ExSessionInternal");
async function getSessi\u043En(env, sessionId, userId) {
  const session = await env.DB.prepare(`
    SELECT s.*, dm.role FROM sessions s
    JOIN dashboard_members dm ON s.dashboard_id = dm.dashboard_id
    WHERE s.id = ? AND dm.user_id = ?
  `).bind(sessionId, userId).first();
  if (!session) {
    return Response.json({ error: "E79203: Session not found or no access" }, { status: 404 });
  }
  return Response.json({
    session: {
      id: session.id,
      dashboardId: session.dashboard_id,
      itemId: session.item_id,
      ownerUserId: session.owner_user_id,
      ownerName: session.owner_name,
      sandboxSessionId: session.sandbox_session_id,
      sandboxMachineId: session.sandbox_machine_id,
      ptyId: session.pty_id,
      status: session.status,
      region: session.region,
      createdAt: session.created_at,
      stoppedAt: session.stopped_at
    }
  });
}
__name(getSessi\u043En, "getSessi\u043En");
async function updateSessi\u043EnEnv(env, sessionId, userId, payload) {
  const session = await env.DB.prepare(`
    SELECT s.* FROM sessions s
    JOIN dashboard_members dm ON s.dashboard_id = dm.dashboard_id
    WHERE s.id = ? AND dm.user_id = ?
  `).bind(sessionId, userId).first();
  if (!session) {
    return Response.json({ error: "E79214: Session not found or no access" }, { status: 404 });
  }
  const set = payload.set || {};
  const unset = payload.unset || [];
  const hasSet = Object.keys(set).length > 0;
  const hasUnset = unset.length > 0;
  if (!hasSet && !hasUnset) {
    return Response.json({ error: "E79215: No env updates provided" }, { status: 400 });
  }
  for (const [key, value] of Object.entries(set)) {
    if (typeof key !== "string" || typeof value !== "string") {
      return Response.json({ error: "E79216: Invalid env payload" }, { status: 400 });
    }
  }
  for (const key of unset) {
    if (typeof key !== "string") {
      return Response.json({ error: "E79216: Invalid env payload" }, { status: 400 });
    }
  }
  const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
  await sandbox.updateEnv(
    session.sandbox_session_id,
    { set, unset, applyNow: payload.applyNow },
    session.sandbox_machine_id || void 0
  );
  return Response.json({ status: "ok" });
}
__name(updateSessi\u043EnEnv, "updateSessi\u043EnEnv");
async function st\u043EpSessi\u043En(env, sessionId, userId) {
  const session = await env.DB.prepare(`
    SELECT s.*, dm.role FROM sessions s
    JOIN dashboard_members dm ON s.dashboard_id = dm.dashboard_id
    WHERE s.id = ? AND dm.user_id = ? AND dm.role IN ('owner', 'editor')
  `).bind(sessionId, userId).first();
  if (!session) {
    return Response.json({ error: "E79203: Session not found or no access" }, { status: 404 });
  }
  if (session.status === "stopped") {
    return Response.json({ error: "E79204: Session already stopped" }, { status: 400 });
  }
  const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
  try {
    const otherSessions = await env.DB.prepare(`
      SELECT COUNT(1) as count FROM sessions
      WHERE dashboard_id = ? AND status IN ('creating', 'active') AND id != ?
    `).bind(session.dashboard_id, sessionId).first();
    if (!otherSessions || otherSessions.count === 0) {
      await sandbox.deleteSession(session.sandbox_session_id, session.sandbox_machine_id);
      await env.DB.prepare(`
        DELETE FROM dashboard_sandboxes WHERE dashboard_id = ?
      `).bind(session.dashboard_id).run();
    }
  } catch {
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare(`
    UPDATE sessions SET status = 'stopped', stopped_at = ? WHERE id = ?
  `).bind(now, sessionId).run();
  const updatedSession = {
    id: session.id,
    dashboardId: session.dashboard_id,
    itemId: session.item_id,
    ownerUserId: session.owner_user_id,
    ownerName: session.owner_name,
    sandboxSessionId: session.sandbox_session_id,
    sandboxMachineId: session.sandbox_machine_id,
    ptyId: session.pty_id,
    status: "stopped",
    region: session.region,
    createdAt: session.created_at,
    stoppedAt: now
  };
  const doId = env.DASHBOARD.idFromName(session.dashboard_id);
  const stub = env.DASHBOARD.get(doId);
  await stub.fetch(new Request("http://do/session", {
    method: "PUT",
    body: JSON.stringify(updatedSession)
  }));
  return new Response(null, { status: 204 });
}
__name(st\u043EpSessi\u043En, "st\u043EpSessi\u043En");

// src/auth/access.ts
var ROLE_HIERARCHY = { owner: 3, editor: 2, viewer: 1 };
function hasRequiredR\u043Ele(userRole, requiredRole) {
  const userRoleLevel = ROLE_HIERARCHY[userRole] || 0;
  const requiredLevel = requiredRole ? ROLE_HIERARCHY[requiredRole] : 0;
  return userRoleLevel >= requiredLevel;
}
__name(hasRequiredR\u043Ele, "hasRequiredR\u043Ele");
async function checkDashb\u043EardAccess(env, dashboardId, userId, requiredRole) {
  const member = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first();
  if (!member) {
    return { hasAccess: false };
  }
  return {
    hasAccess: hasRequiredR\u043Ele(member.role, requiredRole),
    role: member.role
  };
}
__name(checkDashb\u043EardAccess, "checkDashb\u043EardAccess");
async function checkRecip\u0435Access(env, recipeId, userId, requiredRole) {
  const recipe = await env.DB.prepare(`
    SELECT * FROM recipes WHERE id = ?
  `).bind(recipeId).first();
  if (!recipe) {
    return { hasAccess: false };
  }
  if (!recipe.dashboard_id) {
    return { hasAccess: true, recipe };
  }
  const { hasAccess } = await checkDashb\u043EardAccess(env, recipe.dashboard_id, userId, requiredRole);
  return { hasAccess, recipe: hasAccess ? recipe : void 0 };
}
__name(checkRecip\u0435Access, "checkRecip\u0435Access");
async function checkExecuti\u043EnAccess(env, executionId, userId, requiredRole) {
  const execution = await env.DB.prepare(`
    SELECT * FROM executions WHERE id = ?
  `).bind(executionId).first();
  if (!execution) {
    return { hasAccess: false };
  }
  const { hasAccess } = await checkRecip\u0435Access(env, execution.recipe_id, userId, requiredRole);
  return { hasAccess, execution: hasAccess ? execution : void 0 };
}
__name(checkExecuti\u043EnAccess, "checkExecuti\u043EnAccess");
async function checkSchedul\u0435Access(env, scheduleId, userId, requiredRole) {
  const schedule = await env.DB.prepare(`
    SELECT * FROM schedules WHERE id = ?
  `).bind(scheduleId).first();
  if (!schedule) {
    return { hasAccess: false };
  }
  const { hasAccess } = await checkRecip\u0435Access(env, schedule.recipe_id, userId, requiredRole);
  return { hasAccess, schedule: hasAccess ? schedule : void 0 };
}
__name(checkSchedul\u0435Access, "checkSchedul\u0435Access");

// src/recipes/handler.ts
function generateId3() {
  return crypto.randomUUID();
}
__name(generateId3, "generateId");
function saf\u0435JsonParse(json, fallback) {
  if (!json)
    return fallback;
  try {
    return JSON.parse(json);
  } catch (error) {
    console.error("Failed to parse JSON:", error, "Input:", json?.substring(0, 100));
    return fallback;
  }
}
__name(saf\u0435JsonParse, "saf\u0435JsonParse");
async function listRecip\u0435s(env, userId, dashboardId) {
  if (dashboardId) {
    const { hasAccess } = await checkDashb\u043EardAccess(env, dashboardId, userId, "viewer");
    if (!hasAccess) {
      return Response.json({ error: "E79501: Dashboard not found or no access" }, { status: 404 });
    }
  }
  let result;
  if (dashboardId) {
    result = await env.DB.prepare(`
      SELECT * FROM recipes WHERE dashboard_id = ? ORDER BY updated_at DESC
    `).bind(dashboardId).all();
  } else {
    result = await env.DB.prepare(`
      SELECT r.* FROM recipes r
      LEFT JOIN dashboard_members dm ON r.dashboard_id = dm.dashboard_id
      WHERE r.dashboard_id IS NULL OR dm.user_id = ?
      ORDER BY r.updated_at DESC
    `).bind(userId).all();
  }
  const recipes = result.results.map((r) => ({
    id: r.id,
    dashboardId: r.dashboard_id,
    name: r.name,
    description: r.description,
    steps: saf\u0435JsonParse(r.steps, []),
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
  return Response.json({ recipes });
}
__name(listRecip\u0435s, "listRecip\u0435s");
async function getRecip\u0435(env, recipeId, userId) {
  const { hasAccess, recipe } = await checkRecip\u0435Access(env, recipeId, userId, "viewer");
  if (!hasAccess || !recipe) {
    return Response.json({ error: "E79502: Recipe not found or no access" }, { status: 404 });
  }
  return Response.json({
    recipe: {
      id: recipe.id,
      dashboardId: recipe.dashboard_id,
      name: recipe.name,
      description: recipe.description,
      steps: saf\u0435JsonParse(recipe.steps, []),
      createdAt: recipe.created_at,
      updatedAt: recipe.updated_at
    }
  });
}
__name(getRecip\u0435, "getRecip\u0435");
async function createRecip\u0435(env, userId, data) {
  if (data.dashboardId) {
    const { hasAccess } = await checkDashb\u043EardAccess(env, data.dashboardId, userId, "editor");
    if (!hasAccess) {
      return Response.json({ error: "E79501: Dashboard not found or no access" }, { status: 404 });
    }
  }
  const id = generateId3();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare(`
    INSERT INTO recipes (id, dashboard_id, name, description, steps, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    data.dashboardId || null,
    data.name,
    data.description || "",
    JSON.stringify(data.steps || []),
    now,
    now
  ).run();
  const recipe = {
    id,
    dashboardId: data.dashboardId || "",
    name: data.name,
    description: data.description || "",
    steps: data.steps || [],
    createdAt: now,
    updatedAt: now
  };
  return Response.json({ recipe }, { status: 201 });
}
__name(createRecip\u0435, "createRecip\u0435");
async function updateRecipe(env, recipeId, userId, data) {
  const { hasAccess, recipe: existing } = await checkRecip\u0435Access(env, recipeId, userId, "editor");
  if (!hasAccess || !existing) {
    return Response.json({ error: "E79502: Recipe not found or no access" }, { status: 404 });
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare(`
    UPDATE recipes SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      steps = COALESCE(?, steps),
      updated_at = ?
    WHERE id = ?
  `).bind(
    data.name || null,
    data.description || null,
    data.steps ? JSON.stringify(data.steps) : null,
    now,
    recipeId
  ).run();
  const updated = await env.DB.prepare(`
    SELECT * FROM recipes WHERE id = ?
  `).bind(recipeId).first();
  return Response.json({
    recipe: {
      id: updated.id,
      dashboardId: updated.dashboard_id,
      name: updated.name,
      description: updated.description,
      steps: saf\u0435JsonParse(updated.steps, []),
      createdAt: updated.created_at,
      updatedAt: updated.updated_at
    }
  });
}
__name(updateRecipe, "updateRecipe");
async function deleteRecipe(env, recipeId, userId) {
  const { hasAccess } = await checkRecip\u0435Access(env, recipeId, userId, "owner");
  if (!hasAccess) {
    return Response.json({ error: "E79502: Recipe not found or no access" }, { status: 404 });
  }
  await env.DB.prepare(`DELETE FROM recipes WHERE id = ?`).bind(recipeId).run();
  return new Response(null, { status: 204 });
}
__name(deleteRecipe, "deleteRecipe");
async function startExecuti\u043En(env, recipeId, userId, context) {
  const { hasAccess, recipe } = await checkRecip\u0435Access(env, recipeId, userId, "editor");
  if (!hasAccess || !recipe) {
    return Response.json({ error: "E79502: Recipe not found or no access" }, { status: 404 });
  }
  return createExecuti\u043En(env, recipeId, recipe, context);
}
__name(startExecuti\u043En, "startExecuti\u043En");
async function startExecuti\u043EnInternal(env, recipeId, context) {
  const recipe = await env.DB.prepare(`
    SELECT * FROM recipes WHERE id = ?
  `).bind(recipeId).first();
  if (!recipe) {
    return Response.json({ error: "E79729: Recipe not found" }, { status: 404 });
  }
  return createExecuti\u043En(env, recipeId, recipe, context);
}
__name(startExecuti\u043EnInternal, "startExecuti\u043EnInternal");
async function createExecuti\u043En(env, recipeId, recipe, context) {
  const steps = saf\u0435JsonParse(recipe.steps, []);
  const firstStepId = steps.length > 0 ? steps[0].id : null;
  const id = generateId3();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare(`
    INSERT INTO executions (id, recipe_id, status, current_step_id, context, started_at)
    VALUES (?, ?, 'running', ?, ?, ?)
  `).bind(
    id,
    recipeId,
    firstStepId,
    JSON.stringify(context || {}),
    now
  ).run();
  const execution = {
    id,
    recipeId,
    status: "running",
    currentStepId: firstStepId,
    context: context || {},
    startedAt: now,
    completedAt: null,
    error: null
  };
  if (firstStepId) {
  }
  return Response.json({ execution }, { status: 201 });
}
__name(createExecuti\u043En, "createExecuti\u043En");
async function getExecuti\u043En(env, executionId, userId) {
  const { hasAccess, execution } = await checkExecuti\u043EnAccess(env, executionId, userId, "viewer");
  if (!hasAccess || !execution) {
    return Response.json({ error: "E79730: Execution not found or no access" }, { status: 404 });
  }
  const artifacts = await env.DB.prepare(`
    SELECT * FROM artifacts WHERE execution_id = ?
  `).bind(executionId).all();
  return Response.json({
    execution: {
      id: execution.id,
      recipeId: execution.recipe_id,
      status: execution.status,
      currentStepId: execution.current_step_id,
      context: saf\u0435JsonParse(execution.context, {}),
      startedAt: execution.started_at,
      completedAt: execution.completed_at,
      error: execution.error
    },
    artifacts: artifacts.results.map((a) => ({
      id: a.id,
      executionId: a.execution_id,
      stepId: a.step_id,
      type: a.type,
      name: a.name,
      content: a.content,
      createdAt: a.created_at
    }))
  });
}
__name(getExecuti\u043En, "getExecuti\u043En");
async function listExecuti\u043Ens(env, recipeId, userId) {
  const { hasAccess } = await checkRecip\u0435Access(env, recipeId, userId, "viewer");
  if (!hasAccess) {
    return Response.json({ error: "E79502: Recipe not found or no access" }, { status: 404 });
  }
  const result = await env.DB.prepare(`
    SELECT * FROM executions WHERE recipe_id = ? ORDER BY started_at DESC
  `).bind(recipeId).all();
  const executions = result.results.map((e) => ({
    id: e.id,
    recipeId: e.recipe_id,
    status: e.status,
    currentStepId: e.current_step_id,
    context: saf\u0435JsonParse(e.context, {}),
    startedAt: e.started_at,
    completedAt: e.completed_at,
    error: e.error
  }));
  return Response.json({ executions });
}
__name(listExecuti\u043Ens, "listExecuti\u043Ens");
async function pauseExecuti\u043En(env, executionId, userId) {
  const { hasAccess, execution } = await checkExecuti\u043EnAccess(env, executionId, userId, "editor");
  if (!hasAccess || !execution) {
    return Response.json({ error: "E79730: Execution not found or no access" }, { status: 404 });
  }
  if (execution.status !== "running") {
    return Response.json({ error: "E79731: Execution is not running" }, { status: 400 });
  }
  await env.DB.prepare(`
    UPDATE executions SET status = ? WHERE id = ?
  `).bind("paused", executionId).run();
  return Response.json({ status: "paused" });
}
__name(pauseExecuti\u043En, "pauseExecuti\u043En");
async function resumeExecuti\u043En(env, executionId, userId) {
  const { hasAccess, execution } = await checkExecuti\u043EnAccess(env, executionId, userId, "editor");
  if (!hasAccess || !execution) {
    return Response.json({ error: "E79730: Execution not found or no access" }, { status: 404 });
  }
  if (execution.status !== "paused") {
    return Response.json({ error: "E79732: Execution is not paused" }, { status: 400 });
  }
  await env.DB.prepare(`
    UPDATE executions SET status = ? WHERE id = ?
  `).bind("running", executionId).run();
  return Response.json({ status: "running" });
}
__name(resumeExecuti\u043En, "resumeExecuti\u043En");
async function addArtifact(env, executionId, data) {
  const id = generateId3();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare(`
    INSERT INTO artifacts (id, execution_id, step_id, type, name, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(id, executionId, data.stepId, data.type, data.name, data.content, now).run();
  const artifact = {
    id,
    executionId,
    stepId: data.stepId,
    type: data.type,
    name: data.name,
    content: data.content,
    createdAt: now
  };
  return Response.json({ artifact }, { status: 201 });
}
__name(addArtifact, "addArtifact");

// src/schedules/handler.ts
function generateId4() {
  return crypto.randomUUID();
}
__name(generateId4, "generateId");
function parseCr\u043EnField(field, min, max) {
  const values = [];
  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++)
        values.push(i);
    } else if (part.startsWith("*/")) {
      const step = parseInt(part.slice(2), 10);
      if (isNaN(step) || step <= 0)
        return null;
      for (let i = min; i <= max; i += step)
        values.push(i);
    } else if (part.includes("-")) {
      const [startStr, endStr] = part.split("-");
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (isNaN(start) || isNaN(end) || start < min || end > max || start > end)
        return null;
      for (let i = start; i <= end; i++)
        values.push(i);
    } else {
      const val = parseInt(part, 10);
      if (isNaN(val) || val < min || val > max)
        return null;
      values.push(val);
    }
  }
  return values.length > 0 ? [...new Set(values)].sort((a, b) => a - b) : null;
}
__name(parseCr\u043EnField, "parseCr\u043EnField");
function c\u043EmputeNextRun(cron, from = /* @__PURE__ */ new Date()) {
  try {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5)
      return null;
    const minutes = parseCr\u043EnField(parts[0], 0, 59);
    const hours = parseCr\u043EnField(parts[1], 0, 23);
    const days = parseCr\u043EnField(parts[2], 1, 31);
    const months = parseCr\u043EnField(parts[3], 1, 12);
    const weekdays = parseCr\u043EnField(parts[4], 0, 6);
    if (!minutes || !hours || !days || !months || !weekdays)
      return null;
    const dayRestricted = parts[2] !== "*";
    const weekdayRestricted = parts[4] !== "*";
    const useDayOrWeekday = dayRestricted && weekdayRestricted;
    const next = new Date(from);
    next.setUTCSeconds(0);
    next.setUTCMilliseconds(0);
    next.setUTCMinutes(next.getUTCMinutes() + 1);
    const maxIterations = 366 * 24 * 60;
    for (let i = 0; i < maxIterations; i++) {
      const month = next.getUTCMonth() + 1;
      const day = next.getUTCDate();
      const weekday = next.getUTCDay();
      const hour = next.getUTCHours();
      const minute = next.getUTCMinutes();
      const dayMatches = useDayOrWeekday ? days.includes(day) || weekdays.includes(weekday) : days.includes(day) && weekdays.includes(weekday);
      if (months.includes(month) && dayMatches && hours.includes(hour) && minutes.includes(minute)) {
        return next;
      }
      next.setUTCMinutes(next.getUTCMinutes() + 1);
    }
    return null;
  } catch {
    return null;
  }
}
__name(c\u043EmputeNextRun, "c\u043EmputeNextRun");
async function listSchedules(env, userId, recipeId) {
  if (recipeId) {
    const { hasAccess } = await checkRecip\u0435Access(env, recipeId, userId, "viewer");
    if (!hasAccess) {
      return Response.json({ error: "E79725: Recipe not found or no access" }, { status: 404 });
    }
    const result2 = await env.DB.prepare(`
      SELECT * FROM schedules WHERE recipe_id = ? ORDER BY created_at DESC
    `).bind(recipeId).all();
    const schedules2 = result2.results.map((s) => ({
      id: s.id,
      recipeId: s.recipe_id,
      name: s.name,
      cron: s.cron,
      eventTrigger: s.event_trigger,
      enabled: Boolean(s.enabled),
      lastRunAt: s.last_run_at,
      nextRunAt: s.next_run_at,
      createdAt: s.created_at
    }));
    return Response.json({ schedules: schedules2 });
  }
  const result = await env.DB.prepare(`
    SELECT s.* FROM schedules s
    INNER JOIN recipes r ON s.recipe_id = r.id
    LEFT JOIN dashboard_members dm ON r.dashboard_id = dm.dashboard_id
    WHERE r.dashboard_id IS NULL OR dm.user_id = ?
    ORDER BY s.created_at DESC
  `).bind(userId).all();
  const schedules = result.results.map((s) => ({
    id: s.id,
    recipeId: s.recipe_id,
    name: s.name,
    cron: s.cron,
    eventTrigger: s.event_trigger,
    enabled: Boolean(s.enabled),
    lastRunAt: s.last_run_at,
    nextRunAt: s.next_run_at,
    createdAt: s.created_at
  }));
  return Response.json({ schedules });
}
__name(listSchedules, "listSchedules");
async function getSchedule(env, scheduleId, userId) {
  const { hasAccess, schedule } = await checkSchedul\u0435Access(env, scheduleId, userId, "viewer");
  if (!hasAccess || !schedule) {
    return Response.json({ error: "E79726: Schedule not found or no access" }, { status: 404 });
  }
  return Response.json({
    schedule: {
      id: schedule.id,
      recipeId: schedule.recipe_id,
      name: schedule.name,
      cron: schedule.cron,
      eventTrigger: schedule.event_trigger,
      enabled: Boolean(schedule.enabled),
      lastRunAt: schedule.last_run_at,
      nextRunAt: schedule.next_run_at,
      createdAt: schedule.created_at
    }
  });
}
__name(getSchedule, "getSchedule");
async function createSchedule(env, userId, data) {
  const { hasAccess } = await checkRecip\u0435Access(env, data.recipeId, userId, "editor");
  if (!hasAccess) {
    return Response.json({ error: "E79725: Recipe not found or no access" }, { status: 404 });
  }
  if (!data.cron && !data.eventTrigger) {
    return Response.json({ error: "E79727: Either cron or eventTrigger required" }, { status: 400 });
  }
  const id = generateId4();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const enabled = data.enabled !== false;
  let nextRunAt = null;
  if (data.cron && enabled) {
    const next = c\u043EmputeNextRun(data.cron);
    nextRunAt = next ? next.toISOString() : null;
  }
  await env.DB.prepare(`
    INSERT INTO schedules (id, recipe_id, name, cron, event_trigger, enabled, next_run_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    data.recipeId,
    data.name,
    data.cron || null,
    data.eventTrigger || null,
    enabled ? 1 : 0,
    nextRunAt,
    now
  ).run();
  const schedule = {
    id,
    recipeId: data.recipeId,
    name: data.name,
    cron: data.cron || null,
    eventTrigger: data.eventTrigger || null,
    enabled,
    lastRunAt: null,
    nextRunAt,
    createdAt: now
  };
  return Response.json({ schedule }, { status: 201 });
}
__name(createSchedule, "createSchedule");
async function updateSchedule(env, scheduleId, userId, data) {
  const { hasAccess, schedule: existing } = await checkSchedul\u0435Access(env, scheduleId, userId, "editor");
  if (!hasAccess || !existing) {
    return Response.json({ error: "E79728: Schedule not found or no access" }, { status: 404 });
  }
  const enabled = data.enabled !== void 0 ? data.enabled : Boolean(existing.enabled);
  const cron = data.cron !== void 0 ? data.cron : existing.cron;
  let nextRunAt = null;
  if (cron && enabled) {
    const next = c\u043EmputeNextRun(cron);
    nextRunAt = next ? next.toISOString() : null;
  }
  await env.DB.prepare(`
    UPDATE schedules SET
      name = COALESCE(?, name),
      cron = ?,
      event_trigger = ?,
      enabled = ?,
      next_run_at = ?
    WHERE id = ?
  `).bind(
    data.name || null,
    data.cron !== void 0 ? data.cron : existing.cron,
    data.eventTrigger !== void 0 ? data.eventTrigger : existing.event_trigger,
    enabled ? 1 : 0,
    nextRunAt,
    scheduleId
  ).run();
  const updated = await env.DB.prepare(`
    SELECT * FROM schedules WHERE id = ?
  `).bind(scheduleId).first();
  return Response.json({
    schedule: {
      id: updated.id,
      recipeId: updated.recipe_id,
      name: updated.name,
      cron: updated.cron,
      eventTrigger: updated.event_trigger,
      enabled: Boolean(updated.enabled),
      lastRunAt: updated.last_run_at,
      nextRunAt: updated.next_run_at,
      createdAt: updated.created_at
    }
  });
}
__name(updateSchedule, "updateSchedule");
async function d\u0435leteSchedule(env, scheduleId, userId) {
  const result = await env.DB.prepare(`
    DELETE FROM schedules
    WHERE id = ?
    AND (
      -- Check ownership via dashboard membership (owner role required)
      recipe_id IN (
        SELECT r.id FROM recipes r
        INNER JOIN dashboard_members dm ON r.dashboard_id = dm.dashboard_id
        WHERE dm.user_id = ? AND dm.role = 'owner'
      )
    )
  `).bind(scheduleId, userId).run();
  if (result.meta.changes === 0) {
    return Response.json({ error: "E79728: Schedule not found or no access" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
__name(d\u0435leteSchedule, "d\u0435leteSchedule");
async function enableSchedule(env, scheduleId, userId) {
  return updateSchedule(env, scheduleId, userId, { enabled: true });
}
__name(enableSchedule, "enableSchedule");
async function disableSchedule(env, scheduleId, userId) {
  return updateSchedule(env, scheduleId, userId, { enabled: false });
}
__name(disableSchedule, "disableSchedule");
async function triggerSchedule(env, scheduleId, userId) {
  const { hasAccess, schedule } = await checkSchedul\u0435Access(env, scheduleId, userId, "editor");
  if (!hasAccess || !schedule) {
    return Response.json({ error: "E79728: Schedule not found or no access" }, { status: 404 });
  }
  const executionResponse = await startExecuti\u043En(
    env,
    schedule.recipe_id,
    userId,
    { triggeredBy: "manual", scheduleId, actorUserId: userId }
  );
  const now = (/* @__PURE__ */ new Date()).toISOString();
  let nextRunAt = null;
  if (schedule.cron && schedule.enabled) {
    const next = c\u043EmputeNextRun(schedule.cron);
    nextRunAt = next ? next.toISOString() : null;
  }
  await env.DB.prepare(`
    UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?
  `).bind(now, nextRunAt, scheduleId).run();
  const executionData = await executionResponse.json();
  return Response.json({
    schedule: {
      id: schedule.id,
      recipeId: schedule.recipe_id,
      name: schedule.name,
      lastRunAt: now,
      nextRunAt
    },
    execution: executionData.execution
  });
}
__name(triggerSchedule, "triggerSchedule");
async function pr\u043EcessDueSchedules(env) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const dueSchedules = await env.DB.prepare(`
    SELECT * FROM schedules
    WHERE enabled = 1 AND cron IS NOT NULL AND next_run_at <= ?
  `).bind(now).all();
  for (const schedule of dueSchedules.results) {
    try {
      await startExecuti\u043EnInternal(
        env,
        schedule.recipe_id,
        { triggeredBy: "cron", scheduleId: schedule.id }
      );
      const next = c\u043EmputeNextRun(schedule.cron);
      const nextRunAt = next ? next.toISOString() : null;
      await env.DB.prepare(`
        UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?
      `).bind(now, nextRunAt, schedule.id).run();
    } catch (error) {
      console.error(`Failed to process schedule ${schedule.id}:`, error);
    }
  }
}
__name(pr\u043EcessDueSchedules, "pr\u043EcessDueSchedules");
async function emitEvent(env, eventName, payload) {
  const schedules = await env.DB.prepare(`
    SELECT * FROM schedules
    WHERE enabled = 1 AND event_trigger = ?
  `).bind(eventName).all();
  const executions = [];
  const now = (/* @__PURE__ */ new Date()).toISOString();
  for (const schedule of schedules.results) {
    try {
      const executionResponse = await startExecuti\u043EnInternal(
        env,
        schedule.recipe_id,
        { triggeredBy: "event", eventName, payload, scheduleId: schedule.id }
      );
      const executionData = await executionResponse.json();
      executions.push(executionData.execution);
      await env.DB.prepare(`
        UPDATE schedules SET last_run_at = ? WHERE id = ?
      `).bind(now, schedule.id).run();
    } catch (error) {
      console.error(`Failed to trigger schedule ${schedule.id} for event ${eventName}:`, error);
    }
  }
  return Response.json({
    event: eventName,
    schedulesTriggered: schedules.results.length,
    executions
  });
}
__name(emitEvent, "emitEvent");

// src/subagents/handler.ts
function saf\u0435JsonParse2(json, fallback) {
  if (!json)
    return fallback;
  try {
    return JSON.parse(json);
  } catch (error) {
    console.error("Failed to parse JSON:", error, "Input:", json?.substring(0, 100));
    return fallback;
  }
}
__name(saf\u0435JsonParse2, "saf\u0435JsonParse");
function formatSubagent(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description || "",
    prompt: row.prompt || "",
    tools: saf\u0435JsonParse2(row.tools || "[]", []),
    source: row.source || "custom",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
__name(formatSubagent, "formatSubagent");
async function listSubagents(env, userId) {
  const rows = await env.DB.prepare(
    `SELECT * FROM user_subagents WHERE user_id = ? ORDER BY updated_at DESC`
  ).bind(userId).all();
  return Response.json({
    subagents: rows.results.map((row) => formatSubagent(row))
  });
}
__name(listSubagents, "listSubagents");
async function createSubagent(env, userId, data) {
  if (!data.name || !data.prompt) {
    return Response.json({ error: "E79721: name and prompt are required" }, { status: 400 });
  }
  const id = data.id || crypto.randomUUID();
  const tools = JSON.stringify(data.tools || []);
  const description = data.description || "";
  const source = data.source || "custom";
  await env.DB.prepare(
    `INSERT INTO user_subagents (id, user_id, name, description, prompt, tools, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(id, userId, data.name, description, data.prompt, tools, source).run();
  const row = await env.DB.prepare(`SELECT * FROM user_subagents WHERE id = ?`).bind(id).first();
  return Response.json({ subagent: formatSubagent(row) });
}
__name(createSubagent, "createSubagent");
async function deleteSubagent(env, userId, id) {
  const result = await env.DB.prepare(
    `DELETE FROM user_subagents WHERE id = ? AND user_id = ?`
  ).bind(id, userId).run();
  if (result.meta.changes === 0) {
    return Response.json({ error: "E79722: Subagent not found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
__name(deleteSubagent, "deleteSubagent");

// src/secrets/handler.ts
function formatSecret(row) {
  return {
    id: row.id,
    userId: row.user_id,
    dashboardId: row.dashboard_id,
    name: row.name,
    description: row.description || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
__name(formatSecret, "formatSecret");
async function ensureDashboardAccess(env, dashboardId, userId) {
  const access = await env.DB.prepare(
    `SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?`
  ).bind(dashboardId, userId).first();
  return access ?? null;
}
__name(ensureDashboardAccess, "ensureDashboardAccess");
async function listSecrets(env, userId, dashboardId) {
  if (!dashboardId) {
    return Response.json({ error: "E79733: dashboard_id is required" }, { status: 400 });
  }
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access) {
    return Response.json({ error: "E79734: Not found or no access" }, { status: 404 });
  }
  const rows = await env.DB.prepare(
    `SELECT id, user_id, dashboard_id, name, description, created_at, updated_at
     FROM user_secrets
     WHERE user_id = ? AND dashboard_id = ?
     ORDER BY updated_at DESC`
  ).bind(userId, dashboardId).all();
  return Response.json({
    secrets: rows.results.map((row) => formatSecret(row))
  });
}
__name(listSecrets, "listSecrets");
async function createSecret(env, userId, data) {
  if (!data.dashboardId || !data.name || !data.value) {
    return Response.json({ error: "E79731: dashboard_id, name, and value are required" }, { status: 400 });
  }
  const access = await ensureDashboardAccess(env, data.dashboardId, userId);
  if (!access || access.role !== "owner" && access.role !== "editor") {
    return Response.json({ error: "E79735: Not found or no edit access" }, { status: 404 });
  }
  const id = crypto.randomUUID();
  const description = data.description || "";
  await env.DB.prepare(
    `INSERT INTO user_secrets (id, user_id, dashboard_id, name, value, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(id, userId, data.dashboardId, data.name, data.value, description).run();
  const row = await env.DB.prepare(
    `SELECT id, user_id, dashboard_id, name, description, created_at, updated_at
     FROM user_secrets WHERE id = ?`
  ).bind(id).first();
  return Response.json({ secret: formatSecret(row) });
}
__name(createSecret, "createSecret");
async function deleteSecret(env, userId, id, dashboardId) {
  if (!dashboardId) {
    return Response.json({ error: "E79736: dashboard_id is required" }, { status: 400 });
  }
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access || access.role !== "owner" && access.role !== "editor") {
    return Response.json({ error: "E79737: Not found or no edit access" }, { status: 404 });
  }
  const result = await env.DB.prepare(
    `DELETE FROM user_secrets WHERE id = ? AND user_id = ? AND dashboard_id = ?`
  ).bind(id, userId, dashboardId).run();
  if (result.meta.changes === 0) {
    return Response.json({ error: "E79732: Secret not found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
__name(deleteSecret, "deleteSecret");

// src/agent-skills/handler.ts
function safeParseJson(value, fallback) {
  if (typeof value !== "string")
    return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
__name(safeParseJson, "safeParseJson");
function formatAgentSkill(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description || "",
    command: row.command || "",
    args: safeParseJson(row.args, []),
    source: row.source || "custom",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
__name(formatAgentSkill, "formatAgentSkill");
async function listAgentSkills(env, userId) {
  const rows = await env.DB.prepare(
    `SELECT * FROM user_agent_skills WHERE user_id = ? ORDER BY updated_at DESC`
  ).bind(userId).all();
  return Response.json({
    skills: rows.results.map((row) => formatAgentSkill(row))
  });
}
__name(listAgentSkills, "listAgentSkills");
async function createAgentSkill(env, userId, data) {
  if (!data.name || !data.command) {
    return Response.json({ error: "E79723: name and command are required" }, { status: 400 });
  }
  const id = data.id || crypto.randomUUID();
  const args = JSON.stringify(data.args || []);
  const description = data.description || "";
  const source = data.source || "custom";
  await env.DB.prepare(
    `INSERT INTO user_agent_skills (id, user_id, name, description, command, args, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(id, userId, data.name, description, data.command, args, source).run();
  const row = await env.DB.prepare(`SELECT * FROM user_agent_skills WHERE id = ?`).bind(id).first();
  return Response.json({ skill: formatAgentSkill(row) });
}
__name(createAgentSkill, "createAgentSkill");
async function deleteAgentSkill(env, userId, id) {
  const result = await env.DB.prepare(
    `DELETE FROM user_agent_skills WHERE id = ? AND user_id = ?`
  ).bind(id, userId).run();
  if (result.meta.changes === 0) {
    return Response.json({ error: "E79724: Agent skill not found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
__name(deleteAgentSkill, "deleteAgentSkill");

// src/mcp-tools/handler.ts
function safeParseJson2(value, fallback) {
  if (typeof value !== "string")
    return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
__name(safeParseJson2, "safeParseJson");
function f\u043ErmatMcpT\u043E\u043El(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description || "",
    serverUrl: row.server_url || "",
    transport: row.transport || "stdio",
    config: safeParseJson2(row.config, {}),
    source: row.source || "custom",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
__name(f\u043ErmatMcpT\u043E\u043El, "f\u043ErmatMcpT\u043E\u043El");
async function listMcpT\u043E\u043Els(env, userId) {
  const rows = await env.DB.prepare(
    `SELECT * FROM user_mcp_tools WHERE user_id = ? ORDER BY updated_at DESC`
  ).bind(userId).all();
  return Response.json({
    tools: rows.results.map((row) => f\u043ErmatMcpT\u043E\u043El(row))
  });
}
__name(listMcpT\u043E\u043Els, "listMcpT\u043E\u043Els");
async function createMcpT\u043E\u043El(env, userId, data) {
  if (!data.name || !data.serverUrl) {
    return Response.json({ error: "E79101: name and serverUrl are required" }, { status: 400 });
  }
  const validTransports = ["stdio", "sse", "streamable-http"];
  const transport = data.transport || "stdio";
  if (!validTransports.includes(transport)) {
    return Response.json(
      { error: `transport must be one of: ${validTransports.join(", ")}` },
      { status: 400 }
    );
  }
  const id = data.id || crypto.randomUUID();
  const config = JSON.stringify(data.config || {});
  const description = data.description || "";
  const source = data.source || "custom";
  await env.DB.prepare(
    `INSERT INTO user_mcp_tools (id, user_id, name, description, server_url, transport, config, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(id, userId, data.name, description, data.serverUrl, transport, config, source).run();
  const row = await env.DB.prepare(`SELECT * FROM user_mcp_tools WHERE id = ?`).bind(id).first();
  return Response.json({ tool: f\u043ErmatMcpT\u043E\u043El(row) });
}
__name(createMcpT\u043E\u043El, "createMcpT\u043E\u043El");
async function deleteMcpT\u043E\u043El(env, userId, id) {
  const result = await env.DB.prepare(
    `DELETE FROM user_mcp_tools WHERE id = ? AND user_id = ?`
  ).bind(id, userId).run();
  if (result.meta.changes === 0) {
    return Response.json({ error: "E79102: MCP tool not found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
__name(deleteMcpT\u043E\u043El, "deleteMcpT\u043E\u043El");

// src/integrations/handler.ts
var GOOGLE_SCOPE = [
  "https://www.googleapis.com/auth/drive"
];
var GITHUB_SCOPE = [
  "repo",
  "read:user",
  "user:email"
];
var BOX_SCOPE = [
  "root_readonly"
];
var ONEDRIVE_SCOPE = [
  "offline_access",
  "Files.Read"
];
var DRIVE_AUTO_SYNC_LIMIT_BYTES = 1024 * 1024 * 1024;
var DRIVE_MANIFEST_VERSION = 1;
var DRIVE_UPLOAD_BUFFER_LIMIT_BYTES = 25 * 1024 * 1024;
var DRIVE_UPLOAD_PART_BYTES = 8 * 1024 * 1024;
function concatBytes(left, right) {
  const next = new Uint8Array(left.length + right.length);
  next.set(left);
  next.set(right, left.length);
  return next;
}
__name(concatBytes, "concatBytes");
async function uploadDriveFileToCache(env, key, response, size) {
  if (!response.body) {
    throw new Error("Drive download missing body");
  }
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  if (size <= DRIVE_UPLOAD_BUFFER_LIMIT_BYTES) {
    const buffer2 = await response.arrayBuffer();
    await env.DRIVE_CACHE.put(key, buffer2, {
      httpMetadata: { contentType }
    });
    return;
  }
  const upload = await env.DRIVE_CACHE.createMultipartUpload(key, {
    httpMetadata: { contentType }
  });
  const parts = [];
  const reader = response.body.getReader();
  let buffer = new Uint8Array(0);
  let partNumber = 1;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done)
        break;
      if (value) {
        buffer = concatBytes(buffer, value);
      }
      while (buffer.length >= DRIVE_UPLOAD_PART_BYTES) {
        const chunk = buffer.slice(0, DRIVE_UPLOAD_PART_BYTES);
        const uploaded = await upload.uploadPart(partNumber, chunk);
        parts.push({ partNumber, etag: uploaded.etag });
        buffer = buffer.slice(DRIVE_UPLOAD_PART_BYTES);
        partNumber += 1;
      }
    }
    if (buffer.length > 0) {
      const uploaded = await upload.uploadPart(partNumber, buffer);
      parts.push({ partNumber, etag: uploaded.etag });
    }
    await upload.complete(parts);
  } catch (error) {
    try {
      await upload.abort();
    } catch {
    }
    throw error;
  }
}
__name(uploadDriveFileToCache, "uploadDriveFileToCache");
function getRedirectBase(request, env) {
  if (env.OAUTH_REDIRECT_BASE) {
    return env.OAUTH_REDIRECT_BASE.replace(/\/$/, "");
  }
  return new URL(request.url).origin;
}
__name(getRedirectBase, "getRedirectBase");
function sanitizePathSegment(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Drive";
  }
  return trimmed.replace(/[\\/]/g, "-");
}
__name(sanitizePathSegment, "sanitizePathSegment");
function driveManifestKey2(dashboardId) {
  return `drive/${dashboardId}/manifest.json`;
}
__name(driveManifestKey2, "driveManifestKey");
function driveFileKey(dashboardId, fileId) {
  return `drive/${dashboardId}/files/${fileId}`;
}
__name(driveFileKey, "driveFileKey");
function mirrorManifestKey2(provider, dashboardId) {
  return `mirror/${provider}/${dashboardId}/manifest.json`;
}
__name(mirrorManifestKey2, "mirrorManifestKey");
function mirrorFileKey(provider, dashboardId, fileId) {
  return `mirror/${provider}/${dashboardId}/files/${fileId}`;
}
__name(mirrorFileKey, "mirrorFileKey");
function escapeHtml(unsafe) {
  return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
__name(escapeHtml, "escapeHtml");
function buildState() {
  return crypto.randomUUID();
}
__name(buildState, "buildState");
async function createState(env, userId, provider, state, metadata = {}) {
  await env.DB.prepare(`
    INSERT INTO oauth_states (state, user_id, provider, metadata)
    VALUES (?, ?, ?, ?)
  `).bind(state, userId, provider, JSON.stringify(metadata)).run();
}
__name(createState, "createState");
async function consumeState(env, state, provider) {
  const record = await env.DB.prepare(`
    SELECT user_id as userId, metadata FROM oauth_states WHERE state = ? AND provider = ?
  `).bind(state, provider).first();
  if (!record) {
    return null;
  }
  await env.DB.prepare(`
    DELETE FROM oauth_states WHERE state = ?
  `).bind(state).run();
  let metadata = {};
  try {
    metadata = JSON.parse(record.metadata || "{}");
  } catch {
    metadata = {};
  }
  return { userId: record.userId, metadata };
}
__name(consumeState, "consumeState");
async function refreshGoogleAccessToken(env, userId) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth is not configured.");
  }
  const record = await env.DB.prepare(`
    SELECT access_token, refresh_token FROM user_integrations
    WHERE user_id = ? AND provider = 'google_drive'
  `).bind(userId).first();
  if (!record?.refresh_token) {
    throw new Error("Google Drive must be connected again.");
  }
  const body = new URLSearchParams();
  body.set("client_id", env.GOOGLE_CLIENT_ID);
  body.set("client_secret", env.GOOGLE_CLIENT_SECRET);
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", record.refresh_token);
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!tokenResponse.ok) {
    throw new Error("Failed to refresh Google access token.");
  }
  const tokenData = await tokenResponse.json();
  const now = /* @__PURE__ */ new Date();
  const expiresAt = tokenData.expires_in ? new Date(now.getTime() + tokenData.expires_in * 1e3).toISOString() : null;
  await env.DB.prepare(`
    UPDATE user_integrations
    SET access_token = ?, scope = ?, token_type = ?, expires_at = ?, updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'google_drive'
  `).bind(
    tokenData.access_token,
    tokenData.scope || null,
    tokenData.token_type || null,
    expiresAt,
    userId
  ).run();
  return tokenData.access_token;
}
__name(refreshGoogleAccessToken, "refreshGoogleAccessToken");
async function refreshBoxAccessToken(env, userId) {
  if (!env.BOX_CLIENT_ID || !env.BOX_CLIENT_SECRET) {
    throw new Error("Box OAuth is not configured.");
  }
  const record = await env.DB.prepare(`
    SELECT access_token, refresh_token FROM user_integrations
    WHERE user_id = ? AND provider = 'box'
  `).bind(userId).first();
  if (!record?.refresh_token) {
    throw new Error("Box must be connected again.");
  }
  const body = new URLSearchParams();
  body.set("client_id", env.BOX_CLIENT_ID);
  body.set("client_secret", env.BOX_CLIENT_SECRET);
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", record.refresh_token);
  const tokenResponse = await fetch("https://api.box.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!tokenResponse.ok) {
    throw new Error("Failed to refresh Box access token.");
  }
  const tokenData = await tokenResponse.json();
  const now = /* @__PURE__ */ new Date();
  const expiresAt = tokenData.expires_in ? new Date(now.getTime() + tokenData.expires_in * 1e3).toISOString() : null;
  await env.DB.prepare(`
    UPDATE user_integrations
    SET access_token = ?, refresh_token = ?, token_type = ?, expires_at = ?, updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'box'
  `).bind(
    tokenData.access_token,
    tokenData.refresh_token || record.refresh_token,
    tokenData.token_type || null,
    expiresAt,
    userId
  ).run();
  return tokenData.access_token;
}
__name(refreshBoxAccessToken, "refreshBoxAccessToken");
async function refreshOnedriveAccessToken(env, userId) {
  if (!env.ONEDRIVE_CLIENT_ID || !env.ONEDRIVE_CLIENT_SECRET) {
    throw new Error("OneDrive OAuth is not configured.");
  }
  const record = await env.DB.prepare(`
    SELECT access_token, refresh_token FROM user_integrations
    WHERE user_id = ? AND provider = 'onedrive'
  `).bind(userId).first();
  if (!record?.refresh_token) {
    throw new Error("OneDrive must be connected again.");
  }
  const body = new URLSearchParams();
  body.set("client_id", env.ONEDRIVE_CLIENT_ID);
  body.set("client_secret", env.ONEDRIVE_CLIENT_SECRET);
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", record.refresh_token);
  body.set("scope", ONEDRIVE_SCOPE.join(" "));
  const tokenResponse = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!tokenResponse.ok) {
    throw new Error("Failed to refresh OneDrive access token.");
  }
  const tokenData = await tokenResponse.json();
  const now = /* @__PURE__ */ new Date();
  const expiresAt = tokenData.expires_in ? new Date(now.getTime() + tokenData.expires_in * 1e3).toISOString() : null;
  await env.DB.prepare(`
    UPDATE user_integrations
    SET access_token = ?, refresh_token = ?, token_type = ?, expires_at = ?, updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'onedrive'
  `).bind(
    tokenData.access_token,
    tokenData.refresh_token || record.refresh_token,
    tokenData.token_type || null,
    expiresAt,
    userId
  ).run();
  return tokenData.access_token;
}
__name(refreshOnedriveAccessToken, "refreshOnedriveAccessToken");
function joinDrivePath(parent, name) {
  if (!parent)
    return name;
  return `${parent}/${name}`;
}
__name(joinDrivePath, "joinDrivePath");
async function listDriveChildren(accessToken, folderId) {
  const files = [];
  let pageToken = null;
  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", `'${folderId}' in parents and trashed = false`);
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum)");
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) {
      throw new Error("Failed to list Google Drive folder.");
    }
    const data = await res.json();
    if (data.files) {
      files.push(...data.files);
    }
    pageToken = data.nextPageToken ?? null;
  } while (pageToken);
  return files;
}
__name(listDriveChildren, "listDriveChildren");
async function buildDriveManifest(accessToken, folderId, folderName) {
  const queue = [{ id: folderId, path: "" }];
  const entries = [];
  const directories = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current.path) {
      directories.push(current.path);
    }
    const children = await listDriveChildren(accessToken, current.id);
    for (const child of children) {
      if (child.mimeType === "application/vnd.google-apps.folder") {
        queue.push({ id: child.id, path: joinDrivePath(current.path, child.name) });
        continue;
      }
      const size = child.size ? Number(child.size) : 0;
      entries.push({
        id: child.id,
        name: child.name,
        path: joinDrivePath(current.path, child.name),
        mimeType: child.mimeType,
        size: Number.isNaN(size) ? 0 : size,
        modifiedTime: child.modifiedTime || null,
        md5Checksum: child.md5Checksum || null,
        cacheStatus: "cached"
      });
    }
  }
  const safeFolderName = sanitizePathSegment(folderName);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const manifest = {
    version: DRIVE_MANIFEST_VERSION,
    folderId,
    folderName,
    folderPath: `drive/${safeFolderName}`,
    updatedAt: now,
    directories,
    entries
  };
  return { manifest, entries };
}
__name(buildDriveManifest, "buildDriveManifest");
function renderSuccessPage(providerLabel) {
  const safeLabel = escapeHtml(providerLabel);
  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${safeLabel} connected</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 32px; }
      .card { max-width: 520px; margin: 0 auto; }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p { margin: 0 0 16px; color: #4b5563; }
      button { padding: 8px 12px; border: 1px solid #e5e7eb; border-radius: 6px; background: #111827; color: #fff; cursor: pointer; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${safeLabel} connected</h1>
      <p>You can close this tab and return to OrcaBot.</p>
      <button onclick="window.close()">Close tab</button>
    </div>
  </body>
</html>`,
    {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    }
  );
}
__name(renderSuccessPage, "renderSuccessPage");
function renderDrivePickerPage(accessToken, apiKey, frontendUrl, dashboardId) {
  const tokenJson = JSON.stringify(accessToken);
  const apiKeyJson = JSON.stringify(apiKey);
  const frontendJson = JSON.stringify(frontendUrl);
  const dashboardJson = JSON.stringify(dashboardId);
  const frontendOrigin = new URL(frontendUrl).origin;
  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Google Drive connected</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 32px; }
      .card { max-width: 520px; margin: 0 auto; }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p { margin: 0 0 16px; color: #4b5563; }
      button { padding: 8px 12px; border: 1px solid #e5e7eb; border-radius: 6px; background: #111827; color: #fff; cursor: pointer; }
      .status { font-size: 12px; margin-top: 12px; color: #6b7280; }
    </style>
    <script src="https://apis.google.com/js/api.js"><\/script>
  </head>
  <body>
    <div class="card">
      <h1>Google Drive connected</h1>
      <p>Select a Drive folder to link to OrcaBot.</p>
      <button id="picker-button" type="button">Select Drive folder</button>
      <div class="status" id="status">Loading Google Picker...</div>
    </div>
    <script>
      const accessToken = ${tokenJson};
      const apiKey = ${apiKeyJson};
      const dashboardId = ${dashboardJson};
      const statusEl = document.getElementById('status');
      const frontendUrl = ${frontendJson};
      const frontendOrigin = ${JSON.stringify(frontendOrigin)};
      const buttonEl = document.getElementById('picker-button');
      let pickerLoaded = false;

      function setStatus(message) {
        if (statusEl) statusEl.textContent = message;
      }

      function onPickerReady() {
        pickerLoaded = true;
        openPicker();
      }

      function openPicker() {
        if (!pickerLoaded) {
          setStatus('Google Picker failed to load.');
          return;
        }
        const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
          .setIncludeFolders(true)
          .setSelectFolderEnabled(true);
        const picker = new google.picker.PickerBuilder()
          .addView(view)
          .setOAuthToken(accessToken)
          .setDeveloperKey(apiKey)
          .setOrigin(frontendOrigin)
          .setCallback(pickerCallback)
          .build();
        picker.setVisible(true);
      }

      function pickerCallback(data) {
        if (data.action !== google.picker.Action.PICKED) {
          if (data.action === google.picker.Action.CANCEL) {
            setStatus('Folder selection canceled.');
          }
          return;
        }

        const doc = data.docs && data.docs[0];
        if (!doc) {
          setStatus('No folder selected.');
          return;
        }

        const payload = {
          folderId: doc.id,
          folderName: doc.name || doc.title || 'Untitled folder',
          dashboardId: dashboardId,
        };

        setStatus('Saving folder selection...');
        fetch('/integrations/google/drive/folder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload),
        })
          .then(async (response) => {
            if (!response.ok) {
              const errorText = await response.text();
              throw new Error(errorText || 'Failed to save selection.');
            }
            return response.json();
          })
          .then(() => {
            try {
              const targetWindow = window.opener || (window.parent !== window ? window.parent : null);
              if (targetWindow) {
                targetWindow.postMessage({ type: 'drive-linked', folder: payload }, frontendOrigin);
              }
            } catch {}
            setStatus('Folder linked. Returning to OrcaBot...');
            if (window.opener) {
              setTimeout(() => window.close(), 400);
            } else if (window.parent === window) {
              setTimeout(() => window.location.assign(frontendUrl), 600);
            }
          })
          .catch((error) => {
            setStatus(error.message || 'Failed to save selection.');
          });
      }

      function onApiLoad() {
        if (!window.gapi || !window.gapi.load) {
          setStatus('Failed to load Google Picker API.');
          return;
        }
        window.gapi.load('picker', { callback: onPickerReady });
      }

      if (window.gapi && window.gapi.load) {
        onApiLoad();
      } else {
        window.addEventListener('load', onApiLoad);
      }

      if (buttonEl) {
        buttonEl.addEventListener('click', () => {
          if (!pickerLoaded) {
            setStatus('Loading Google Picker...');
            return;
          }
          openPicker();
        });
      }
    <\/script>
  </body>
</html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `frame-ancestors ${frontendOrigin}`
      }
    }
  );
}
__name(renderDrivePickerPage, "renderDrivePickerPage");
function renderErrorPage(message) {
  const safeMessage = escapeHtml(message);
  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Connection failed</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 32px; }
      .card { max-width: 520px; margin: 0 auto; }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p { margin: 0 0 16px; color: #b91c1c; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Connection failed</h1>
      <p>${safeMessage}</p>
    </div>
  </body>
</html>`,
    {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    }
  );
}
__name(renderErrorPage, "renderErrorPage");
function renderDriveAuthCompletePage(frontendUrl, dashboardId) {
  const frontendOrigin = new URL(frontendUrl).origin;
  const payload = JSON.stringify({ type: "drive-auth-complete", dashboardId });
  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Drive connected</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 32px; }
      .card { max-width: 520px; margin: 0 auto; text-align: center; }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p { margin: 0 0 16px; color: #4b5563; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Google Drive connected</h1>
      <p>You can return to OrcaBot.</p>
    </div>
    <script>
      try {
        if (window.opener) {
          window.opener.postMessage(${payload}, ${JSON.stringify(frontendOrigin)});
        }
      } catch {}
      setTimeout(() => window.close(), 200);
    <\/script>
  </body>
</html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `frame-ancestors ${frontendOrigin}`
      }
    }
  );
}
__name(renderDriveAuthCompletePage, "renderDriveAuthCompletePage");
function renderProviderAuthCompletePage(frontendUrl, providerLabel, messageType, dashboardId) {
  const frontendOrigin = new URL(frontendUrl).origin;
  const payload = JSON.stringify({ type: messageType, dashboardId });
  const safeLabel = escapeHtml(providerLabel);
  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${safeLabel} connected</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 32px; }
      .card { max-width: 520px; margin: 0 auto; text-align: center; }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p { margin: 0 0 16px; color: #4b5563; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${safeLabel} connected</h1>
      <p>You can return to OrcaBot.</p>
    </div>
    <script>
      try {
        if (window.opener) {
          window.opener.postMessage(${payload}, ${JSON.stringify(frontendOrigin)});
        }
      } catch {}
      setTimeout(() => window.close(), 200);
    <\/script>
  </body>
</html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `frame-ancestors ${frontendOrigin}`
      }
    }
  );
}
__name(renderProviderAuthCompletePage, "renderProviderAuthCompletePage");
async function c\u043EnnectG\u043E\u043EgleDrive(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return renderErrorPage("Google OAuth is not configured.");
  }
  const state = buildState();
  const requestUrl = new URL(request.url);
  const dashboardId = requestUrl.searchParams.get("dashboard_id");
  const mode = requestUrl.searchParams.get("mode");
  await createState(env, auth.user.id, "google_drive", state, {
    dashboard_id: dashboardId,
    popup: mode === "popup"
  });
  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/drive/callback`;
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_SCOPE.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("state", state);
  return Response.redirect(authUrl.toString(), 302);
}
__name(c\u043EnnectG\u043E\u043EgleDrive, "c\u043EnnectG\u043E\u043EgleDrive");
async function callbackG\u043E\u043EgleDrive(request, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return renderErrorPage("Google OAuth is not configured.");
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return renderErrorPage("Missing authorization code.");
  }
  const stateData = await consumeState(env, state, "google_drive");
  if (!stateData) {
    return renderErrorPage("Invalid or expired state.");
  }
  const dashboardId = typeof stateData.metadata.dashboard_id === "string" ? stateData.metadata.dashboard_id : null;
  const popup = stateData.metadata.popup === true;
  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/drive/callback`;
  const body = new URLSearchParams();
  body.set("client_id", env.GOOGLE_CLIENT_ID);
  body.set("client_secret", env.GOOGLE_CLIENT_SECRET);
  body.set("code", code);
  body.set("grant_type", "authorization_code");
  body.set("redirect_uri", redirectUri);
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!tokenResponse.ok) {
    return renderErrorPage("Failed to exchange token.");
  }
  const tokenData = await tokenResponse.json();
  const now = /* @__PURE__ */ new Date();
  const expiresAt = tokenData.expires_in ? new Date(now.getTime() + tokenData.expires_in * 1e3).toISOString() : null;
  const metadata = JSON.stringify({
    scope: tokenData.scope,
    token_type: tokenData.token_type
  });
  await env.DB.prepare(`
    INSERT INTO user_integrations (
      id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata
    ) VALUES (?, ?, 'google_drive', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      scope = excluded.scope,
      token_type = excluded.token_type,
      expires_at = excluded.expires_at,
      metadata = excluded.metadata,
      updated_at = datetime('now')
  `).bind(
    crypto.randomUUID(),
    stateData.userId,
    tokenData.access_token,
    tokenData.refresh_token || null,
    tokenData.scope || null,
    tokenData.token_type || null,
    expiresAt,
    metadata
  ).run();
  if (popup) {
    const frontendUrl2 = env.FRONTEND_URL || "https://orcabot.com";
    return renderDriveAuthCompletePage(frontendUrl2, dashboardId);
  }
  if (!env.GOOGLE_API_KEY) {
    return renderErrorPage("Google API key is not configured.");
  }
  const frontendUrl = env.FRONTEND_URL || "https://orcabot.com";
  return renderDrivePickerPage(tokenData.access_token, env.GOOGLE_API_KEY, frontendUrl, dashboardId);
}
__name(callbackG\u043E\u043EgleDrive, "callbackG\u043E\u043EgleDrive");
async function setG\u043E\u043EgleDriveF\u043Elder(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.folderId) {
    return Response.json({ error: "E79821: folderId is required" }, { status: 400 });
  }
  if (!data.dashboardId) {
    return Response.json({ error: "E79824: dashboardId is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79823: Not found or no access" }, { status: 404 });
  }
  const record = await env.DB.prepare(`
    SELECT metadata FROM user_integrations
    WHERE user_id = ? AND provider = 'google_drive'
  `).bind(auth.user.id).first();
  if (!record) {
    return Response.json({ error: "E79822: Google Drive not connected" }, { status: 404 });
  }
  let metadata = {};
  try {
    metadata = JSON.parse(record.metadata || "{}");
  } catch {
    metadata = {};
  }
  metadata.drive_folder = {
    id: data.folderId,
    name: data.folderName || "",
    linked_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  await env.DB.prepare(`
    UPDATE user_integrations
    SET metadata = ?, updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'google_drive'
  `).bind(JSON.stringify(metadata), auth.user.id).run();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare(`
    INSERT INTO drive_mirrors (
      dashboard_id, user_id, folder_id, folder_name, status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, 'idle', ?, ?)
    ON CONFLICT(dashboard_id) DO UPDATE SET
      user_id = excluded.user_id,
      folder_id = excluded.folder_id,
      folder_name = excluded.folder_name,
      status = 'idle',
      total_files = 0,
      total_bytes = 0,
      cache_synced_files = 0,
      cache_synced_bytes = 0,
      workspace_synced_files = 0,
      workspace_synced_bytes = 0,
      large_files = 0,
      large_bytes = 0,
      last_sync_at = null,
      sync_error = null,
      updated_at = excluded.updated_at
  `).bind(
    data.dashboardId,
    auth.user.id,
    data.folderId,
    data.folderName || "",
    now,
    now
  ).run();
  try {
    await runDriveSync(env, auth.user.id, data.dashboardId);
  } catch {
  }
  return Response.json({ ok: true });
}
__name(setG\u043E\u043EgleDriveF\u043Elder, "setG\u043E\u043EgleDriveF\u043Elder");
async function getGithubIntegrati\u043En(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  const integration = await env.DB.prepare(`
    SELECT 1 FROM user_integrations WHERE user_id = ? AND provider = 'github'
  `).bind(auth.user.id).first();
  if (!integration) {
    return Response.json({ connected: false, linked: false, repo: null });
  }
  if (!dashboardId) {
    return Response.json({ connected: true, linked: false, repo: null });
  }
  const mirror = await env.DB.prepare(`
    SELECT repo_id, repo_owner, repo_name, repo_branch, updated_at
    FROM github_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!mirror) {
    return Response.json({ connected: true, linked: false, repo: null });
  }
  return Response.json({
    connected: true,
    linked: true,
    repo: {
      id: mirror.repo_id,
      owner: mirror.repo_owner,
      name: mirror.repo_name,
      branch: mirror.repo_branch,
      linked_at: mirror.updated_at
    }
  });
}
__name(getGithubIntegrati\u043En, "getGithubIntegrati\u043En");
async function getGithubRep\u043Es(_request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  try {
    const accessToken = await getGithubAccessToken(env, auth.user.id);
    const repos = await listGithubRepos(accessToken);
    return Response.json({
      connected: true,
      repos: repos.map((repo) => ({
        id: repo.id,
        owner: repo.owner.login,
        name: repo.name,
        fullName: repo.full_name,
        branch: repo.default_branch,
        private: repo.private
      }))
    });
  } catch {
    return Response.json({ connected: false, repos: [] });
  }
}
__name(getGithubRep\u043Es, "getGithubRep\u043Es");
async function setGithubRep\u043E(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId || !data.repoOwner || !data.repoName) {
    return Response.json({ error: "E79840: dashboardId and repo are required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79841: Not found or no access" }, { status: 404 });
  }
  const accessToken = await getGithubAccessToken(env, auth.user.id);
  let branch = data.repoBranch;
  if (!branch) {
    const repoRes = await fetch(`https://api.github.com/repos/${data.repoOwner}/${data.repoName}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "OrcaBot",
        Accept: "application/vnd.github+json"
      }
    });
    if (!repoRes.ok) {
      return Response.json({ error: "E79842: Failed to read repo metadata" }, { status: 400 });
    }
    const repoData = await repoRes.json();
    branch = repoData.default_branch || "main";
  }
  await env.DB.prepare(`
    INSERT INTO github_mirrors (
      dashboard_id, user_id, repo_id, repo_owner, repo_name, repo_branch, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'idle', datetime('now'), datetime('now'))
    ON CONFLICT(dashboard_id) DO UPDATE SET
      user_id = excluded.user_id,
      repo_id = excluded.repo_id,
      repo_owner = excluded.repo_owner,
      repo_name = excluded.repo_name,
      repo_branch = excluded.repo_branch,
      status = 'idle',
      updated_at = datetime('now')
  `).bind(
    data.dashboardId,
    auth.user.id,
    String(data.repoId || `${data.repoOwner}/${data.repoName}`),
    data.repoOwner,
    data.repoName,
    branch
  ).run();
  try {
    await runGithubSync(env, auth.user.id, data.dashboardId);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "E79843: GitHub sync failed" }, { status: 500 });
  }
  return Response.json({ ok: true });
}
__name(setGithubRep\u043E, "setGithubRep\u043E");
async function unlinkGithubRep\u043E(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "E79844: dashboardId is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79845: Not found or no access" }, { status: 404 });
  }
  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey2("github", dashboardId));
  if (manifestObject) {
    const manifest = await manifestObject.json();
    await env.DRIVE_CACHE.delete(mirrorManifestKey2("github", dashboardId));
    for (const entry of manifest.entries) {
      await env.DRIVE_CACHE.delete(mirrorFileKey("github", dashboardId, entry.id));
    }
  }
  await env.DB.prepare(`
    DELETE FROM github_mirrors WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).run();
  return Response.json({ ok: true });
}
__name(unlinkGithubRep\u043E, "unlinkGithubRep\u043E");
async function updateGithubMirrorCacheProgress(env, dashboardId, cacheSyncedFiles, cacheSyncedBytes) {
  await env.DB.prepare(`
    UPDATE github_mirrors
    SET cache_synced_files = ?, cache_synced_bytes = ?, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(cacheSyncedFiles, cacheSyncedBytes, dashboardId).run();
}
__name(updateGithubMirrorCacheProgress, "updateGithubMirrorCacheProgress");
async function getGithubSyncStatus(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "E79846: dashboardId is required" }, { status: 400 });
  }
  const record = await env.DB.prepare(`
    SELECT * FROM github_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!record) {
    return Response.json({ connected: false });
  }
  let largeFiles = [];
  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey2("github", dashboardId));
  if (manifestObject) {
    const manifest = await manifestObject.json();
    largeFiles = manifest.entries.filter((entry) => entry.cacheStatus === "skipped_large").map((entry) => ({ id: entry.id, path: entry.path, size: entry.size })).sort((a, b) => b.size - a.size);
  }
  return Response.json({
    connected: true,
    repo: {
      id: record.repo_id,
      owner: record.repo_owner,
      name: record.repo_name,
      branch: record.repo_branch
    },
    status: record.status,
    totalFiles: record.total_files,
    totalBytes: record.total_bytes,
    cacheSyncedFiles: record.cache_synced_files,
    cacheSyncedBytes: record.cache_synced_bytes,
    workspaceSyncedFiles: record.workspace_synced_files,
    workspaceSyncedBytes: record.workspace_synced_bytes,
    largeFiles,
    lastSyncAt: record.last_sync_at,
    syncError: record.sync_error
  });
}
__name(getGithubSyncStatus, "getGithubSyncStatus");
async function syncGithubMirr\u043Er(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId) {
    return Response.json({ error: "E79847: dashboardId is required" }, { status: 400 });
  }
  try {
    await runGithubSync(env, auth.user.id, data.dashboardId);
    return Response.json({ ok: true });
  } catch (error) {
    await env.DB.prepare(`
      UPDATE github_mirrors
      SET status = 'error', sync_error = ?, updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(
      error instanceof Error ? error.message : "GitHub sync failed",
      data.dashboardId
    ).run();
    return Response.json({ error: "E79848: GitHub sync failed" }, { status: 500 });
  }
}
__name(syncGithubMirr\u043Er, "syncGithubMirr\u043Er");
async function runGithubSync(env, userId, dashboardId) {
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, userId).first();
  if (!access) {
    throw new Error("E79849: Not found or no access");
  }
  const mirror = await env.DB.prepare(`
    SELECT repo_id, repo_owner, repo_name, repo_branch FROM github_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first();
  if (!mirror) {
    throw new Error("E79850: GitHub repo not linked");
  }
  await env.DB.prepare(`
    UPDATE github_mirrors
    SET status = 'syncing_cache',
        sync_error = null,
        total_files = 0,
        total_bytes = 0,
        cache_synced_files = 0,
        cache_synced_bytes = 0,
        workspace_synced_files = 0,
        workspace_synced_bytes = 0,
        large_files = 0,
        large_bytes = 0,
        updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(dashboardId).run();
  const accessToken = await getGithubAccessToken(env, userId);
  const { manifest, entries } = await buildGithubManifest(
    accessToken,
    mirror.repo_owner,
    mirror.repo_name,
    mirror.repo_branch
  );
  const existingManifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey2("github", dashboardId));
  const existingEntries = /* @__PURE__ */ new Map();
  if (existingManifestObject) {
    const existingManifest = await existingManifestObject.json();
    for (const entry of existingManifest.entries) {
      existingEntries.set(entry.id, entry);
    }
  }
  let totalFiles = 0;
  let totalBytes = 0;
  let cacheSyncedFiles = 0;
  let cacheSyncedBytes = 0;
  let largeFiles = 0;
  let largeBytes = 0;
  for (const entry of entries) {
    totalFiles += 1;
    totalBytes += entry.size;
    if (entry.size >= DRIVE_AUTO_SYNC_LIMIT_BYTES) {
      entry.cacheStatus = "skipped_large";
      entry.placeholder = "File exceeds sync limit. Click Sync to fetch it.";
      largeFiles += 1;
      largeBytes += entry.size;
      continue;
    }
    const previous = existingEntries.get(entry.id);
    if (previous && previous.md5Checksum && previous.md5Checksum === entry.md5Checksum) {
      entry.cacheStatus = previous.cacheStatus;
      if (entry.cacheStatus === "cached") {
        cacheSyncedFiles += 1;
        cacheSyncedBytes += entry.size;
      }
      continue;
    }
    const fileRes = await fetch(`https://api.github.com/repos/${mirror.repo_owner}/${mirror.repo_name}/contents/${entry.path}?ref=${mirror.repo_branch}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "OrcaBot",
        Accept: "application/vnd.github.raw"
      }
    });
    if (!fileRes.ok || !fileRes.body) {
      entry.cacheStatus = "skipped_unsupported";
      entry.placeholder = "Failed to download GitHub file.";
      continue;
    }
    await uploadDriveFileToCache(env, mirrorFileKey("github", dashboardId, entry.id), fileRes, entry.size);
    cacheSyncedFiles += 1;
    cacheSyncedBytes += entry.size;
    entry.cacheStatus = "cached";
    await updateGithubMirrorCacheProgress(env, dashboardId, cacheSyncedFiles, cacheSyncedBytes);
  }
  manifest.entries = entries;
  await env.DRIVE_CACHE.put(mirrorManifestKey2("github", dashboardId), JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" }
  });
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare(`
    UPDATE github_mirrors
    SET status = 'syncing_workspace',
        total_files = ?,
        total_bytes = ?,
        cache_synced_files = ?,
        cache_synced_bytes = ?,
        large_files = ?,
        large_bytes = ?,
        last_sync_at = ?,
        updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(
    totalFiles,
    totalBytes,
    cacheSyncedFiles,
    cacheSyncedBytes,
    largeFiles,
    largeBytes,
    now,
    dashboardId
  ).run();
  const sandboxRecord = await env.DB.prepare(`
    SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes
    WHERE dashboard_id = ?
  `).bind(dashboardId).first();
  if (sandboxRecord?.sandbox_session_id) {
    await startSandboxMirrorSync(
      env,
      "github",
      dashboardId,
      sandboxRecord.sandbox_session_id,
      sandboxRecord.sandbox_machine_id || "",
      `${mirror.repo_owner}/${mirror.repo_name}`
    );
  } else {
    await env.DB.prepare(`
      UPDATE github_mirrors
      SET status = 'ready',
          updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(dashboardId).run();
  }
}
__name(runGithubSync, "runGithubSync");
async function syncGithubLargeFiles(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId || !Array.isArray(data.fileIds) || data.fileIds.length === 0) {
    return Response.json({ error: "E79851: dashboardId and fileIds are required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79852: Not found or no access" }, { status: 404 });
  }
  const mirror = await env.DB.prepare(`
    SELECT repo_owner, repo_name, repo_branch FROM github_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(data.dashboardId, auth.user.id).first();
  if (!mirror) {
    return Response.json({ error: "E79853: GitHub repo not linked" }, { status: 404 });
  }
  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey2("github", data.dashboardId));
  if (!manifestObject) {
    return Response.json({ error: "E79854: GitHub manifest missing. Run sync first." }, { status: 404 });
  }
  const manifest = await manifestObject.json();
  const entryMap = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const accessToken = await getGithubAccessToken(env, auth.user.id);
  let cacheSyncedFiles = 0;
  let cacheSyncedBytes = 0;
  for (const entry of manifest.entries) {
    if (entry.cacheStatus === "cached") {
      cacheSyncedFiles += 1;
      cacheSyncedBytes += entry.size;
    }
  }
  for (const fileId of data.fileIds) {
    const entry = entryMap.get(fileId);
    if (!entry || entry.cacheStatus !== "skipped_large") {
      continue;
    }
    const fileRes = await fetch(`https://api.github.com/repos/${mirror.repo_owner}/${mirror.repo_name}/contents/${entry.path}?ref=${mirror.repo_branch}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "OrcaBot",
        Accept: "application/vnd.github.raw"
      }
    });
    if (!fileRes.ok || !fileRes.body) {
      continue;
    }
    await uploadDriveFileToCache(env, mirrorFileKey("github", data.dashboardId, entry.id), fileRes, entry.size);
    entry.cacheStatus = "cached";
    entry.placeholder = void 0;
    cacheSyncedFiles += 1;
    cacheSyncedBytes += entry.size;
    await updateGithubMirrorCacheProgress(env, data.dashboardId, cacheSyncedFiles, cacheSyncedBytes);
  }
  await env.DRIVE_CACHE.put(mirrorManifestKey2("github", data.dashboardId), JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" }
  });
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare(`
    UPDATE github_mirrors
    SET status = 'syncing_workspace',
        sync_error = null,
        last_sync_at = ?,
        updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(now, data.dashboardId).run();
  const sandboxRecord = await env.DB.prepare(`
    SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes
    WHERE dashboard_id = ?
  `).bind(data.dashboardId).first();
  if (sandboxRecord?.sandbox_session_id) {
    await startSandboxMirrorSync(
      env,
      "github",
      data.dashboardId,
      sandboxRecord.sandbox_session_id,
      sandboxRecord.sandbox_machine_id || "",
      `${mirror.repo_owner}/${mirror.repo_name}`
    );
  } else {
    await env.DB.prepare(`
      UPDATE github_mirrors
      SET status = 'ready',
          updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(data.dashboardId).run();
  }
  return Response.json({ ok: true });
}
__name(syncGithubLargeFiles, "syncGithubLargeFiles");
async function getGithubManifest(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "E79855: dashboardId is required" }, { status: 400 });
  }
  const mirror = await env.DB.prepare(`
    SELECT repo_owner, repo_name FROM github_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!mirror) {
    return Response.json({ connected: false });
  }
  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey2("github", dashboardId));
  if (!manifestObject) {
    return Response.json({
      connected: true,
      repo: { owner: mirror.repo_owner, name: mirror.repo_name },
      manifest: null
    });
  }
  const manifest = await manifestObject.json();
  return Response.json({
    connected: true,
    repo: { owner: mirror.repo_owner, name: mirror.repo_name },
    manifest
  });
}
__name(getGithubManifest, "getGithubManifest");
async function getBoxAccessToken(env, userId) {
  const record = await env.DB.prepare(`
    SELECT access_token FROM user_integrations
    WHERE user_id = ? AND provider = 'box'
  `).bind(userId).first();
  if (!record?.access_token) {
    throw new Error("Box must be connected.");
  }
  return record.access_token;
}
__name(getBoxAccessToken, "getBoxAccessToken");
async function getB\u043ExIntegrati\u043En(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  const integration = await env.DB.prepare(`
    SELECT 1 FROM user_integrations WHERE user_id = ? AND provider = 'box'
  `).bind(auth.user.id).first();
  if (!integration) {
    return Response.json({ connected: false, linked: false, folder: null });
  }
  if (!dashboardId) {
    return Response.json({ connected: true, linked: false, folder: null });
  }
  const mirror = await env.DB.prepare(`
    SELECT folder_id, folder_name, updated_at
    FROM box_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!mirror) {
    return Response.json({ connected: true, linked: false, folder: null });
  }
  return Response.json({
    connected: true,
    linked: true,
    folder: {
      id: mirror.folder_id,
      name: mirror.folder_name,
      linked_at: mirror.updated_at
    }
  });
}
__name(getB\u043ExIntegrati\u043En, "getB\u043ExIntegrati\u043En");
async function getB\u043ExF\u043Elders(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const parentId = url.searchParams.get("parent_id") || "0";
  try {
    const accessToken = await getBoxAccessToken(env, auth.user.id);
    const items = await listBoxFolderItems(accessToken, parentId);
    return Response.json({
      connected: true,
      parentId,
      folders: items.filter((item) => item.type === "folder").map((item) => ({ id: item.id, name: item.name }))
    });
  } catch {
    return Response.json({ connected: false, parentId, folders: [] });
  }
}
__name(getB\u043ExF\u043Elders, "getB\u043ExF\u043Elders");
async function setB\u043ExF\u043Elder(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId || !data.folderId || !data.folderName) {
    return Response.json({ error: "E79860: dashboardId and folder are required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79861: Not found or no access" }, { status: 404 });
  }
  await env.DB.prepare(`
    INSERT INTO box_mirrors (
      dashboard_id, user_id, folder_id, folder_name, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'idle', datetime('now'), datetime('now'))
    ON CONFLICT(dashboard_id) DO UPDATE SET
      user_id = excluded.user_id,
      folder_id = excluded.folder_id,
      folder_name = excluded.folder_name,
      status = 'idle',
      updated_at = datetime('now')
  `).bind(
    data.dashboardId,
    auth.user.id,
    data.folderId,
    data.folderName
  ).run();
  try {
    await runBoxSync(env, auth.user.id, data.dashboardId);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "E79862: Box sync failed" }, { status: 500 });
  }
  return Response.json({ ok: true });
}
__name(setB\u043ExF\u043Elder, "setB\u043ExF\u043Elder");
async function unlinkB\u043ExF\u043Elder(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "E79863: dashboardId is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79864: Not found or no access" }, { status: 404 });
  }
  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey2("box", dashboardId));
  if (manifestObject) {
    const manifest = await manifestObject.json();
    await env.DRIVE_CACHE.delete(mirrorManifestKey2("box", dashboardId));
    for (const entry of manifest.entries) {
      await env.DRIVE_CACHE.delete(mirrorFileKey("box", dashboardId, entry.id));
    }
  }
  await env.DB.prepare(`
    DELETE FROM box_mirrors WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).run();
  return Response.json({ ok: true });
}
__name(unlinkB\u043ExF\u043Elder, "unlinkB\u043ExF\u043Elder");
async function updateBoxMirrorCacheProgress(env, dashboardId, cacheSyncedFiles, cacheSyncedBytes) {
  await env.DB.prepare(`
    UPDATE box_mirrors
    SET cache_synced_files = ?, cache_synced_bytes = ?, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(cacheSyncedFiles, cacheSyncedBytes, dashboardId).run();
}
__name(updateBoxMirrorCacheProgress, "updateBoxMirrorCacheProgress");
async function getB\u043ExSyncStatus(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "E79865: dashboardId is required" }, { status: 400 });
  }
  const record = await env.DB.prepare(`
    SELECT * FROM box_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!record) {
    return Response.json({ connected: false });
  }
  let largeFiles = [];
  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey2("box", dashboardId));
  if (manifestObject) {
    const manifest = await manifestObject.json();
    largeFiles = manifest.entries.filter((entry) => entry.cacheStatus === "skipped_large").map((entry) => ({ id: entry.id, path: entry.path, size: entry.size })).sort((a, b) => b.size - a.size);
  }
  return Response.json({
    connected: true,
    folder: {
      id: record.folder_id,
      name: record.folder_name
    },
    status: record.status,
    totalFiles: record.total_files,
    totalBytes: record.total_bytes,
    cacheSyncedFiles: record.cache_synced_files,
    cacheSyncedBytes: record.cache_synced_bytes,
    workspaceSyncedFiles: record.workspace_synced_files,
    workspaceSyncedBytes: record.workspace_synced_bytes,
    largeFiles,
    lastSyncAt: record.last_sync_at,
    syncError: record.sync_error
  });
}
__name(getB\u043ExSyncStatus, "getB\u043ExSyncStatus");
async function syncB\u043ExMirr\u043Er(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId) {
    return Response.json({ error: "E79866: dashboardId is required" }, { status: 400 });
  }
  try {
    await runBoxSync(env, auth.user.id, data.dashboardId);
    return Response.json({ ok: true });
  } catch (error) {
    await env.DB.prepare(`
      UPDATE box_mirrors
      SET status = 'error', sync_error = ?, updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(
      error instanceof Error ? error.message : "Box sync failed",
      data.dashboardId
    ).run();
    return Response.json({ error: "E79867: Box sync failed" }, { status: 500 });
  }
}
__name(syncB\u043ExMirr\u043Er, "syncB\u043ExMirr\u043Er");
async function runBoxSync(env, userId, dashboardId) {
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, userId).first();
  if (!access) {
    throw new Error("E79868: Not found or no access");
  }
  const mirror = await env.DB.prepare(`
    SELECT folder_id, folder_name FROM box_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first();
  if (!mirror) {
    throw new Error("E79869: Box folder not linked");
  }
  await env.DB.prepare(`
    UPDATE box_mirrors
    SET status = 'syncing_cache',
        sync_error = null,
        total_files = 0,
        total_bytes = 0,
        cache_synced_files = 0,
        cache_synced_bytes = 0,
        workspace_synced_files = 0,
        workspace_synced_bytes = 0,
        large_files = 0,
        large_bytes = 0,
        updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(dashboardId).run();
  const accessToken = await refreshBoxAccessToken(env, userId);
  const { manifest, entries } = await buildBoxManifest(accessToken, mirror.folder_id, mirror.folder_name);
  const existingManifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey2("box", dashboardId));
  const existingEntries = /* @__PURE__ */ new Map();
  if (existingManifestObject) {
    const existingManifest = await existingManifestObject.json();
    for (const entry of existingManifest.entries) {
      existingEntries.set(entry.id, entry);
    }
  }
  let totalFiles = 0;
  let totalBytes = 0;
  let cacheSyncedFiles = 0;
  let cacheSyncedBytes = 0;
  let largeFiles = 0;
  let largeBytes = 0;
  for (const entry of entries) {
    totalFiles += 1;
    totalBytes += entry.size;
    if (entry.size >= DRIVE_AUTO_SYNC_LIMIT_BYTES) {
      entry.cacheStatus = "skipped_large";
      entry.placeholder = "File exceeds sync limit. Click Sync to fetch it.";
      largeFiles += 1;
      largeBytes += entry.size;
      continue;
    }
    const previous = existingEntries.get(entry.id);
    if (previous && previous.md5Checksum && previous.md5Checksum === entry.md5Checksum) {
      entry.cacheStatus = previous.cacheStatus;
      if (entry.cacheStatus === "cached") {
        cacheSyncedFiles += 1;
        cacheSyncedBytes += entry.size;
      }
      continue;
    }
    const fileRes = await fetch(`https://api.box.com/2.0/files/${entry.id}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!fileRes.ok || !fileRes.body) {
      entry.cacheStatus = "skipped_unsupported";
      entry.placeholder = "Failed to download Box file.";
      continue;
    }
    await uploadDriveFileToCache(env, mirrorFileKey("box", dashboardId, entry.id), fileRes, entry.size);
    cacheSyncedFiles += 1;
    cacheSyncedBytes += entry.size;
    entry.cacheStatus = "cached";
    await updateBoxMirrorCacheProgress(env, dashboardId, cacheSyncedFiles, cacheSyncedBytes);
  }
  manifest.entries = entries;
  await env.DRIVE_CACHE.put(mirrorManifestKey2("box", dashboardId), JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" }
  });
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare(`
    UPDATE box_mirrors
    SET status = 'syncing_workspace',
        total_files = ?,
        total_bytes = ?,
        cache_synced_files = ?,
        cache_synced_bytes = ?,
        large_files = ?,
        large_bytes = ?,
        last_sync_at = ?,
        updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(
    totalFiles,
    totalBytes,
    cacheSyncedFiles,
    cacheSyncedBytes,
    largeFiles,
    largeBytes,
    now,
    dashboardId
  ).run();
  const sandboxRecord = await env.DB.prepare(`
    SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes
    WHERE dashboard_id = ?
  `).bind(dashboardId).first();
  if (sandboxRecord?.sandbox_session_id) {
    await startSandboxMirrorSync(
      env,
      "box",
      dashboardId,
      sandboxRecord.sandbox_session_id,
      sandboxRecord.sandbox_machine_id || "",
      mirror.folder_name
    );
  } else {
    await env.DB.prepare(`
      UPDATE box_mirrors
      SET status = 'ready',
          updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(dashboardId).run();
  }
}
__name(runBoxSync, "runBoxSync");
async function syncB\u043ExLargeFiles(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId || !Array.isArray(data.fileIds) || data.fileIds.length === 0) {
    return Response.json({ error: "E79870: dashboardId and fileIds are required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79871: Not found or no access" }, { status: 404 });
  }
  const mirror = await env.DB.prepare(`
    SELECT folder_name FROM box_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(data.dashboardId, auth.user.id).first();
  if (!mirror) {
    return Response.json({ error: "E79872: Box folder not linked" }, { status: 404 });
  }
  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey2("box", data.dashboardId));
  if (!manifestObject) {
    return Response.json({ error: "E79873: Box manifest missing. Run sync first." }, { status: 404 });
  }
  const manifest = await manifestObject.json();
  const entryMap = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const accessToken = await refreshBoxAccessToken(env, auth.user.id);
  let cacheSyncedFiles = 0;
  let cacheSyncedBytes = 0;
  for (const entry of manifest.entries) {
    if (entry.cacheStatus === "cached") {
      cacheSyncedFiles += 1;
      cacheSyncedBytes += entry.size;
    }
  }
  for (const fileId of data.fileIds) {
    const entry = entryMap.get(fileId);
    if (!entry || entry.cacheStatus !== "skipped_large") {
      continue;
    }
    const fileRes = await fetch(`https://api.box.com/2.0/files/${entry.id}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!fileRes.ok || !fileRes.body) {
      continue;
    }
    await uploadDriveFileToCache(env, mirrorFileKey("box", data.dashboardId, entry.id), fileRes, entry.size);
    entry.cacheStatus = "cached";
    entry.placeholder = void 0;
    cacheSyncedFiles += 1;
    cacheSyncedBytes += entry.size;
    await updateBoxMirrorCacheProgress(env, data.dashboardId, cacheSyncedFiles, cacheSyncedBytes);
  }
  await env.DRIVE_CACHE.put(mirrorManifestKey2("box", data.dashboardId), JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" }
  });
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare(`
    UPDATE box_mirrors
    SET status = 'syncing_workspace',
        sync_error = null,
        last_sync_at = ?,
        updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(now, data.dashboardId).run();
  const sandboxRecord = await env.DB.prepare(`
    SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes
    WHERE dashboard_id = ?
  `).bind(data.dashboardId).first();
  if (sandboxRecord?.sandbox_session_id) {
    await startSandboxMirrorSync(
      env,
      "box",
      data.dashboardId,
      sandboxRecord.sandbox_session_id,
      sandboxRecord.sandbox_machine_id || "",
      mirror.folder_name
    );
  } else {
    await env.DB.prepare(`
      UPDATE box_mirrors
      SET status = 'ready',
          updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(data.dashboardId).run();
  }
  return Response.json({ ok: true });
}
__name(syncB\u043ExLargeFiles, "syncB\u043ExLargeFiles");
async function getB\u043ExManifest(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "E79874: dashboardId is required" }, { status: 400 });
  }
  const mirror = await env.DB.prepare(`
    SELECT folder_id, folder_name FROM box_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!mirror) {
    return Response.json({ connected: false });
  }
  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey2("box", dashboardId));
  if (!manifestObject) {
    return Response.json({
      connected: true,
      folder: { id: mirror.folder_id, name: mirror.folder_name },
      manifest: null
    });
  }
  const manifest = await manifestObject.json();
  return Response.json({
    connected: true,
    folder: { id: mirror.folder_id, name: mirror.folder_name },
    manifest
  });
}
__name(getB\u043ExManifest, "getB\u043ExManifest");
async function getOnedriveAccessToken(env, userId) {
  const record = await env.DB.prepare(`
    SELECT access_token FROM user_integrations
    WHERE user_id = ? AND provider = 'onedrive'
  `).bind(userId).first();
  if (!record?.access_token) {
    throw new Error("OneDrive must be connected.");
  }
  return record.access_token;
}
__name(getOnedriveAccessToken, "getOnedriveAccessToken");
async function get\u041EnedriveIntegrati\u043En(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  const integration = await env.DB.prepare(`
    SELECT 1 FROM user_integrations WHERE user_id = ? AND provider = 'onedrive'
  `).bind(auth.user.id).first();
  if (!integration) {
    return Response.json({ connected: false, linked: false, folder: null });
  }
  if (!dashboardId) {
    return Response.json({ connected: true, linked: false, folder: null });
  }
  const mirror = await env.DB.prepare(`
    SELECT folder_id, folder_name, updated_at
    FROM onedrive_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!mirror) {
    return Response.json({ connected: true, linked: false, folder: null });
  }
  return Response.json({
    connected: true,
    linked: true,
    folder: {
      id: mirror.folder_id,
      name: mirror.folder_name,
      linked_at: mirror.updated_at
    }
  });
}
__name(get\u041EnedriveIntegrati\u043En, "get\u041EnedriveIntegrati\u043En");
async function get\u041EnedriveF\u043Elders(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const parentId = url.searchParams.get("parent_id") || "root";
  try {
    const accessToken = await getOnedriveAccessToken(env, auth.user.id);
    const items = await listOnedriveChildren(accessToken, parentId);
    return Response.json({
      connected: true,
      parentId,
      folders: items.filter((item) => item.folder).map((item) => ({ id: item.id, name: item.name }))
    });
  } catch {
    return Response.json({ connected: false, parentId, folders: [] });
  }
}
__name(get\u041EnedriveF\u043Elders, "get\u041EnedriveF\u043Elders");
async function set\u041EnedriveF\u043Elder(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId || !data.folderId || !data.folderName) {
    return Response.json({ error: "E79880: dashboardId and folder are required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79881: Not found or no access" }, { status: 404 });
  }
  await env.DB.prepare(`
    INSERT INTO onedrive_mirrors (
      dashboard_id, user_id, folder_id, folder_name, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'idle', datetime('now'), datetime('now'))
    ON CONFLICT(dashboard_id) DO UPDATE SET
      user_id = excluded.user_id,
      folder_id = excluded.folder_id,
      folder_name = excluded.folder_name,
      status = 'idle',
      updated_at = datetime('now')
  `).bind(
    data.dashboardId,
    auth.user.id,
    data.folderId,
    data.folderName
  ).run();
  try {
    await runOnedriveSync(env, auth.user.id, data.dashboardId);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "E79882: OneDrive sync failed" }, { status: 500 });
  }
  return Response.json({ ok: true });
}
__name(set\u041EnedriveF\u043Elder, "set\u041EnedriveF\u043Elder");
async function unlink\u041EnedriveF\u043Elder(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "E79883: dashboardId is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79884: Not found or no access" }, { status: 404 });
  }
  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey2("onedrive", dashboardId));
  if (manifestObject) {
    const manifest = await manifestObject.json();
    await env.DRIVE_CACHE.delete(mirrorManifestKey2("onedrive", dashboardId));
    for (const entry of manifest.entries) {
      await env.DRIVE_CACHE.delete(mirrorFileKey("onedrive", dashboardId, entry.id));
    }
  }
  await env.DB.prepare(`
    DELETE FROM onedrive_mirrors WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).run();
  return Response.json({ ok: true });
}
__name(unlink\u041EnedriveF\u043Elder, "unlink\u041EnedriveF\u043Elder");
async function updateOnedriveMirrorCacheProgress(env, dashboardId, cacheSyncedFiles, cacheSyncedBytes) {
  await env.DB.prepare(`
    UPDATE onedrive_mirrors
    SET cache_synced_files = ?, cache_synced_bytes = ?, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(cacheSyncedFiles, cacheSyncedBytes, dashboardId).run();
}
__name(updateOnedriveMirrorCacheProgress, "updateOnedriveMirrorCacheProgress");
async function get\u041EnedriveSyncStatus(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "E79885: dashboardId is required" }, { status: 400 });
  }
  const record = await env.DB.prepare(`
    SELECT * FROM onedrive_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!record) {
    return Response.json({ connected: false });
  }
  let largeFiles = [];
  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey2("onedrive", dashboardId));
  if (manifestObject) {
    const manifest = await manifestObject.json();
    largeFiles = manifest.entries.filter((entry) => entry.cacheStatus === "skipped_large").map((entry) => ({ id: entry.id, path: entry.path, size: entry.size })).sort((a, b) => b.size - a.size);
  }
  return Response.json({
    connected: true,
    folder: {
      id: record.folder_id,
      name: record.folder_name
    },
    status: record.status,
    totalFiles: record.total_files,
    totalBytes: record.total_bytes,
    cacheSyncedFiles: record.cache_synced_files,
    cacheSyncedBytes: record.cache_synced_bytes,
    workspaceSyncedFiles: record.workspace_synced_files,
    workspaceSyncedBytes: record.workspace_synced_bytes,
    largeFiles,
    lastSyncAt: record.last_sync_at,
    syncError: record.sync_error
  });
}
__name(get\u041EnedriveSyncStatus, "get\u041EnedriveSyncStatus");
async function sync\u041EnedriveMirr\u043Er(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId) {
    return Response.json({ error: "E79886: dashboardId is required" }, { status: 400 });
  }
  try {
    await runOnedriveSync(env, auth.user.id, data.dashboardId);
    return Response.json({ ok: true });
  } catch (error) {
    await env.DB.prepare(`
      UPDATE onedrive_mirrors
      SET status = 'error', sync_error = ?, updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(
      error instanceof Error ? error.message : "OneDrive sync failed",
      data.dashboardId
    ).run();
    return Response.json({ error: "E79887: OneDrive sync failed" }, { status: 500 });
  }
}
__name(sync\u041EnedriveMirr\u043Er, "sync\u041EnedriveMirr\u043Er");
async function runOnedriveSync(env, userId, dashboardId) {
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, userId).first();
  if (!access) {
    throw new Error("E79888: Not found or no access");
  }
  const mirror = await env.DB.prepare(`
    SELECT folder_id, folder_name FROM onedrive_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first();
  if (!mirror) {
    throw new Error("E79889: OneDrive folder not linked");
  }
  await env.DB.prepare(`
    UPDATE onedrive_mirrors
    SET status = 'syncing_cache',
        sync_error = null,
        total_files = 0,
        total_bytes = 0,
        cache_synced_files = 0,
        cache_synced_bytes = 0,
        workspace_synced_files = 0,
        workspace_synced_bytes = 0,
        large_files = 0,
        large_bytes = 0,
        updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(dashboardId).run();
  const accessToken = await refreshOnedriveAccessToken(env, userId);
  const { manifest, entries } = await buildOnedriveManifest(accessToken, mirror.folder_id, mirror.folder_name);
  const existingManifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey2("onedrive", dashboardId));
  const existingEntries = /* @__PURE__ */ new Map();
  if (existingManifestObject) {
    const existingManifest = await existingManifestObject.json();
    for (const entry of existingManifest.entries) {
      existingEntries.set(entry.id, entry);
    }
  }
  let totalFiles = 0;
  let totalBytes = 0;
  let cacheSyncedFiles = 0;
  let cacheSyncedBytes = 0;
  let largeFiles = 0;
  let largeBytes = 0;
  for (const entry of entries) {
    totalFiles += 1;
    totalBytes += entry.size;
    if (entry.size >= DRIVE_AUTO_SYNC_LIMIT_BYTES) {
      entry.cacheStatus = "skipped_large";
      entry.placeholder = "File exceeds sync limit. Click Sync to fetch it.";
      largeFiles += 1;
      largeBytes += entry.size;
      continue;
    }
    const previous = existingEntries.get(entry.id);
    if (previous && previous.md5Checksum && previous.md5Checksum === entry.md5Checksum) {
      entry.cacheStatus = previous.cacheStatus;
      if (entry.cacheStatus === "cached") {
        cacheSyncedFiles += 1;
        cacheSyncedBytes += entry.size;
      }
      continue;
    }
    const fileRes = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${entry.id}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!fileRes.ok || !fileRes.body) {
      entry.cacheStatus = "skipped_unsupported";
      entry.placeholder = "Failed to download OneDrive file.";
      continue;
    }
    await uploadDriveFileToCache(env, mirrorFileKey("onedrive", dashboardId, entry.id), fileRes, entry.size);
    cacheSyncedFiles += 1;
    cacheSyncedBytes += entry.size;
    entry.cacheStatus = "cached";
    await updateOnedriveMirrorCacheProgress(env, dashboardId, cacheSyncedFiles, cacheSyncedBytes);
  }
  manifest.entries = entries;
  await env.DRIVE_CACHE.put(mirrorManifestKey2("onedrive", dashboardId), JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" }
  });
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare(`
    UPDATE onedrive_mirrors
    SET status = 'syncing_workspace',
        total_files = ?,
        total_bytes = ?,
        cache_synced_files = ?,
        cache_synced_bytes = ?,
        large_files = ?,
        large_bytes = ?,
        last_sync_at = ?,
        updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(
    totalFiles,
    totalBytes,
    cacheSyncedFiles,
    cacheSyncedBytes,
    largeFiles,
    largeBytes,
    now,
    dashboardId
  ).run();
  const sandboxRecord = await env.DB.prepare(`
    SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes
    WHERE dashboard_id = ?
  `).bind(dashboardId).first();
  if (sandboxRecord?.sandbox_session_id) {
    await startSandboxMirrorSync(
      env,
      "onedrive",
      dashboardId,
      sandboxRecord.sandbox_session_id,
      sandboxRecord.sandbox_machine_id || "",
      mirror.folder_name
    );
  } else {
    await env.DB.prepare(`
      UPDATE onedrive_mirrors
      SET status = 'ready',
          updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(dashboardId).run();
  }
}
__name(runOnedriveSync, "runOnedriveSync");
async function sync\u041EnedriveLargeFiles(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId || !Array.isArray(data.fileIds) || data.fileIds.length === 0) {
    return Response.json({ error: "E79890: dashboardId and fileIds are required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79891: Not found or no access" }, { status: 404 });
  }
  const mirror = await env.DB.prepare(`
    SELECT folder_name FROM onedrive_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(data.dashboardId, auth.user.id).first();
  if (!mirror) {
    return Response.json({ error: "E79892: OneDrive folder not linked" }, { status: 404 });
  }
  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey2("onedrive", data.dashboardId));
  if (!manifestObject) {
    return Response.json({ error: "E79893: OneDrive manifest missing. Run sync first." }, { status: 404 });
  }
  const manifest = await manifestObject.json();
  const entryMap = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const accessToken = await refreshOnedriveAccessToken(env, auth.user.id);
  let cacheSyncedFiles = 0;
  let cacheSyncedBytes = 0;
  for (const entry of manifest.entries) {
    if (entry.cacheStatus === "cached") {
      cacheSyncedFiles += 1;
      cacheSyncedBytes += entry.size;
    }
  }
  for (const fileId of data.fileIds) {
    const entry = entryMap.get(fileId);
    if (!entry || entry.cacheStatus !== "skipped_large") {
      continue;
    }
    const fileRes = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${entry.id}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!fileRes.ok || !fileRes.body) {
      continue;
    }
    await uploadDriveFileToCache(env, mirrorFileKey("onedrive", data.dashboardId, entry.id), fileRes, entry.size);
    entry.cacheStatus = "cached";
    entry.placeholder = void 0;
    cacheSyncedFiles += 1;
    cacheSyncedBytes += entry.size;
    await updateOnedriveMirrorCacheProgress(env, data.dashboardId, cacheSyncedFiles, cacheSyncedBytes);
  }
  await env.DRIVE_CACHE.put(mirrorManifestKey2("onedrive", data.dashboardId), JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" }
  });
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare(`
    UPDATE onedrive_mirrors
    SET status = 'syncing_workspace',
        sync_error = null,
        last_sync_at = ?,
        updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(now, data.dashboardId).run();
  const sandboxRecord = await env.DB.prepare(`
    SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes
    WHERE dashboard_id = ?
  `).bind(data.dashboardId).first();
  if (sandboxRecord?.sandbox_session_id) {
    await startSandboxMirrorSync(
      env,
      "onedrive",
      data.dashboardId,
      sandboxRecord.sandbox_session_id,
      sandboxRecord.sandbox_machine_id || "",
      mirror.folder_name
    );
  } else {
    await env.DB.prepare(`
      UPDATE onedrive_mirrors
      SET status = 'ready',
          updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(data.dashboardId).run();
  }
  return Response.json({ ok: true });
}
__name(sync\u041EnedriveLargeFiles, "sync\u041EnedriveLargeFiles");
async function get\u041EnedriveManifest(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "E79894: dashboardId is required" }, { status: 400 });
  }
  const mirror = await env.DB.prepare(`
    SELECT folder_id, folder_name FROM onedrive_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!mirror) {
    return Response.json({ connected: false });
  }
  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey2("onedrive", dashboardId));
  if (!manifestObject) {
    return Response.json({
      connected: true,
      folder: { id: mirror.folder_id, name: mirror.folder_name },
      manifest: null
    });
  }
  const manifest = await manifestObject.json();
  return Response.json({
    connected: true,
    folder: { id: mirror.folder_id, name: mirror.folder_name },
    manifest
  });
}
__name(get\u041EnedriveManifest, "get\u041EnedriveManifest");
async function getG\u043E\u043EgleDriveIntegrati\u043En(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const record = await env.DB.prepare(`
    SELECT metadata FROM user_integrations
    WHERE user_id = ? AND provider = 'google_drive'
  `).bind(auth.user.id).first();
  if (!record) {
    return Response.json({ connected: false, linked: false, folder: null });
  }
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  let folder = null;
  if (dashboardId) {
    const mirror = await env.DB.prepare(`
      SELECT folder_id, folder_name, updated_at FROM drive_mirrors
      WHERE dashboard_id = ? AND user_id = ?
    `).bind(dashboardId, auth.user.id).first();
    if (mirror) {
      folder = {
        id: mirror.folder_id,
        name: mirror.folder_name,
        linked_at: mirror.updated_at
      };
    }
  }
  return Response.json({
    connected: true,
    linked: Boolean(folder),
    folder
  });
}
__name(getG\u043E\u043EgleDriveIntegrati\u043En, "getG\u043E\u043EgleDriveIntegrati\u043En");
async function unlinkG\u043E\u043EgleDriveF\u043Elder(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "E79839: dashboardId is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79840: Not found or no access" }, { status: 404 });
  }
  const manifestObject = await env.DRIVE_CACHE.get(driveManifestKey2(dashboardId));
  if (manifestObject) {
    const manifest = await manifestObject.json();
    await env.DRIVE_CACHE.delete(driveManifestKey2(dashboardId));
    for (const entry of manifest.entries) {
      await env.DRIVE_CACHE.delete(driveFileKey(dashboardId, entry.id));
    }
  }
  await env.DB.prepare(`
    DELETE FROM drive_mirrors WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).run();
  return Response.json({ ok: true });
}
__name(unlinkG\u043E\u043EgleDriveF\u043Elder, "unlinkG\u043E\u043EgleDriveF\u043Elder");
async function updateDriveMirrorCacheProgress(env, dashboardId, cacheSyncedFiles, cacheSyncedBytes) {
  await env.DB.prepare(`
    UPDATE drive_mirrors
    SET cache_synced_files = ?, cache_synced_bytes = ?, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(cacheSyncedFiles, cacheSyncedBytes, dashboardId).run();
}
__name(updateDriveMirrorCacheProgress, "updateDriveMirrorCacheProgress");
async function updateDriveMirrorWorkspaceProgress(env, dashboardId, workspaceSyncedFiles, workspaceSyncedBytes) {
  await env.DB.prepare(`
    UPDATE drive_mirrors
    SET workspace_synced_files = ?, workspace_synced_bytes = ?, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(workspaceSyncedFiles, workspaceSyncedBytes, dashboardId).run();
}
__name(updateDriveMirrorWorkspaceProgress, "updateDriveMirrorWorkspaceProgress");
async function startSandboxDriveSync(env, dashboardId, sandboxSessionId, sandboxMachineId, folderName) {
  try {
    const res = await fetch(`${env.SANDBOX_URL.replace(/\/$/, "")}/sessions/${sandboxSessionId}/drive/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": env.SANDBOX_INTERNAL_TOKEN,
        ...sandboxMachineId ? { "X-Sandbox-Machine-ID": sandboxMachineId } : {}
      },
      body: JSON.stringify({
        dashboard_id: dashboardId,
        folder_name: folderName
      })
    });
    if (!res.ok) {
      throw new Error(`sandbox sync failed: ${res.status}`);
    }
  } catch {
    await env.DB.prepare(`
      UPDATE drive_mirrors
      SET sync_error = 'Failed to start sandbox sync', status = 'error', updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(dashboardId).run();
  }
}
__name(startSandboxDriveSync, "startSandboxDriveSync");
async function startSandboxMirrorSync(env, provider, dashboardId, sandboxSessionId, sandboxMachineId, folderName) {
  try {
    const res = await fetch(`${env.SANDBOX_URL.replace(/\/$/, "")}/sessions/${sandboxSessionId}/mirror/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": env.SANDBOX_INTERNAL_TOKEN,
        ...sandboxMachineId ? { "X-Sandbox-Machine-ID": sandboxMachineId } : {}
      },
      body: JSON.stringify({
        provider,
        dashboard_id: dashboardId,
        folder_name: folderName
      })
    });
    if (!res.ok) {
      throw new Error(`sandbox sync failed: ${res.status}`);
    }
  } catch {
    await env.DB.prepare(`
      UPDATE ${provider}_mirrors
      SET sync_error = 'Failed to start sandbox sync', status = 'error', updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(dashboardId).run();
  }
}
__name(startSandboxMirrorSync, "startSandboxMirrorSync");
async function getG\u043E\u043EgleDriveSyncStatus(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "E79825: dashboardId is required" }, { status: 400 });
  }
  const record = await env.DB.prepare(`
    SELECT * FROM drive_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!record) {
    return Response.json({ connected: false });
  }
  let largeFiles = [];
  const manifestObject = await env.DRIVE_CACHE.get(driveManifestKey2(dashboardId));
  if (manifestObject) {
    const manifest = await manifestObject.json();
    largeFiles = manifest.entries.filter((entry) => entry.cacheStatus === "skipped_large").map((entry) => ({ id: entry.id, path: entry.path, size: entry.size })).sort((a, b) => b.size - a.size);
  }
  return Response.json({
    connected: true,
    folder: {
      id: record.folder_id,
      name: record.folder_name
    },
    status: record.status,
    totalFiles: record.total_files,
    totalBytes: record.total_bytes,
    cacheSyncedFiles: record.cache_synced_files,
    cacheSyncedBytes: record.cache_synced_bytes,
    workspaceSyncedFiles: record.workspace_synced_files,
    workspaceSyncedBytes: record.workspace_synced_bytes,
    largeFiles,
    lastSyncAt: record.last_sync_at,
    syncError: record.sync_error
  });
}
__name(getG\u043E\u043EgleDriveSyncStatus, "getG\u043E\u043EgleDriveSyncStatus");
async function syncG\u043E\u043EgleDriveMirr\u043Er(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId) {
    return Response.json({ error: "E79826: dashboardId is required" }, { status: 400 });
  }
  try {
    await runDriveSync(env, auth.user.id, data.dashboardId);
    return Response.json({ ok: true });
  } catch (error) {
    await env.DB.prepare(`
      UPDATE drive_mirrors
      SET status = 'error', sync_error = ?, updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(
      error instanceof Error ? error.message : "Drive sync failed",
      data.dashboardId
    ).run();
    return Response.json({ error: "E79829: Drive sync failed" }, { status: 500 });
  }
}
__name(syncG\u043E\u043EgleDriveMirr\u043Er, "syncG\u043E\u043EgleDriveMirr\u043Er");
async function runDriveSync(env, userId, dashboardId) {
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, userId).first();
  if (!access) {
    throw new Error("E79827: Not found or no access");
  }
  const mirror = await env.DB.prepare(`
    SELECT folder_id, folder_name FROM drive_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first();
  if (!mirror) {
    throw new Error("E79828: Drive folder not linked");
  }
  await env.DB.prepare(`
    UPDATE drive_mirrors
    SET status = 'syncing_cache',
        sync_error = null,
        total_files = 0,
        total_bytes = 0,
        cache_synced_files = 0,
        cache_synced_bytes = 0,
        workspace_synced_files = 0,
        workspace_synced_bytes = 0,
        large_files = 0,
        large_bytes = 0,
        updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(dashboardId).run();
  const accessToken = await refreshGoogleAccessToken(env, userId);
  const { manifest, entries } = await buildDriveManifest(accessToken, mirror.folder_id, mirror.folder_name);
  const existingManifestObject = await env.DRIVE_CACHE.get(driveManifestKey2(dashboardId));
  const existingEntries = /* @__PURE__ */ new Map();
  if (existingManifestObject) {
    const existingManifest = await existingManifestObject.json();
    for (const entry of existingManifest.entries) {
      existingEntries.set(entry.id, entry);
    }
  }
  let totalBytes = 0;
  let totalFiles = 0;
  let cacheSyncedFiles = 0;
  let cacheSyncedBytes = 0;
  let largeFiles = 0;
  let largeBytes = 0;
  for (const entry of entries) {
    totalFiles += 1;
    totalBytes += entry.size;
    if (entry.mimeType.startsWith("application/vnd.google-apps")) {
      entry.cacheStatus = "skipped_unsupported";
      entry.placeholder = "Google Docs files are not synced yet.";
      continue;
    }
    if (entry.size > DRIVE_AUTO_SYNC_LIMIT_BYTES) {
      entry.cacheStatus = "skipped_large";
      entry.placeholder = "File exceeds auto-sync limit (1GB).";
      largeFiles += 1;
      largeBytes += entry.size;
      continue;
    }
    const previous = existingEntries.get(entry.id);
    const unchanged = previous && previous.cacheStatus === "cached" && previous.md5Checksum === entry.md5Checksum && previous.modifiedTime === entry.modifiedTime;
    const cacheKey = driveFileKey(dashboardId, entry.id);
    if (unchanged) {
      const head = await env.DRIVE_CACHE.head(cacheKey);
      if (head) {
        cacheSyncedFiles += 1;
        cacheSyncedBytes += entry.size;
        entry.cacheStatus = "cached";
        await updateDriveMirrorCacheProgress(env, dashboardId, cacheSyncedFiles, cacheSyncedBytes);
        continue;
      }
    }
    const fileUrl = new URL(`https://www.googleapis.com/drive/v3/files/${entry.id}`);
    fileUrl.searchParams.set("alt", "media");
    const fileResponse = await fetch(fileUrl.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!fileResponse.ok || !fileResponse.body) {
      entry.cacheStatus = "skipped_unsupported";
      entry.placeholder = "Failed to download from Google Drive.";
      continue;
    }
    await uploadDriveFileToCache(env, cacheKey, fileResponse, entry.size);
    cacheSyncedFiles += 1;
    cacheSyncedBytes += entry.size;
    entry.cacheStatus = "cached";
    await updateDriveMirrorCacheProgress(env, dashboardId, cacheSyncedFiles, cacheSyncedBytes);
  }
  manifest.entries = entries;
  await env.DRIVE_CACHE.put(driveManifestKey2(dashboardId), JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" }
  });
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare(`
    UPDATE drive_mirrors
    SET status = 'syncing_workspace',
        total_files = ?,
        total_bytes = ?,
        cache_synced_files = ?,
        cache_synced_bytes = ?,
        large_files = ?,
        large_bytes = ?,
        last_sync_at = ?,
        updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(
    totalFiles,
    totalBytes,
    cacheSyncedFiles,
    cacheSyncedBytes,
    largeFiles,
    largeBytes,
    now,
    dashboardId
  ).run();
  const sandboxRecord = await env.DB.prepare(`
    SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes
    WHERE dashboard_id = ?
  `).bind(dashboardId).first();
  if (sandboxRecord?.sandbox_session_id) {
    await startSandboxDriveSync(
      env,
      dashboardId,
      sandboxRecord.sandbox_session_id,
      sandboxRecord.sandbox_machine_id || "",
      mirror.folder_name
    );
  } else {
    await env.DB.prepare(`
      UPDATE drive_mirrors
      SET status = 'ready',
          updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(dashboardId).run();
  }
}
__name(runDriveSync, "runDriveSync");
async function syncG\u043E\u043EgleDriveLargeFiles(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId || !Array.isArray(data.fileIds) || data.fileIds.length === 0) {
    return Response.json({ error: "E79830: dashboardId and fileIds are required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79831: Not found or no access" }, { status: 404 });
  }
  const mirror = await env.DB.prepare(`
    SELECT folder_id, folder_name FROM drive_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(data.dashboardId, auth.user.id).first();
  if (!mirror) {
    return Response.json({ error: "E79832: Drive folder not linked" }, { status: 404 });
  }
  const manifestObject = await env.DRIVE_CACHE.get(driveManifestKey2(data.dashboardId));
  if (!manifestObject) {
    return Response.json({ error: "E79833: Drive manifest missing. Run sync first." }, { status: 404 });
  }
  const manifest = await manifestObject.json();
  const entryMap = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const accessToken = await refreshGoogleAccessToken(env, auth.user.id);
  let cacheSyncedFiles = 0;
  let cacheSyncedBytes = 0;
  for (const entry of manifest.entries) {
    if (entry.cacheStatus === "cached") {
      cacheSyncedFiles += 1;
      cacheSyncedBytes += entry.size;
    }
  }
  for (const fileId of data.fileIds) {
    const entry = entryMap.get(fileId);
    if (!entry || entry.cacheStatus !== "skipped_large") {
      continue;
    }
    const fileUrl = new URL(`https://www.googleapis.com/drive/v3/files/${entry.id}`);
    fileUrl.searchParams.set("alt", "media");
    const fileResponse = await fetch(fileUrl.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!fileResponse.ok || !fileResponse.body) {
      continue;
    }
    await uploadDriveFileToCache(env, driveFileKey(data.dashboardId, entry.id), fileResponse, entry.size);
    entry.cacheStatus = "cached";
    entry.placeholder = void 0;
    cacheSyncedFiles += 1;
    cacheSyncedBytes += entry.size;
    await updateDriveMirrorCacheProgress(env, data.dashboardId, cacheSyncedFiles, cacheSyncedBytes);
  }
  await env.DRIVE_CACHE.put(driveManifestKey2(data.dashboardId), JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" }
  });
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare(`
    UPDATE drive_mirrors
    SET status = 'syncing_workspace',
        sync_error = null,
        last_sync_at = ?,
        updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(now, data.dashboardId).run();
  const sandboxRecord = await env.DB.prepare(`
    SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes
    WHERE dashboard_id = ?
  `).bind(data.dashboardId).first();
  if (sandboxRecord?.sandbox_session_id) {
    await startSandboxDriveSync(
      env,
      data.dashboardId,
      sandboxRecord.sandbox_session_id,
      sandboxRecord.sandbox_machine_id || "",
      mirror.folder_name
    );
  } else {
    await env.DB.prepare(`
      UPDATE drive_mirrors
      SET status = 'ready',
          updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(data.dashboardId).run();
  }
  return Response.json({ ok: true });
}
__name(syncG\u043E\u043EgleDriveLargeFiles, "syncG\u043E\u043EgleDriveLargeFiles");
async function getDriveManifestInternal(request, env) {
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "E79834: dashboardId is required" }, { status: 400 });
  }
  const manifestObject = await env.DRIVE_CACHE.get(driveManifestKey2(dashboardId));
  if (!manifestObject) {
    return Response.json({ error: "E79835: Drive manifest not found" }, { status: 404 });
  }
  return new Response(manifestObject.body, {
    headers: {
      "Content-Type": "application/json"
    }
  });
}
__name(getDriveManifestInternal, "getDriveManifestInternal");
async function getG\u043E\u043EgleDriveManifest(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "E79838: dashboardId is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor', 'viewer')
  `).bind(dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79839: Not found or no access" }, { status: 404 });
  }
  const mirror = await env.DB.prepare(`
    SELECT folder_id, folder_name FROM drive_mirrors
    WHERE dashboard_id = ?
  `).bind(dashboardId).first();
  if (!mirror) {
    return Response.json({ connected: false });
  }
  const manifestObject = await env.DRIVE_CACHE.get(driveManifestKey2(dashboardId));
  if (!manifestObject) {
    return Response.json({
      connected: true,
      folder: { id: mirror.folder_id, name: mirror.folder_name },
      manifest: null
    });
  }
  const manifest = await manifestObject.json();
  return Response.json({
    connected: true,
    folder: { id: mirror.folder_id, name: mirror.folder_name },
    manifest
  });
}
__name(getG\u043E\u043EgleDriveManifest, "getG\u043E\u043EgleDriveManifest");
async function getGithubAccessToken(env, userId) {
  const record = await env.DB.prepare(`
    SELECT access_token FROM user_integrations
    WHERE user_id = ? AND provider = 'github'
  `).bind(userId).first();
  if (!record?.access_token) {
    throw new Error("GitHub must be connected.");
  }
  return record.access_token;
}
__name(getGithubAccessToken, "getGithubAccessToken");
async function listGithubRepos(accessToken) {
  const repos = [];
  let page = 1;
  while (page <= 5) {
    const url = new URL("https://api.github.com/user/repos");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("sort", "updated");
    url.searchParams.set("page", page.toString());
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "OrcaBot",
        Accept: "application/vnd.github+json"
      }
    });
    if (!res.ok) {
      throw new Error("Failed to list GitHub repos.");
    }
    const data = await res.json();
    repos.push(...data);
    if (data.length < 100)
      break;
    page += 1;
  }
  return repos;
}
__name(listGithubRepos, "listGithubRepos");
async function buildGithubManifest(accessToken, repoOwner, repoName, repoBranch) {
  const treeUrl = new URL(`https://api.github.com/repos/${repoOwner}/${repoName}/git/trees/${repoBranch}`);
  treeUrl.searchParams.set("recursive", "1");
  const treeRes = await fetch(treeUrl.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "OrcaBot",
      Accept: "application/vnd.github+json"
    }
  });
  if (!treeRes.ok) {
    throw new Error("Failed to load GitHub repository tree.");
  }
  const treeData = await treeRes.json();
  const entries = [];
  const directories = [];
  for (const node of treeData.tree ?? []) {
    if (node.type === "tree") {
      directories.push(node.path);
      continue;
    }
    if (node.type !== "blob") {
      continue;
    }
    const size = node.size ?? 0;
    entries.push({
      id: node.path,
      name: node.path.split("/").pop() || node.path,
      path: node.path,
      mimeType: "application/octet-stream",
      size,
      modifiedTime: null,
      md5Checksum: null,
      cacheStatus: "cached"
    });
  }
  const safeOwner = sanitizePathSegment(repoOwner);
  const safeRepo = sanitizePathSegment(repoName);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const manifest = {
    version: DRIVE_MANIFEST_VERSION,
    folderId: `${repoOwner}/${repoName}`,
    folderName: `${repoOwner}/${repoName}`,
    folderPath: `github/${safeOwner}/${safeRepo}`,
    updatedAt: now,
    directories,
    entries
  };
  return { manifest, entries };
}
__name(buildGithubManifest, "buildGithubManifest");
async function listBoxFolderItems(accessToken, folderId) {
  const items = [];
  let offset = 0;
  const limit = 1e3;
  while (true) {
    const url = new URL(`https://api.box.com/2.0/folders/${folderId}/items`);
    url.searchParams.set("limit", limit.toString());
    url.searchParams.set("offset", offset.toString());
    url.searchParams.set("fields", "id,name,type,size,modified_at,sha1");
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) {
      throw new Error("Failed to list Box folder.");
    }
    const data = await res.json();
    if (data.entries) {
      items.push(...data.entries);
    }
    if (!data.total_count || items.length >= data.total_count) {
      break;
    }
    offset += limit;
  }
  return items;
}
__name(listBoxFolderItems, "listBoxFolderItems");
async function buildBoxManifest(accessToken, folderId, folderName) {
  const queue = [{ id: folderId, path: "" }];
  const entries = [];
  const directories = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current.path) {
      directories.push(current.path);
    }
    const children = await listBoxFolderItems(accessToken, current.id);
    for (const child of children) {
      if (child.type === "folder") {
        queue.push({ id: child.id, path: joinDrivePath(current.path, child.name) });
        continue;
      }
      if (child.type !== "file") {
        continue;
      }
      entries.push({
        id: child.id,
        name: child.name,
        path: joinDrivePath(current.path, child.name),
        mimeType: "application/octet-stream",
        size: child.size ?? 0,
        modifiedTime: child.modified_at || null,
        md5Checksum: child.sha1 || null,
        cacheStatus: "cached"
      });
    }
  }
  const safeFolderName = sanitizePathSegment(folderName);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const manifest = {
    version: DRIVE_MANIFEST_VERSION,
    folderId,
    folderName,
    folderPath: `box/${safeFolderName}`,
    updatedAt: now,
    directories,
    entries
  };
  return { manifest, entries };
}
__name(buildBoxManifest, "buildBoxManifest");
async function listOnedriveChildren(accessToken, folderId) {
  const items = [];
  let nextUrl = folderId === "root" ? "https://graph.microsoft.com/v1.0/me/drive/root/children" : `https://graph.microsoft.com/v1.0/me/drive/items/${folderId}/children`;
  while (nextUrl) {
    const res = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) {
      throw new Error("Failed to list OneDrive folder.");
    }
    const data = await res.json();
    if (data.value) {
      items.push(...data.value);
    }
    nextUrl = data["@odata.nextLink"] ?? null;
  }
  return items;
}
__name(listOnedriveChildren, "listOnedriveChildren");
async function buildOnedriveManifest(accessToken, folderId, folderName) {
  const queue = [{ id: folderId, path: "" }];
  const entries = [];
  const directories = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current.path) {
      directories.push(current.path);
    }
    const children = await listOnedriveChildren(accessToken, current.id);
    for (const child of children) {
      if (child.folder) {
        queue.push({ id: child.id, path: joinDrivePath(current.path, child.name) });
        continue;
      }
      entries.push({
        id: child.id,
        name: child.name,
        path: joinDrivePath(current.path, child.name),
        mimeType: "application/octet-stream",
        size: child.size ?? 0,
        modifiedTime: child.lastModifiedDateTime || null,
        md5Checksum: child.file?.hashes?.sha1Hash || null,
        cacheStatus: "cached"
      });
    }
  }
  const safeFolderName = sanitizePathSegment(folderName);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const manifest = {
    version: DRIVE_MANIFEST_VERSION,
    folderId,
    folderName,
    folderPath: `onedrive/${safeFolderName}`,
    updatedAt: now,
    directories,
    entries
  };
  return { manifest, entries };
}
__name(buildOnedriveManifest, "buildOnedriveManifest");
async function getDriveFileInternal(request, env) {
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  const fileId = url.searchParams.get("file_id");
  if (!dashboardId || !fileId) {
    return Response.json({ error: "E79836: dashboardId and fileId are required" }, { status: 400 });
  }
  const object = await env.DRIVE_CACHE.get(driveFileKey(dashboardId, fileId));
  if (!object) {
    return Response.json({ error: "E79837: Drive file not found" }, { status: 404 });
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", headers.get("Content-Type") || "application/octet-stream");
  return new Response(object.body, { headers });
}
__name(getDriveFileInternal, "getDriveFileInternal");
async function updateDriveSyncPr\u043EgressInternal(request, env) {
  const data = await request.json();
  if (!data.dashboardId) {
    return Response.json({ error: "E79838: dashboardId is required" }, { status: 400 });
  }
  if (typeof data.workspaceSyncedFiles === "number" && typeof data.workspaceSyncedBytes === "number") {
    await updateDriveMirrorWorkspaceProgress(
      env,
      data.dashboardId,
      data.workspaceSyncedFiles,
      data.workspaceSyncedBytes
    );
  }
  if (data.status) {
    await env.DB.prepare(`
      UPDATE drive_mirrors
      SET status = ?, sync_error = ?, updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(
      data.status,
      data.syncError || null,
      data.dashboardId
    ).run();
  }
  return Response.json({ ok: true });
}
__name(updateDriveSyncPr\u043EgressInternal, "updateDriveSyncPr\u043EgressInternal");
async function getMirr\u043ErManifestInternal(request, env) {
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  const provider = url.searchParams.get("provider");
  if (!dashboardId || !provider) {
    return Response.json({ error: "E79900: dashboardId and provider are required" }, { status: 400 });
  }
  if (!["github", "box", "onedrive"].includes(provider)) {
    return Response.json({ error: "E79901: invalid provider" }, { status: 400 });
  }
  const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey2(provider, dashboardId));
  if (!manifestObject) {
    return Response.json({ error: "E79902: Mirror manifest not found" }, { status: 404 });
  }
  return new Response(manifestObject.body, {
    headers: {
      "Content-Type": "application/json"
    }
  });
}
__name(getMirr\u043ErManifestInternal, "getMirr\u043ErManifestInternal");
async function getMirr\u043ErFileInternal(request, env) {
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  const fileId = url.searchParams.get("file_id");
  const provider = url.searchParams.get("provider");
  if (!dashboardId || !fileId || !provider) {
    return Response.json({ error: "E79903: dashboardId, fileId, and provider are required" }, { status: 400 });
  }
  if (!["github", "box", "onedrive"].includes(provider)) {
    return Response.json({ error: "E79904: invalid provider" }, { status: 400 });
  }
  const object = await env.DRIVE_CACHE.get(mirrorFileKey(provider, dashboardId, fileId));
  if (!object) {
    return Response.json({ error: "E79905: Mirror file not found" }, { status: 404 });
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", headers.get("Content-Type") || "application/octet-stream");
  return new Response(object.body, { headers });
}
__name(getMirr\u043ErFileInternal, "getMirr\u043ErFileInternal");
async function updateMirr\u043ErSyncPr\u043EgressInternal(request, env) {
  const data = await request.json();
  if (!data.provider || !data.dashboardId) {
    return Response.json({ error: "E79906: provider and dashboardId are required" }, { status: 400 });
  }
  if (!["github", "box", "onedrive"].includes(data.provider)) {
    return Response.json({ error: "E79907: invalid provider" }, { status: 400 });
  }
  const table = `${data.provider}_mirrors`;
  const status = data.status || "syncing_workspace";
  const syncError = data.syncError ?? null;
  const files = data.workspaceSyncedFiles ?? 0;
  const bytes = data.workspaceSyncedBytes ?? 0;
  await env.DB.prepare(`
    UPDATE ${table}
    SET workspace_synced_files = ?, workspace_synced_bytes = ?, status = ?, sync_error = ?, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(files, bytes, status, syncError, data.dashboardId).run();
  return Response.json({ ok: true });
}
__name(updateMirr\u043ErSyncPr\u043EgressInternal, "updateMirr\u043ErSyncPr\u043EgressInternal");
async function renderG\u043E\u043EgleDrivePicker(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_API_KEY) {
    return renderErrorPage("Google OAuth is not configured.");
  }
  const record = await env.DB.prepare(`
    SELECT access_token, refresh_token FROM user_integrations
    WHERE user_id = ? AND provider = 'google_drive'
  `).bind(auth.user.id).first();
  if (!record?.refresh_token) {
    return renderErrorPage("Google Drive must be connected again to select a folder.");
  }
  const body = new URLSearchParams();
  body.set("client_id", env.GOOGLE_CLIENT_ID);
  body.set("client_secret", env.GOOGLE_CLIENT_SECRET);
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", record.refresh_token);
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!tokenResponse.ok) {
    return renderErrorPage("Failed to refresh Google access token.");
  }
  const tokenData = await tokenResponse.json();
  const now = /* @__PURE__ */ new Date();
  const expiresAt = tokenData.expires_in ? new Date(now.getTime() + tokenData.expires_in * 1e3).toISOString() : null;
  await env.DB.prepare(`
    UPDATE user_integrations
    SET access_token = ?, scope = ?, token_type = ?, expires_at = ?, updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'google_drive'
  `).bind(
    tokenData.access_token,
    tokenData.scope || null,
    tokenData.token_type || null,
    expiresAt,
    auth.user.id
  ).run();
  const frontendUrl = env.FRONTEND_URL || "https://orcabot.com";
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  return renderDrivePickerPage(tokenData.access_token, env.GOOGLE_API_KEY, frontendUrl, dashboardId);
}
__name(renderG\u043E\u043EgleDrivePicker, "renderG\u043E\u043EgleDrivePicker");
async function c\u043EnnectGithub(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return renderErrorPage("GitHub OAuth is not configured.");
  }
  const requestUrl = new URL(request.url);
  const mode = requestUrl.searchParams.get("mode");
  const dashboardId = requestUrl.searchParams.get("dashboard_id");
  const state = buildState();
  await createState(env, auth.user.id, "github", state, {
    mode,
    dashboardId
  });
  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/github/callback`;
  const authUrl = new URL("https://github.com/login/oauth/authorize");
  authUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", GITHUB_SCOPE.join(" "));
  authUrl.searchParams.set("state", state);
  return Response.redirect(authUrl.toString(), 302);
}
__name(c\u043EnnectGithub, "c\u043EnnectGithub");
async function callbackGithub(request, env) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return renderErrorPage("GitHub OAuth is not configured.");
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return renderErrorPage("Missing authorization code.");
  }
  const stateData = await consumeState(env, state, "github");
  if (!stateData) {
    return renderErrorPage("Invalid or expired state.");
  }
  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/github/callback`;
  const body = new URLSearchParams();
  body.set("client_id", env.GITHUB_CLIENT_ID);
  body.set("client_secret", env.GITHUB_CLIENT_SECRET);
  body.set("code", code);
  body.set("redirect_uri", redirectUri);
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json"
    },
    body
  });
  if (!tokenResponse.ok) {
    return renderErrorPage("Failed to exchange token.");
  }
  const tokenData = await tokenResponse.json();
  const metadata = JSON.stringify({
    scope: tokenData.scope,
    token_type: tokenData.token_type
  });
  await env.DB.prepare(`
    INSERT INTO user_integrations (
      id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata
    ) VALUES (?, ?, 'github', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      scope = excluded.scope,
      token_type = excluded.token_type,
      expires_at = excluded.expires_at,
      metadata = excluded.metadata,
      updated_at = datetime('now')
  `).bind(
    crypto.randomUUID(),
    stateData.userId,
    tokenData.access_token,
    null,
    tokenData.scope || null,
    tokenData.token_type || null,
    null,
    metadata
  ).run();
  const frontendUrl = env.FRONTEND_URL || "https://orcabot.com";
  if (stateData.metadata?.mode === "popup") {
    const dashboardId = typeof stateData.metadata?.dashboardId === "string" ? stateData.metadata.dashboardId : null;
    return renderProviderAuthCompletePage(frontendUrl, "GitHub", "github-auth-complete", dashboardId);
  }
  return renderSuccessPage("GitHub");
}
__name(callbackGithub, "callbackGithub");
async function c\u043EnnectB\u043Ex(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  if (!env.BOX_CLIENT_ID || !env.BOX_CLIENT_SECRET) {
    return renderErrorPage("Box OAuth is not configured.");
  }
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode");
  const dashboardId = url.searchParams.get("dashboard_id");
  const state = buildState();
  await createState(env, auth.user.id, "box", state, {
    mode,
    dashboardId
  });
  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/box/callback`;
  const authUrl = new URL("https://account.box.com/api/oauth2/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", env.BOX_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", BOX_SCOPE.join(" "));
  return Response.redirect(authUrl.toString(), 302);
}
__name(c\u043EnnectB\u043Ex, "c\u043EnnectB\u043Ex");
async function callbackB\u043Ex(request, env) {
  if (!env.BOX_CLIENT_ID || !env.BOX_CLIENT_SECRET) {
    return renderErrorPage("Box OAuth is not configured.");
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return renderErrorPage("Missing authorization code.");
  }
  const stateData = await consumeState(env, state, "box");
  if (!stateData) {
    return renderErrorPage("Invalid or expired state.");
  }
  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/box/callback`;
  const body = new URLSearchParams();
  body.set("client_id", env.BOX_CLIENT_ID);
  body.set("client_secret", env.BOX_CLIENT_SECRET);
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", redirectUri);
  const tokenResponse = await fetch("https://api.box.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!tokenResponse.ok) {
    return renderErrorPage("Failed to exchange token.");
  }
  const tokenData = await tokenResponse.json();
  const now = /* @__PURE__ */ new Date();
  const expiresAt = tokenData.expires_in ? new Date(now.getTime() + tokenData.expires_in * 1e3).toISOString() : null;
  await env.DB.prepare(`
    INSERT INTO user_integrations (
      id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata
    ) VALUES (?, ?, 'box', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      scope = excluded.scope,
      token_type = excluded.token_type,
      expires_at = excluded.expires_at,
      metadata = excluded.metadata,
      updated_at = datetime('now')
  `).bind(
    crypto.randomUUID(),
    stateData.userId,
    tokenData.access_token,
    tokenData.refresh_token || null,
    BOX_SCOPE.join(" "),
    tokenData.token_type || null,
    expiresAt,
    JSON.stringify({ provider: "box" })
  ).run();
  const frontendUrl = env.FRONTEND_URL || "https://orcabot.com";
  if (stateData.metadata?.mode === "popup") {
    const dashboardId = typeof stateData.metadata?.dashboardId === "string" ? stateData.metadata.dashboardId : null;
    return renderProviderAuthCompletePage(frontendUrl, "Box", "box-auth-complete", dashboardId);
  }
  return renderSuccessPage("Box");
}
__name(callbackB\u043Ex, "callbackB\u043Ex");
async function c\u043Ennect\u041Enedrive(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  if (!env.ONEDRIVE_CLIENT_ID || !env.ONEDRIVE_CLIENT_SECRET) {
    return renderErrorPage("OneDrive OAuth is not configured.");
  }
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode");
  const dashboardId = url.searchParams.get("dashboard_id");
  const state = buildState();
  await createState(env, auth.user.id, "onedrive", state, {
    mode,
    dashboardId
  });
  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/onedrive/callback`;
  const authUrl = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  authUrl.searchParams.set("client_id", env.ONEDRIVE_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_mode", "query");
  authUrl.searchParams.set("scope", ONEDRIVE_SCOPE.join(" "));
  authUrl.searchParams.set("state", state);
  return Response.redirect(authUrl.toString(), 302);
}
__name(c\u043Ennect\u041Enedrive, "c\u043Ennect\u041Enedrive");
async function callback\u041Enedrive(request, env) {
  if (!env.ONEDRIVE_CLIENT_ID || !env.ONEDRIVE_CLIENT_SECRET) {
    return renderErrorPage("OneDrive OAuth is not configured.");
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return renderErrorPage("Missing authorization code.");
  }
  const stateData = await consumeState(env, state, "onedrive");
  if (!stateData) {
    return renderErrorPage("Invalid or expired state.");
  }
  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/onedrive/callback`;
  const body = new URLSearchParams();
  body.set("client_id", env.ONEDRIVE_CLIENT_ID);
  body.set("client_secret", env.ONEDRIVE_CLIENT_SECRET);
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", redirectUri);
  body.set("scope", ONEDRIVE_SCOPE.join(" "));
  const tokenResponse = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!tokenResponse.ok) {
    return renderErrorPage("Failed to exchange token.");
  }
  const tokenData = await tokenResponse.json();
  const now = /* @__PURE__ */ new Date();
  const expiresAt = tokenData.expires_in ? new Date(now.getTime() + tokenData.expires_in * 1e3).toISOString() : null;
  await env.DB.prepare(`
    INSERT INTO user_integrations (
      id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata
    ) VALUES (?, ?, 'onedrive', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      scope = excluded.scope,
      token_type = excluded.token_type,
      expires_at = excluded.expires_at,
      metadata = excluded.metadata,
      updated_at = datetime('now')
  `).bind(
    crypto.randomUUID(),
    stateData.userId,
    tokenData.access_token,
    tokenData.refresh_token || null,
    ONEDRIVE_SCOPE.join(" "),
    tokenData.token_type || null,
    expiresAt,
    JSON.stringify({ provider: "onedrive" })
  ).run();
  const frontendUrl = env.FRONTEND_URL || "https://orcabot.com";
  if (stateData.metadata?.mode === "popup") {
    const dashboardId = typeof stateData.metadata?.dashboardId === "string" ? stateData.metadata.dashboardId : null;
    return renderProviderAuthCompletePage(frontendUrl, "OneDrive", "onedrive-auth-complete", dashboardId);
  }
  return renderSuccessPage("OneDrive");
}
__name(callback\u041Enedrive, "callback\u041Enedrive");

// src/auth/google.ts
var GOOGLE_LOGIN_SCOPE = [
  "openid",
  "email",
  "profile"
];
function getRedirectBase2(request, env) {
  if (env.OAUTH_REDIRECT_BASE) {
    return env.OAUTH_REDIRECT_BASE.replace(/\/$/, "");
  }
  return new URL(request.url).origin;
}
__name(getRedirectBase2, "getRedirectBase");
function getAllowedRedirects(env) {
  if (!env.ALLOWED_ORIGINS) {
    return null;
  }
  return new Set(
    env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean)
  );
}
__name(getAllowedRedirects, "getAllowedRedirects");
function parseAllowList(value) {
  if (!value) {
    return null;
  }
  const entries = value.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  return entries.length > 0 ? new Set(entries) : null;
}
__name(parseAllowList, "parseAllowList");
function isAllowedEmail(env, email) {
  const allowEmails = parseAllowList(env.AUTH_ALLOWED_EMAILS);
  const allowDomains = parseAllowList(env.AUTH_ALLOWED_DOMAINS);
  if (!allowEmails && !allowDomains) {
    return true;
  }
  const normalized = email.trim().toLowerCase();
  if (allowEmails?.has(normalized)) {
    return true;
  }
  const domain = normalized.split("@")[1] || "";
  return Boolean(domain && allowDomains?.has(domain));
}
__name(isAllowedEmail, "isAllowedEmail");
function resolvePostLoginRedirect(request, env) {
  const url = new URL(request.url);
  const redirectParam = url.searchParams.get("redirect");
  const fallback = env.FRONTEND_URL || request.headers.get("Origin") || url.origin;
  if (!redirectParam) {
    return fallback;
  }
  let redirectUrl = null;
  try {
    redirectUrl = new URL(redirectParam);
  } catch {
    redirectUrl = null;
  }
  if (!redirectUrl || redirectUrl.protocol !== "https:" && redirectUrl.protocol !== "http:") {
    return fallback;
  }
  const allowed = getAllowedRedirects(env);
  if (allowed === null) {
    return redirectUrl.toString();
  }
  return allowed.has(redirectUrl.origin) ? redirectUrl.toString() : fallback;
}
__name(resolvePostLoginRedirect, "resolvePostLoginRedirect");
function escapeHtml2(unsafe) {
  return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
__name(escapeHtml2, "escapeHtml");
function renderErrorPage2(message) {
  const safeMessage = escapeHtml2(message);
  return new Response(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Sign-in failed</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 32px; }
      .card { max-width: 520px; margin: 0 auto; }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p { margin: 0 0 16px; color: #b91c1c; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Sign-in failed</h1>
      <p>${safeMessage}</p>
    </div>
  </body>
</html>`,
    {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    }
  );
}
__name(renderErrorPage2, "renderErrorPage");
async function createAuthState(env, state, redirectUrl) {
  await env.DB.prepare(`
    INSERT INTO auth_states (state, redirect_url)
    VALUES (?, ?)
  `).bind(state, redirectUrl).run();
}
__name(createAuthState, "createAuthState");
async function consumeAuthState(env, state) {
  const record = await env.DB.prepare(`
    SELECT redirect_url as redirectUrl FROM auth_states WHERE state = ?
  `).bind(state).first();
  if (!record) {
    return null;
  }
  await env.DB.prepare(`
    DELETE FROM auth_states WHERE state = ?
  `).bind(state).run();
  return record.redirectUrl;
}
__name(consumeAuthState, "consumeAuthState");
async function findOrCreateUser(env, profile) {
  const existing = await env.DB.prepare(`
    SELECT * FROM users WHERE email = ?
  `).bind(profile.email).first();
  if (existing) {
    return existing.id;
  }
  const userId = `google:${profile.sub}`;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const name = profile.name || profile.email.split("@")[0];
  await env.DB.prepare(`
    INSERT INTO users (id, email, name, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(userId, profile.email, name, now).run();
  return userId;
}
__name(findOrCreateUser, "findOrCreateUser");
async function loginWithGoogle(request, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return renderErrorPage2("Google OAuth is not configured.");
  }
  const state = crypto.randomUUID();
  const redirectUri = `${getRedirectBase2(request, env)}/auth/google/callback`;
  const postLoginRedirect = resolvePostLoginRedirect(request, env);
  await createAuthState(env, state, postLoginRedirect);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_LOGIN_SCOPE.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return Response.redirect(url.toString(), 302);
}
__name(loginWithGoogle, "loginWithGoogle");
async function callbackGoogle(request, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return renderErrorPage2("Google OAuth is not configured.");
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return renderErrorPage2("Missing authorization code.");
  }
  const postLoginRedirect = await consumeAuthState(env, state);
  if (!postLoginRedirect) {
    return renderErrorPage2("Invalid or expired state.");
  }
  const redirectUri = `${getRedirectBase2(request, env)}/auth/google/callback`;
  const body = new URLSearchParams();
  body.set("client_id", env.GOOGLE_CLIENT_ID);
  body.set("client_secret", env.GOOGLE_CLIENT_SECRET);
  body.set("code", code);
  body.set("grant_type", "authorization_code");
  body.set("redirect_uri", redirectUri);
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!tokenResponse.ok) {
    return renderErrorPage2("Failed to exchange token.");
  }
  const tokenData = await tokenResponse.json();
  const userInfoResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` }
  });
  if (!userInfoResponse.ok) {
    return renderErrorPage2("Failed to fetch Google profile.");
  }
  const userInfo = await userInfoResponse.json();
  if (!userInfo.email || !userInfo.sub) {
    return renderErrorPage2("Google profile missing required fields.");
  }
  if (userInfo.email_verified !== true) {
    return renderErrorPage2("Google account email is not verified.");
  }
  if (!isAllowedEmail(env, userInfo.email)) {
    return renderErrorPage2("This Google account is not allowed to sign in.");
  }
  const userId = await findOrCreateUser(env, userInfo);
  const session = await createUserSession(env, userId);
  const cookie = buildSessionCookie(request, session.id, session.expiresAt);
  return new Response(null, {
    status: 302,
    headers: {
      Location: postLoginRedirect,
      "Set-Cookie": cookie
    }
  });
}
__name(callbackGoogle, "callbackGoogle");

// src/auth/logout.ts
async function logout(request, env) {
  const sessionId = readSessionId(request);
  if (sessionId) {
    await deleteUserSession(env, sessionId);
  }
  return new Response(null, {
    status: 204,
    headers: {
      "Set-Cookie": buildClearSessionCookie(request)
    }
  });
}
__name(logout, "logout");

// src/health/checker.ts
async function checkAndCacheSandb\u043ExHealth(env) {
  const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  try {
    const isHealthy = await sandbox.health();
    if (isHealthy) {
      await env.DB.prepare(`
        INSERT INTO system_health (service, is_healthy, last_check_at, last_error, consecutive_failures)
        VALUES ('sandbox', 1, ?, NULL, 0)
        ON CONFLICT(service) DO UPDATE SET
          is_healthy = 1,
          last_check_at = excluded.last_check_at,
          last_error = NULL,
          consecutive_failures = 0
      `).bind(now).run();
    } else {
      await incrementFailure(env.DB, "sandbox", now, "Health check returned unhealthy");
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await incrementFailure(env.DB, "sandbox", now, errorMessage);
  }
}
__name(checkAndCacheSandb\u043ExHealth, "checkAndCacheSandb\u043ExHealth");
async function incrementFailure(db, service, timestamp, error) {
  await db.prepare(`
    INSERT INTO system_health (service, is_healthy, last_check_at, last_error, consecutive_failures)
    VALUES (?, 0, ?, ?, 1)
    ON CONFLICT(service) DO UPDATE SET
      is_healthy = 0,
      last_check_at = excluded.last_check_at,
      last_error = excluded.last_error,
      consecutive_failures = consecutive_failures + 1
  `).bind(service, timestamp, error).run();
}
__name(incrementFailure, "incrementFailure");
async function getCachedHealth(db, service) {
  const row = await db.prepare(`
    SELECT service, is_healthy, last_check_at, last_error, consecutive_failures
    FROM system_health
    WHERE service = ?
  `).bind(service).first();
  if (!row) {
    return null;
  }
  return {
    service: row.service,
    isHealthy: row.is_healthy === 1,
    lastCheckAt: row.last_check_at,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures
  };
}
__name(getCachedHealth, "getCachedHealth");

// src/dashboards/DurableObject.ts
var Rat\u0435LimitedLogger = class {
  lastLogTime = 0;
  suppressedCount = 0;
  minIntervalMs;
  constructor(minIntervalMs = 5e3) {
    this.minIntervalMs = minIntervalMs;
  }
  warn(code, message, detail) {
    const now = Date.now();
    if (now - this.lastLogTime < this.minIntervalMs) {
      this.suppressedCount++;
      return;
    }
    const suppressed = this.suppressedCount > 0 ? ` (${this.suppressedCount} similar suppressed)` : "";
    console.warn(`${code}: ${message}${suppressed}`, detail ? `- ${detail.substring(0, 100)}` : "");
    this.lastLogTime = now;
    this.suppressedCount = 0;
  }
};
__name(Rat\u0435LimitedLogger, "Rat\u0435LimitedLogger");
var DashboardDO = class {
  state;
  sessions = /* @__PURE__ */ new Map();
  presence = /* @__PURE__ */ new Map();
  // Track connection count per user for multi-tab support
  userConnectionCount = /* @__PURE__ */ new Map();
  dashboard = null;
  items = /* @__PURE__ */ new Map();
  terminalSessions = /* @__PURE__ */ new Map();
  edges = /* @__PURE__ */ new Map();
  pendingBrowserOpenUrl = null;
  initPromise;
  // Rate-limited logger for WebSocket parse errors
  parseErrorLogger = new Rat\u0435LimitedLogger(5e3);
  constructor(state) {
    this.state = state;
    this.initPromise = this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get("state");
      if (stored) {
        this.dashboard = stored.dashboard;
        this.items = new Map(stored.items);
        this.terminalSessions = new Map(stored.terminalSessions);
        this.edges = new Map(stored.edges);
        this.pendingBrowserOpenUrl = stored.pendingBrowserOpenUrl ?? null;
      }
    });
  }
  async fetch(request) {
    await this.initPromise;
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const userId = url.searchParams.get("user_id");
      const userName = url.searchParams.get("user_name") || "Anonymous";
      if (!userId) {
        return new Response("user_id required", { status: 400 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.handleWebSocket(server, userId, userName);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (path === "/init" && request.method === "POST") {
      const data = await request.json();
      this.dashboard = data.dashboard;
      this.items = new Map(data.items.map((i) => [i.id, i]));
      this.terminalSessions = new Map(data.sessions.map((s) => [s.id, s]));
      this.edges = new Map((data.edges ?? []).map((e) => [e.id, e]));
      await this.persistState();
      return Response.json({ success: true });
    }
    if (path === "/state" && request.method === "GET") {
      return Response.json({
        dashboard: this.dashboard,
        items: Array.from(this.items.values()),
        presence: Array.from(this.presence.values()),
        sessions: Array.from(this.terminalSessions.values()),
        edges: Array.from(this.edges.values())
      });
    }
    if (path === "/item" && request.method === "PUT") {
      const item = await request.json();
      this.items.set(item.id, item);
      await this.persistState();
      this.broadcast({ type: "item_update", item });
      return Response.json({ success: true });
    }
    if (path === "/item" && request.method === "POST") {
      const item = await request.json();
      this.items.set(item.id, item);
      await this.persistState();
      this.broadcast({ type: "item_create", item });
      return Response.json({ success: true });
    }
    if (path === "/item" && request.method === "DELETE") {
      const { itemId } = await request.json();
      this.items.delete(itemId);
      await this.persistState();
      this.broadcast({ type: "item_delete", item_id: itemId });
      return Response.json({ success: true });
    }
    if (path === "/session" && request.method === "PUT") {
      const session = await request.json();
      this.terminalSessions.set(session.id, session);
      await this.persistState();
      this.broadcast({ type: "session_update", session });
      return Response.json({ success: true });
    }
    if (path === "/edge" && request.method === "POST") {
      const edge = await request.json();
      this.edges.set(edge.id, edge);
      await this.persistState();
      this.broadcast({ type: "edge_create", edge });
      return Response.json({ success: true });
    }
    if (path === "/edge" && request.method === "DELETE") {
      const { edgeId } = await request.json();
      this.edges.delete(edgeId);
      await this.persistState();
      this.broadcast({ type: "edge_delete", edge_id: edgeId });
      return Response.json({ success: true });
    }
    if (path === "/browser" && request.method === "POST") {
      const data = await request.json();
      const url2 = typeof data.url === "string" ? data.url : "";
      if (url2) {
        if (this.sessions.size === 0) {
          this.pendingBrowserOpenUrl = url2;
          await this.persistState();
        } else {
          this.pendingBrowserOpenUrl = null;
        }
        this.broadcast({ type: "browser_open", url: url2 });
      }
      return Response.json({ success: true });
    }
    return new Response("Not found", { status: 404 });
  }
  handleWebSocket(ws, userId, userName) {
    this.state.acceptWebSocket(ws);
    this.sessions.set(ws, { userId, userName });
    const currentCount = this.userConnectionCount.get(userId) || 0;
    this.userConnectionCount.set(userId, currentCount + 1);
    const isFirstConnection = currentCount === 0;
    if (isFirstConnection) {
      const presenceInfo = {
        userId,
        userName,
        cursor: null,
        selectedItemId: null,
        connectedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      this.presence.set(userId, presenceInfo);
      this.broadcast({ type: "join", user_id: userId, user_name: userName }, ws);
    }
    const stateMsg = JSON.stringify({
      type: "presence",
      users: Array.from(this.presence.values()).map((p) => ({
        user_id: p.userId,
        user_name: p.userName,
        cursor: p.cursor,
        selected_item: p.selectedItemId
      }))
    });
    ws.send(stateMsg);
    if (this.pendingBrowserOpenUrl) {
      const pendingUrl = this.pendingBrowserOpenUrl;
      this.pendingBrowserOpenUrl = null;
      this.persistState().catch(() => {
      });
      ws.send(JSON.stringify({ type: "browser_open", url: pendingUrl }));
    }
  }
  webSocketMessage(ws, message) {
    if (typeof message !== "string")
      return;
    const attachment = this.sessions.get(ws);
    if (!attachment)
      return;
    try {
      const msg = JSON.parse(message);
      switch (msg.type) {
        case "cursor": {
          const presence = this.presence.get(attachment.userId);
          if (presence) {
            presence.cursor = { x: msg.x, y: msg.y };
            this.broadcast({ type: "cursor", user_id: attachment.userId, x: msg.x, y: msg.y }, ws);
          }
          break;
        }
        case "select": {
          const presence = this.presence.get(attachment.userId);
          if (presence) {
            presence.selectedItemId = msg.itemId;
            this.broadcast({ type: "select", user_id: attachment.userId, item_id: msg.itemId }, ws);
          }
          break;
        }
      }
    } catch (error) {
      const preview = typeof message === "string" ? message.substring(0, 100) : "[non-string]";
      this.parseErrorLogger.warn(
        "E79801",
        "Failed to parse WebSocket collaboration message",
        preview
      );
    }
  }
  webSocketClose(ws) {
    const attachment = this.sessions.get(ws);
    if (attachment) {
      this.sessions.delete(ws);
      const currentCount = this.userConnectionCount.get(attachment.userId) || 1;
      const newCount = currentCount - 1;
      if (newCount <= 0) {
        this.userConnectionCount.delete(attachment.userId);
        this.presence.delete(attachment.userId);
        this.broadcast({ type: "leave", user_id: attachment.userId });
      } else {
        this.userConnectionCount.set(attachment.userId, newCount);
      }
    }
  }
  webSocketError(ws) {
    this.webSocketClose(ws);
  }
  broadcast(message, exclude) {
    const msgStr = JSON.stringify(message);
    for (const [ws] of this.sessions) {
      if (ws !== exclude) {
        try {
          ws.send(msgStr);
        } catch {
        }
      }
    }
  }
  async persistState() {
    await this.state.storage.put("state", {
      dashboard: this.dashboard,
      items: Array.from(this.items.entries()),
      terminalSessions: Array.from(this.terminalSessions.entries()),
      edges: Array.from(this.edges.entries()),
      pendingBrowserOpenUrl: this.pendingBrowserOpenUrl
    });
  }
};
__name(DashboardDO, "DashboardDO");

// src/index.ts
var CORS_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
var CORS_ALLOWED_HEADERS = "Content-Type, X-User-ID, X-User-Email, X-User-Name";
function parseAll\u043EwedOrigins(env) {
  if (!env.ALLOWED_ORIGINS) {
    return null;
  }
  return new Set(
    env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  );
}
__name(parseAll\u043EwedOrigins, "parseAll\u043EwedOrigins");
var EMBED_ALLOWED_PROTOCOLS = /* @__PURE__ */ new Set(["http:", "https:"]);
function c\u043ErsResp\u043Ense(response, origin, allowedOrigins) {
  if (response.status === 101) {
    return response;
  }
  const newResponse = new Response(response.body, response);
  const newHeaders = newResponse.headers;
  newHeaders.set("Access-Control-Allow-Methods", CORS_METHODS);
  newHeaders.set("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
  const allowOrigin = origin && (allowedOrigins === null || allowedOrigins.has(origin));
  if (allowOrigin) {
    newHeaders.set("Access-Control-Allow-Origin", origin);
    newHeaders.set("Vary", "Origin");
    newHeaders.set("Access-Control-Allow-Credentials", "true");
  } else if (allowedOrigins === null) {
    newHeaders.set("Access-Control-Allow-Origin", "*");
  }
  return newResponse;
}
__name(c\u043ErsResp\u043Ense, "c\u043ErsResp\u043Ense");
function isPrivateH\u043Estname(hostname) {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".local")) {
    return true;
  }
  if (lower.startsWith("[") && lower.endsWith("]")) {
    const ipv6 = lower.slice(1, -1);
    if (ipv6 === "::1")
      return true;
    if (ipv6.startsWith("fc") || ipv6.startsWith("fd"))
      return true;
    if (ipv6.startsWith("fe80"))
      return true;
    return false;
  }
  const ipv4Match = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4Match)
    return false;
  const octets = ipv4Match.slice(1).map((part) => Number(part));
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [a, b] = octets;
  if (a === 10)
    return true;
  if (a === 127)
    return true;
  if (a === 0)
    return true;
  if (a === 169 && b === 254)
    return true;
  if (a === 172 && b >= 16 && b <= 31)
    return true;
  if (a === 192 && b === 168)
    return true;
  return false;
}
__name(isPrivateH\u043Estname, "isPrivateH\u043Estname");
function parseFrameAncest\u043Ers(csp) {
  if (!csp)
    return null;
  const directives = csp.split(";").map((part) => part.trim()).filter(Boolean);
  const frameAncestors = directives.find(
    (directive) => directive.toLowerCase().startsWith("frame-ancestors")
  );
  if (!frameAncestors)
    return null;
  return frameAncestors.split(/\s+/).slice(1);
}
__name(parseFrameAncest\u043Ers, "parseFrameAncest\u043Ers");
function matchS\u043EurceExpressi\u043En(source, origin) {
  if (source === "*")
    return true;
  if (source === "'self'") {
    return false;
  }
  if (!source.startsWith("http://") && !source.startsWith("https://")) {
    return false;
  }
  if (!source.includes("*")) {
    return source === origin;
  }
  const escaped = source.replace(/[-/\^$+?.()|[\]{}]/g, "$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(origin);
}
__name(matchS\u043EurceExpressi\u043En, "matchS\u043EurceExpressi\u043En");
function isOriginAll\u043EwedByFrameAncestors(sources, origin, targetOrigin) {
  if (sources.includes("'none'"))
    return false;
  if (sources.includes("*"))
    return true;
  if (!origin) {
    return true;
  }
  if (sources.includes("'self'")) {
    return origin === targetOrigin;
  }
  return sources.some((source) => matchS\u043EurceExpressi\u043En(source, origin));
}
__name(isOriginAll\u043EwedByFrameAncestors, "isOriginAll\u043EwedByFrameAncestors");
async function pr\u043ExySandb\u043ExWebS\u043Ecket(request, env, sandboxSessionId, ptyId, userId, machineId) {
  const sandboxUrl = new URL(`${env.SANDBOX_URL.replace(/\/$/, "")}/sessions/${sandboxSessionId}/ptys/${ptyId}/ws`);
  sandboxUrl.searchParams.set("user_id", userId);
  const headers = new Headers(request.headers);
  headers.set("X-Internal-Token", env.SANDBOX_INTERNAL_TOKEN);
  if (machineId) {
    headers.set("X-Sandbox-Machine-ID", machineId);
  }
  headers.delete("Host");
  const body = ["POST", "PUT", "PATCH"].includes(request.method) ? request.clone().body : void 0;
  const proxyRequest = new Request(sandboxUrl.toString(), {
    method: request.method,
    headers,
    body,
    redirect: "manual"
  });
  return fetch(proxyRequest);
}
__name(pr\u043ExySandb\u043ExWebS\u043Ecket, "pr\u043ExySandb\u043ExWebS\u043Ecket");
async function pr\u043ExySandb\u043ExControlWebS\u043Ecket(request, env, sandboxSessionId, machineId) {
  const sandboxUrl = new URL(`${env.SANDBOX_URL.replace(/\/$/, "")}/sessions/${sandboxSessionId}/control`);
  const headers = new Headers(request.headers);
  headers.set("X-Internal-Token", env.SANDBOX_INTERNAL_TOKEN);
  if (machineId) {
    headers.set("X-Sandbox-Machine-ID", machineId);
  }
  headers.delete("Host");
  const proxyRequest = new Request(sandboxUrl.toString(), {
    method: request.method,
    headers,
    redirect: "manual"
  });
  return fetch(proxyRequest);
}
__name(pr\u043ExySandb\u043ExControlWebS\u043Ecket, "pr\u043ExySandb\u043ExControlWebS\u043Ecket");
async function pr\u043ExySandb\u043ExRequest(request, env, path, machineId) {
  const sandboxUrl = new URL(`${env.SANDBOX_URL.replace(/\/$/, "")}${path}`);
  sandboxUrl.search = new URL(request.url).search;
  const headers = new Headers(request.headers);
  headers.set("X-Internal-Token", env.SANDBOX_INTERNAL_TOKEN);
  if (machineId) {
    headers.set("X-Sandbox-Machine-ID", machineId);
  }
  headers.delete("Host");
  const body = request.method === "GET" || request.method === "HEAD" ? void 0 : request.body;
  const proxyRequest = new Request(sandboxUrl.toString(), {
    method: request.method,
    headers,
    body,
    redirect: "manual"
  });
  return fetch(proxyRequest);
}
__name(pr\u043ExySandb\u043ExRequest, "pr\u043ExySandb\u043ExRequest");
async function pr\u043ExySandb\u043ExWebS\u043EcketPath(request, env, path, machineId) {
  const sandboxUrl = new URL(`${env.SANDBOX_URL.replace(/\/$/, "")}${path}`);
  sandboxUrl.search = new URL(request.url).search;
  const headers = new Headers(request.headers);
  headers.set("X-Internal-Token", env.SANDBOX_INTERNAL_TOKEN);
  if (machineId) {
    headers.set("X-Sandbox-Machine-ID", machineId);
  }
  headers.delete("Host");
  const proxyRequest = new Request(sandboxUrl.toString(), {
    method: request.method,
    headers,
    redirect: "manual"
  });
  return fetch(proxyRequest);
}
__name(pr\u043ExySandb\u043ExWebS\u043EcketPath, "pr\u043ExySandb\u043ExWebS\u043EcketPath");
async function getSessi\u043EnWithAccess(env, sessionId, userId) {
  const session = await env.DB.prepare(`
      SELECT s.* FROM sessions s
      JOIN dashboard_members dm ON s.dashboard_id = dm.dashboard_id
      WHERE s.id = ? AND dm.user_id = ?
    `).bind(sessionId, userId).first();
  return session;
}
__name(getSessi\u043EnWithAccess, "getSessi\u043EnWithAccess");
var src_default = {
  async fetch(request, env) {
    const envWithDb = ensureDb(env);
    const envWithBindings = ensureDriveCache(envWithDb);
    const origin = request.headers.get("Origin");
    const allowedOrigins = parseAll\u043EwedOrigins(envWithBindings);
    if (request.method === "OPTIONS") {
      const headers = {
        "Access-Control-Allow-Methods": CORS_METHODS,
        "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS
      };
      const allowOrigin = origin && (allowedOrigins === null || allowedOrigins.has(origin));
      if (allowOrigin) {
        headers["Access-Control-Allow-Origin"] = origin;
        headers["Vary"] = "Origin";
        headers["Access-Control-Allow-Credentials"] = "true";
      } else if (allowedOrigins === null) {
        headers["Access-Control-Allow-Origin"] = "*";
      }
      return new Response(null, { status: 204, headers });
    }
    try {
      const response = await handleRequest(request, envWithBindings);
      return c\u043ErsResp\u043Ense(response, origin, allowedOrigins);
    } catch (error) {
      if (isDesktopFeatureDisabledError(error)) {
        return c\u043ErsResp\u043Ense(Response.json(
          { error: "Desktop feature disabled", message: error.message },
          { status: 501 }
        ), origin, allowedOrigins);
      }
      console.error("Request error:", error);
      return c\u043ErsResp\u043Ense(Response.json(
        { error: error instanceof Error ? error.message : "Internal server error" },
        { status: 500 }
      ), origin, allowedOrigins);
    }
  },
  // Scheduled handler for cron triggers (runs every minute)
  async scheduled(event, env) {
    const envWithDb = ensureDb(env);
    const envWithBindings = ensureDriveCache(envWithDb);
    await checkAndCacheSandb\u043ExHealth(envWithBindings);
    try {
      await pr\u043EcessDueSchedules(envWithBindings);
    } catch (error) {
      if (isDesktopFeatureDisabledError(error)) {
        return;
      }
      throw error;
    }
  }
};
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (path === "/health" && method === "GET") {
    let sandboxHealth;
    try {
      sandboxHealth = await getCachedHealth(env.DB, "sandbox");
    } catch (error) {
      await initializeDatabase(env.DB);
      return Response.json({
        status: "ok",
        sandbox: "unknown",
        message: "Health check not yet cached (initializing schema)"
      });
    }
    if (!sandboxHealth) {
      return Response.json({
        status: "ok",
        sandbox: "unknown",
        message: "Health check not yet cached (waiting for first cron run)"
      });
    }
    return Response.json({
      status: "ok",
      sandbox: sandboxHealth.isHealthy ? "connected" : "disconnected",
      lastChecked: sandboxHealth.lastCheckAt,
      ...sandboxHealth.consecutiveFailures > 0 && {
        consecutiveFailures: sandboxHealth.consecutiveFailures
      }
    });
  }
  if (path === "/_desktop/db-status" && method === "GET") {
    const authError = requireInternalAuth(request, env);
    if (authError)
      return authError;
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).all();
    return Response.json({
      ok: true,
      tableCount: tables.results.length,
      tables: tables.results.map((row) => row.name)
    });
  }
  if (path === "/init-db" && method === "POST") {
    const authError = requireInternalAuth(request, env);
    if (authError)
      return authError;
    await initializeDatabase(env.DB);
    return Response.json({ success: true, message: "Database initialized" });
  }
  const auth = await authenticate(request, env);
  if (!auth.user) {
    const skipIpRateLimit = path === "/auth/google/callback" || path === "/auth/google/login" || /^\/integrations\/[^/]+\/callback$/.test(path) || /^\/integrations\/[^/]+\/connect$/.test(path);
    if (!skipIpRateLimit) {
      const ipLimitResult = await checkRateLimitIp(request, env);
      if (!ipLimitResult.allowed) {
        return ipLimitResult.response;
      }
    }
  }
  if (auth.user) {
    const userLimitResult = await checkRateLimitUser(auth.user.id, env);
    if (!userLimitResult.allowed) {
      return userLimitResult.response;
    }
  }
  const segments = path.split("/").filter(Boolean);
  if (segments[0] === "auth" && segments[1] === "google" && segments[2] === "login" && method === "GET") {
    return loginWithGoogle(request, env);
  }
  if (segments[0] === "auth" && segments[1] === "google" && segments[2] === "callback" && method === "GET") {
    return callbackGoogle(request, env);
  }
  if (segments[0] === "auth" && segments[1] === "logout" && segments.length === 2 && method === "POST") {
    return logout(request, env);
  }
  if (segments[0] === "auth" && segments[1] === "dev" && segments[2] === "session" && method === "POST") {
    if (env.DEV_AUTH_ENABLED !== "true") {
      return Response.json({ error: "E79406: Dev auth disabled" }, { status: 403 });
    }
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const session = await createUserSession(env, auth.user.id);
    const cookie = buildSessionCookie(request, session.id, session.expiresAt);
    return new Response(null, {
      status: 204,
      headers: {
        "Set-Cookie": cookie
      }
    });
  }
  if (segments[0] === "embed-check" && segments.length === 1 && method === "GET") {
    const authError = requireAuth(auth);
    if (authError && env.DEV_AUTH_ENABLED !== "true") {
      return authError;
    }
    const targetUrlParam = url.searchParams.get("url");
    if (!targetUrlParam) {
      return Response.json({ error: "E79733: Missing url parameter" }, { status: 400 });
    }
    let targetUrl;
    try {
      targetUrl = new URL(targetUrlParam);
    } catch {
      return Response.json({ error: "E79734: Invalid url parameter" }, { status: 400 });
    }
    if (!EMBED_ALLOWED_PROTOCOLS.has(targetUrl.protocol)) {
      return Response.json({ error: "E79735: Unsupported URL protocol" }, { status: 400 });
    }
    if (isPrivateH\u043Estname(targetUrl.hostname)) {
      return Response.json({ error: "E79736: URL not allowed" }, { status: 400 });
    }
    const originParam = url.searchParams.get("origin") || request.headers.get("Origin");
    let origin = null;
    try {
      if (originParam) {
        origin = new URL(originParam).origin;
      }
    } catch {
      origin = null;
    }
    let response;
    try {
      response = await fetch(targetUrl.toString(), { method: "HEAD", redirect: "follow" });
      if (response.status === 405 || response.status === 501) {
        response = await fetch(targetUrl.toString(), {
          method: "GET",
          headers: { Range: "bytes=0-0" },
          redirect: "follow"
        });
      }
    } catch (error) {
      console.warn("Embed check fetch failed:", error);
      return Response.json({ embeddable: true, reason: "fetch_failed" });
    }
    const checkedUrl = response.url || targetUrl.toString();
    const checkedOrigin = new URL(checkedUrl).origin;
    const xfo = response.headers.get("x-frame-options");
    const csp = response.headers.get("content-security-policy");
    let embeddable = true;
    let reason;
    if (xfo) {
      const value = xfo.toLowerCase();
      if (value.includes("deny")) {
        embeddable = false;
        reason = "x_frame_options_deny";
      } else if (value.includes("sameorigin")) {
        embeddable = origin === checkedOrigin;
        reason = embeddable ? void 0 : "x_frame_options_sameorigin";
      } else if (value.includes("allow-from")) {
        embeddable = origin ? value.includes(origin) : false;
        reason = embeddable ? void 0 : "x_frame_options_allow_from";
      }
    }
    if (embeddable) {
      const ancestors = parseFrameAncest\u043Ers(csp);
      if (ancestors) {
        embeddable = isOriginAll\u043EwedByFrameAncestors(ancestors, origin, checkedOrigin);
        if (!embeddable) {
          reason = "frame_ancestors";
        }
      }
    }
    return Response.json({
      embeddable,
      reason,
      checkedUrl
    });
  }
  if (segments[0] === "dashboards" && segments.length === 1 && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return listDashb\u043Eards(env, auth.user.id);
  }
  if (segments[0] === "dashboards" && segments.length === 1 && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    return createDashb\u043Eard(env, auth.user.id, data);
  }
  if (segments[0] === "dashboards" && segments.length === 2 && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return getDashb\u043Eard(env, segments[1], auth.user.id);
  }
  if (segments[0] === "dashboards" && segments.length === 2 && method === "PUT") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    return updateDashb\u043Eard(env, segments[1], auth.user.id, data);
  }
  if (segments[0] === "dashboards" && segments.length === 2 && method === "DELETE") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return deleteDashb\u043Eard(env, segments[1], auth.user.id);
  }
  if (segments[0] === "dashboards" && segments.length === 3 && segments[2] === "ws") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return c\u043EnnectWebS\u043Ecket(
      env,
      segments[1],
      auth.user.id,
      auth.user.name,
      request
    );
  }
  if (segments[0] === "dashboards" && segments.length === 3 && segments[2] === "items" && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    return upsertItem(env, segments[1], auth.user.id, data);
  }
  if (segments[0] === "dashboards" && segments.length === 4 && segments[2] === "items" && method === "PUT") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    return upsertItem(env, segments[1], auth.user.id, { ...data, id: segments[3] });
  }
  if (segments[0] === "dashboards" && segments.length === 4 && segments[2] === "items" && method === "DELETE") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return deleteItem(env, segments[1], segments[3], auth.user.id);
  }
  if (segments[0] === "dashboards" && segments.length === 3 && segments[2] === "edges" && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    return createEdge(env, segments[1], auth.user.id, data);
  }
  if (segments[0] === "dashboards" && segments.length === 4 && segments[2] === "edges" && method === "DELETE") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return deleteEdge(env, segments[1], segments[3], auth.user.id);
  }
  if (segments[0] === "subagents" && segments.length === 1 && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return listSubagents(env, auth.user.id);
  }
  if (segments[0] === "secrets" && segments.length === 1 && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const url2 = new URL(request.url);
    const dashboardId = url2.searchParams.get("dashboard_id");
    return listSecrets(env, auth.user.id, dashboardId);
  }
  if (segments[0] === "integrations") {
    const routeKey = `${method} ${segments.slice(1).join("/")}`;
    const integrationRoutes = {
      "GET google/drive/connect": c\u043EnnectG\u043E\u043EgleDrive,
      "GET google/drive/callback": (request2, env2) => callbackG\u043E\u043EgleDrive(request2, env2),
      "GET google/drive": getG\u043E\u043EgleDriveIntegrati\u043En,
      "GET google/drive/picker": renderG\u043E\u043EgleDrivePicker,
      "POST google/drive/folder": setG\u043E\u043EgleDriveF\u043Elder,
      "DELETE google/drive/folder": unlinkG\u043E\u043EgleDriveF\u043Elder,
      "GET google/drive/status": getG\u043E\u043EgleDriveSyncStatus,
      "GET google/drive/manifest": getG\u043E\u043EgleDriveManifest,
      "POST google/drive/sync": syncG\u043E\u043EgleDriveMirr\u043Er,
      "POST google/drive/sync/large": syncG\u043E\u043EgleDriveLargeFiles,
      "GET github/connect": c\u043EnnectGithub,
      "GET github/callback": (request2, env2) => callbackGithub(request2, env2),
      "GET github": getGithubIntegrati\u043En,
      "GET github/repos": getGithubRep\u043Es,
      "POST github/repo": setGithubRep\u043E,
      "DELETE github/repo": unlinkGithubRep\u043E,
      "GET github/status": getGithubSyncStatus,
      "POST github/sync": syncGithubMirr\u043Er,
      "POST github/sync/large": syncGithubLargeFiles,
      "GET github/manifest": getGithubManifest,
      "GET box/connect": c\u043EnnectB\u043Ex,
      "GET box/callback": (request2, env2) => callbackB\u043Ex(request2, env2),
      "GET box": getB\u043ExIntegrati\u043En,
      "GET box/folders": getB\u043ExF\u043Elders,
      "POST box/folder": setB\u043ExF\u043Elder,
      "DELETE box/folder": unlinkB\u043ExF\u043Elder,
      "GET box/status": getB\u043ExSyncStatus,
      "POST box/sync": syncB\u043ExMirr\u043Er,
      "POST box/sync/large": syncB\u043ExLargeFiles,
      "GET box/manifest": getB\u043ExManifest,
      "GET onedrive/connect": c\u043Ennect\u041Enedrive,
      "GET onedrive/callback": (request2, env2) => callback\u041Enedrive(request2, env2),
      "GET onedrive": get\u041EnedriveIntegrati\u043En,
      "GET onedrive/folders": get\u041EnedriveF\u043Elders,
      "POST onedrive/folder": set\u041EnedriveF\u043Elder,
      "DELETE onedrive/folder": unlink\u041EnedriveF\u043Elder,
      "GET onedrive/status": get\u041EnedriveSyncStatus,
      "POST onedrive/sync": sync\u041EnedriveMirr\u043Er,
      "POST onedrive/sync/large": sync\u041EnedriveLargeFiles,
      "GET onedrive/manifest": get\u041EnedriveManifest
    };
    const handler = integrationRoutes[routeKey];
    if (handler) {
      return handler(request, env, auth);
    }
  }
  if (segments[0] === "subagents" && segments.length === 1 && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    return createSubagent(env, auth.user.id, data);
  }
  if (segments[0] === "secrets" && segments.length === 1 && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    return createSecret(env, auth.user.id, data);
  }
  if (segments[0] === "subagents" && segments.length === 2 && method === "DELETE") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return deleteSubagent(env, auth.user.id, segments[1]);
  }
  if (segments[0] === "secrets" && segments.length === 2 && method === "DELETE") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const url2 = new URL(request.url);
    const dashboardId = url2.searchParams.get("dashboard_id");
    return deleteSecret(env, auth.user.id, segments[1], dashboardId);
  }
  if (segments[0] === "agent-skills" && segments.length === 1 && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return listAgentSkills(env, auth.user.id);
  }
  if (segments[0] === "agent-skills" && segments.length === 1 && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    return createAgentSkill(env, auth.user.id, data);
  }
  if (segments[0] === "agent-skills" && segments.length === 2 && method === "DELETE") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return deleteAgentSkill(env, auth.user.id, segments[1]);
  }
  if (segments[0] === "mcp-tools" && segments.length === 1 && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return listMcpT\u043E\u043Els(env, auth.user.id);
  }
  if (segments[0] === "mcp-tools" && segments.length === 1 && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    return createMcpT\u043E\u043El(env, auth.user.id, data);
  }
  if (segments[0] === "mcp-tools" && segments.length === 2 && method === "DELETE") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return deleteMcpT\u043E\u043El(env, auth.user.id, segments[1]);
  }
  if (segments[0] === "dashboards" && segments.length === 5 && segments[2] === "items" && segments[4] === "session" && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return createSessi\u043En(env, segments[1], segments[3], auth.user.id, auth.user.name);
  }
  if (segments[0] === "dashboards" && segments.length === 4 && segments[2] === "browser" && segments[3] === "start" && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return startDashb\u043EardBrowser(env, segments[1], auth.user.id);
  }
  if (segments[0] === "dashboards" && segments.length === 4 && segments[2] === "browser" && segments[3] === "stop" && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return st\u043EpDashb\u043EardBrowser(env, segments[1], auth.user.id);
  }
  if (segments[0] === "dashboards" && segments.length === 4 && segments[2] === "browser" && segments[3] === "status" && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return getDashb\u043EardBrowserStatus(env, segments[1], auth.user.id);
  }
  if (segments[0] === "dashboards" && segments.length === 4 && segments[2] === "browser" && segments[3] === "open" && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    const url2 = typeof data.url === "string" ? data.url : "";
    return openDashb\u043EardBrowser(env, segments[1], auth.user.id, url2);
  }
  if (segments[0] === "dashboards" && segments[2] === "browser" && method === "GET") {
    const authError = requireAuth(auth);
    const allowDevBypass = env.DEV_AUTH_ENABLED === "true" && Boolean(authError);
    if (authError && env.DEV_AUTH_ENABLED === "true" && env.BROWSER_AUTH_DEBUG === "true") {
      const url2 = new URL(request.url);
      const suffix2 = segments.slice(3).join("/");
      const isAssetRequest = Boolean(suffix2) && !suffix2.startsWith("websockify");
      if (!isAssetRequest) {
        console.log("[desktop][browser-auth] missing auth", {
          path: url2.pathname,
          hasUserIdHeader: Boolean(request.headers.get("X-User-ID")),
          hasUserEmailHeader: Boolean(request.headers.get("X-User-Email")),
          hasUserNameHeader: Boolean(request.headers.get("X-User-Name")),
          userIdParam: url2.searchParams.get("user_id"),
          userEmailParam: url2.searchParams.get("user_email"),
          userNameParam: url2.searchParams.get("user_name")
        });
      }
    }
    if (authError && !allowDevBypass)
      return authError;
    if (!allowDevBypass) {
      const access = await env.DB.prepare(`
        SELECT 1 FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?
      `).bind(segments[1], auth.user.id).first();
      if (!access) {
        return Response.json({ error: "E79301: Not found or no access" }, { status: 404 });
      }
    }
    const sandbox = await env.DB.prepare(`
      SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes WHERE dashboard_id = ?
    `).bind(segments[1]).first();
    if (!sandbox?.sandbox_session_id) {
      return Response.json({ error: "E79816: Browser session not found" }, { status: 404 });
    }
    const suffix = segments.slice(3).join("/");
    const path2 = suffix ? `/sessions/${sandbox.sandbox_session_id}/browser/${suffix}` : `/sessions/${sandbox.sandbox_session_id}/browser`;
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
      return pr\u043ExySandb\u043ExWebS\u043EcketPath(
        request,
        env,
        path2,
        sandbox.sandbox_machine_id
      );
    }
    const proxyResponse = await pr\u043ExySandb\u043ExRequest(
      request,
      env,
      path2,
      sandbox.sandbox_machine_id
    );
    if (proxyResponse.status === 101) {
      return proxyResponse;
    }
    const framedResponse = new Response(proxyResponse.body, proxyResponse);
    const headers = framedResponse.headers;
    const frontendUrl = env.FRONTEND_URL || "";
    if (frontendUrl) {
      headers.set("Content-Security-Policy", `frame-ancestors ${frontendUrl}`);
    }
    headers.delete("X-Frame-Options");
    return framedResponse;
  }
  if (segments[0] === "sessions" && segments.length === 2 && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return getSessi\u043En(env, segments[1], auth.user.id);
  }
  if (segments[0] === "sessions" && segments.length === 3 && segments[2] === "control" && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const session = await getSessi\u043EnWithAccess(env, segments[1], auth.user.id);
    if (!session) {
      return Response.json({ error: "E79737: Session not found or no access" }, { status: 404 });
    }
    if (session.owner_user_id !== auth.user.id) {
      return Response.json({ error: "E79738: Only the owner can control the session" }, { status: 403 });
    }
    return pr\u043ExySandb\u043ExControlWebS\u043Ecket(
      request,
      env,
      session.sandbox_session_id,
      session.sandbox_machine_id
    );
  }
  if (segments[0] === "sessions" && segments.length === 3 && segments[2] === "env" && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    return updateSessi\u043EnEnv(env, segments[1], auth.user.id, data);
  }
  if (segments[0] === "sessions" && segments.length === 3 && segments[2] === "files" && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const session = await getSessi\u043EnWithAccess(env, segments[1], auth.user.id);
    if (!session) {
      return Response.json({ error: "E79737: Session not found or no access" }, { status: 404 });
    }
    return pr\u043ExySandb\u043ExRequest(
      request,
      env,
      `/sessions/${session.sandbox_session_id}/files`,
      session.sandbox_machine_id
    );
  }
  if (segments[0] === "sessions" && segments.length === 3 && segments[2] === "metrics" && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const session = await getSessi\u043EnWithAccess(env, segments[1], auth.user.id);
    if (!session) {
      return Response.json({ error: "E79737: Session not found or no access" }, { status: 404 });
    }
    return pr\u043ExySandb\u043ExRequest(
      request,
      env,
      `/sessions/${session.sandbox_session_id}/metrics`,
      session.sandbox_machine_id
    );
  }
  if (segments[0] === "sessions" && segments.length === 3 && segments[2] === "file" && method === "DELETE") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const session = await getSessi\u043EnWithAccess(env, segments[1], auth.user.id);
    if (!session) {
      return Response.json({ error: "E79737: Session not found or no access" }, { status: 404 });
    }
    if (session.owner_user_id !== auth.user.id) {
      return Response.json({ error: "E79738: Only the owner can delete files" }, { status: 403 });
    }
    return pr\u043ExySandb\u043ExRequest(
      request,
      env,
      `/sessions/${session.sandbox_session_id}/file`,
      session.sandbox_machine_id
    );
  }
  if (segments[0] === "users" && segments.length === 2 && segments[1] === "me" && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return Response.json({ user: auth.user });
  }
  if (segments[0] === "sessions" && segments.length === 2 && method === "DELETE") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return st\u043EpSessi\u043En(env, segments[1], auth.user.id);
  }
  if (segments[0] === "sessions" && segments.length === 5 && segments[2] === "ptys" && segments[4] === "ws" && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const session = await getSessi\u043EnWithAccess(env, segments[1], auth.user.id);
    if (!session) {
      return Response.json({ error: "E79737: Session not found or no access" }, { status: 404 });
    }
    if (session.pty_id !== segments[3]) {
      return Response.json({ error: "E79739: PTY not found" }, { status: 404 });
    }
    const proxyUserId = session.owner_user_id === auth.user.id ? auth.user.id : "";
    const proxyResponse = await pr\u043ExySandb\u043ExWebS\u043Ecket(
      request,
      env,
      session.sandbox_session_id,
      session.pty_id,
      proxyUserId,
      session.sandbox_machine_id
    );
    if (proxyResponse.status === 404 && session.status !== "stopped") {
      const now = (/* @__PURE__ */ new Date()).toISOString();
      await env.DB.prepare(`
        UPDATE sessions SET status = 'stopped', stopped_at = ? WHERE id = ?
      `).bind(now, session.id).run();
      const updatedSession = {
        id: session.id,
        dashboardId: session.dashboard_id,
        itemId: session.item_id,
        ownerUserId: session.owner_user_id,
        ownerName: session.owner_name,
        sandboxSessionId: session.sandbox_session_id,
        sandboxMachineId: session.sandbox_machine_id,
        ptyId: session.pty_id,
        status: "stopped",
        region: session.region,
        createdAt: session.created_at,
        stoppedAt: now
      };
      const doId = env.DASHBOARD.idFromName(session.dashboard_id);
      const stub = env.DASHBOARD.get(doId);
      await stub.fetch(new Request("http://do/session", {
        method: "PUT",
        body: JSON.stringify(updatedSession)
      }));
      return Response.json({ error: "E79740: PTY not found (session expired)" }, { status: 410 });
    }
    return proxyResponse;
  }
  if (segments[0] === "recipes" && segments.length === 1 && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const dashboardId = url.searchParams.get("dashboard_id") || void 0;
    return listRecip\u0435s(env, auth.user.id, dashboardId);
  }
  if (segments[0] === "recipes" && segments.length === 1 && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    return createRecip\u0435(env, auth.user.id, data);
  }
  if (segments[0] === "recipes" && segments.length === 2 && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return getRecip\u0435(env, segments[1], auth.user.id);
  }
  if (segments[0] === "recipes" && segments.length === 2 && method === "PUT") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    return updateRecipe(env, segments[1], auth.user.id, data);
  }
  if (segments[0] === "recipes" && segments.length === 2 && method === "DELETE") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return deleteRecipe(env, segments[1], auth.user.id);
  }
  if (segments[0] === "recipes" && segments.length === 3 && segments[2] === "executions" && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return listExecuti\u043Ens(env, segments[1], auth.user.id);
  }
  if (segments[0] === "recipes" && segments.length === 3 && segments[2] === "execute" && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json().catch(() => ({}));
    return startExecuti\u043En(env, segments[1], auth.user.id, data.context);
  }
  if (segments[0] === "executions" && segments.length === 2 && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return getExecuti\u043En(env, segments[1], auth.user.id);
  }
  if (segments[0] === "executions" && segments.length === 3 && segments[2] === "pause" && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return pauseExecuti\u043En(env, segments[1], auth.user.id);
  }
  if (segments[0] === "executions" && segments.length === 3 && segments[2] === "resume" && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return resumeExecuti\u043En(env, segments[1], auth.user.id);
  }
  if (segments[0] === "internal" && segments[1] === "executions" && segments.length === 4 && segments[3] === "artifacts" && method === "POST") {
    const authError = requireInternalAuth(request, env);
    if (authError)
      return authError;
    const data = await request.json();
    return addArtifact(env, segments[2], data);
  }
  if (segments[0] === "internal" && segments[1] === "drive" && segments[2] === "manifest" && method === "GET") {
    const authError = requireInternalAuth(request, env);
    if (authError)
      return authError;
    return getDriveManifestInternal(request, env);
  }
  if (segments[0] === "internal" && segments[1] === "drive" && segments[2] === "file" && method === "GET") {
    const authError = requireInternalAuth(request, env);
    if (authError)
      return authError;
    return getDriveFileInternal(request, env);
  }
  if (segments[0] === "internal" && segments[1] === "drive" && segments[2] === "sync" && segments[3] === "progress" && method === "POST") {
    const authError = requireInternalAuth(request, env);
    if (authError)
      return authError;
    return updateDriveSyncPr\u043EgressInternal(request, env);
  }
  if (segments[0] === "internal" && segments[1] === "mirror" && segments[2] === "manifest" && method === "GET") {
    const authError = requireInternalAuth(request, env);
    if (authError)
      return authError;
    return getMirr\u043ErManifestInternal(request, env);
  }
  if (segments[0] === "internal" && segments[1] === "mirror" && segments[2] === "file" && method === "GET") {
    const authError = requireInternalAuth(request, env);
    if (authError)
      return authError;
    return getMirr\u043ErFileInternal(request, env);
  }
  if (segments[0] === "internal" && segments[1] === "mirror" && segments[2] === "sync" && segments[3] === "progress" && method === "POST") {
    const authError = requireInternalAuth(request, env);
    if (authError)
      return authError;
    return updateMirr\u043ErSyncPr\u043EgressInternal(request, env);
  }
  if (segments[0] === "internal" && segments[1] === "browser" && segments[2] === "open" && method === "POST") {
    const authError = requireInternalAuth(request, env);
    if (authError)
      return authError;
    const data = await request.json();
    const sandboxSessionId = typeof data.sandbox_session_id === "string" ? data.sandbox_session_id : "";
    const url2 = typeof data.url === "string" ? data.url : "";
    return openBrowserFromSandb\u043ExSessionInternal(env, sandboxSessionId, url2);
  }
  if (segments[0] === "schedules" && segments.length === 1 && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const recipeId = url.searchParams.get("recipe_id") || void 0;
    return listSchedules(env, auth.user.id, recipeId);
  }
  if (segments[0] === "schedules" && segments.length === 1 && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    return createSchedule(env, auth.user.id, data);
  }
  if (segments[0] === "schedules" && segments.length === 2 && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return getSchedule(env, segments[1], auth.user.id);
  }
  if (segments[0] === "schedules" && segments.length === 2 && method === "PUT") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    return updateSchedule(env, segments[1], auth.user.id, data);
  }
  if (segments[0] === "schedules" && segments.length === 2 && method === "DELETE") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return d\u0435leteSchedule(env, segments[1], auth.user.id);
  }
  if (segments[0] === "schedules" && segments.length === 3 && segments[2] === "enable" && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return enableSchedule(env, segments[1], auth.user.id);
  }
  if (segments[0] === "schedules" && segments.length === 3 && segments[2] === "disable" && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return disableSchedule(env, segments[1], auth.user.id);
  }
  if (segments[0] === "schedules" && segments.length === 3 && segments[2] === "trigger" && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return triggerSchedule(env, segments[1], auth.user.id);
  }
  if (segments[0] === "internal" && segments[1] === "events" && segments.length === 2 && method === "POST") {
    const authError = requireInternalAuth(request, env);
    if (authError)
      return authError;
    const data = await request.json();
    return emitEvent(env, data.event, data.payload);
  }
  return Response.json({ error: "E79740: Not found" }, { status: 404 });
}
__name(handleRequest, "handleRequest");
export {
  DashboardDO,
  src_default as default
};
//# sourceMappingURL=index.js.map
