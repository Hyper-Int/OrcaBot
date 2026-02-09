var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/auth/dashboard-token.ts
function base64UrlEncode(data) {
  let str;
  if (typeof data === "string") {
    str = data;
  } else {
    let binary = "";
    for (let i = 0; i < data.length; i++) {
      binary += String.fromCharCode(data[i]);
    }
    str = binary;
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlDecode2(str) {
  const padded = str + "=".repeat((4 - str.length % 4) % 4);
  return atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
}
async function hmacSign(data, secret) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(data);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, messageData);
  return base64UrlEncode(new Uint8Array(signature));
}
async function hmacVerify(data, signature, secret) {
  const expectedSignature = await hmacSign(data, secret);
  if (signature.length !== expectedSignature.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
  }
  return result === 0;
}
async function createDashboardToken(dashboardId, secret, sessionId) {
  const now = Math.floor(Date.now() / 1e3);
  const header = { alg: ALGORITHM, typ: "JWT" };
  const payload = {
    dashboard_id: dashboardId,
    aud: TOKEN_AUDIENCE,
    exp: now + TOKEN_EXPIRY_SECONDS,
    iat: now,
    ...sessionId && { session_id: sessionId }
  };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const dataToSign = `${headerB64}.${payloadB64}`;
  const signature = await hmacSign(dataToSign, secret);
  return `${dataToSign}.${signature}`;
}
async function verifyDashboardToken(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [headerB64, payloadB64, signature] = parts;
  const dataToVerify = `${headerB64}.${payloadB64}`;
  const valid = await hmacVerify(dataToVerify, signature, secret);
  if (!valid) {
    return null;
  }
  try {
    const header = JSON.parse(base64UrlDecode2(headerB64));
    if (header.alg !== ALGORITHM || header.typ !== "JWT") {
      return null;
    }
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(base64UrlDecode2(payloadB64));
    if (!payload.dashboard_id || !payload.aud || !payload.exp) {
      return null;
    }
    if (payload.aud !== TOKEN_AUDIENCE) {
      return null;
    }
    const now = Math.floor(Date.now() / 1e3);
    if (payload.exp < now) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
var ALGORITHM, TOKEN_AUDIENCE, TOKEN_EXPIRY_SECONDS;
var init_dashboard_token = __esm({
  "src/auth/dashboard-token.ts"() {
    "use strict";
    ALGORITHM = "HS256";
    TOKEN_AUDIENCE = "mcp-ui";
    TOKEN_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
    __name(base64UrlEncode, "base64UrlEncode");
    __name(base64UrlDecode2, "base64UrlDecode");
    __name(hmacSign, "hmacSign");
    __name(hmacVerify, "hmacVerify");
    __name(createDashboardToken, "createDashboardToken");
    __name(verifyDashboardToken, "verifyDashboardToken");
  }
});

// src/storage/drive-cache.ts
function ensureDriveCache(env) {
  if (env.DRIVE_CACHE) {
    return env;
  }
  return {
    ...env,
    DRIVE_CACHE: disabledDriveCache
  };
}
function isDesktopFeatureDisabledError(error) {
  return error instanceof DesktopFeatureDisabledError || error instanceof Error && error.name === "DesktopFeatureDisabledError";
}
var DesktopFeatureDisabledError, disabledError, disabledDriveCache;
var init_drive_cache = __esm({
  "src/storage/drive-cache.ts"() {
    "use strict";
    DesktopFeatureDisabledError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "DesktopFeatureDisabledError";
      }
    };
    __name(DesktopFeatureDisabledError, "DesktopFeatureDisabledError");
    disabledError = new DesktopFeatureDisabledError(
      "Drive cache is not available in desktop mode."
    );
    disabledDriveCache = {
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
    __name(ensureDriveCache, "ensureDriveCache");
    __name(isDesktopFeatureDisabledError, "isDesktopFeatureDisabledError");
  }
});

// src/sandbox/client.ts
var SandboxClient;
var init_client = __esm({
  "src/sandbox/client.ts"() {
    "use strict";
    SandboxClient = class {
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
      async createSessi\u043En(dashboardId, mcpToken) {
        const headers = new Headers(this.authHeaders());
        let body;
        if (dashboardId || mcpToken) {
          headers.set("Content-Type", "application/json");
          body = JSON.stringify({
            dashboard_id: dashboardId,
            mcp_token: mcpToken
            // Scoped token for MCP proxy calls
          });
        }
        const res = await fetch(`${this.baseUrl}/sessions`, {
          method: "POST",
          headers,
          body
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
        const secretsSnakeCase = payload.secrets ? Object.fromEntries(
          Object.entries(payload.secrets).map(([name, config]) => [
            name,
            { value: config.value, broker_protected: config.brokerProtected }
          ])
        ) : void 0;
        const approvedDomainsSnakeCase = payload.approvedDomains?.map((ad) => ({
          secret_name: ad.secretName,
          domain: ad.domain,
          header_name: ad.headerName,
          header_format: ad.headerFormat
        }));
        const body = {
          set: payload.set,
          secrets: secretsSnakeCase,
          approved_domains: approvedDomainsSnakeCase,
          unset: payload.unset,
          apply_now: payload.applyNow
        };
        const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/env`, {
          method: "POST",
          headers,
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          const errorText = await res.text();
          console.error(`[sandbox] Failed to update env: ${res.status} - ${errorText}`);
          throw new Error(`Failed to update env: ${res.status}`);
        }
      }
      // PTY management
      // REVISION: working-dir-v1-createpty
      async createPty(sessionId, creatorId, command, machineId, options) {
        const shouldSendBody = Boolean(creatorId || command || options?.ptyId || options?.integrationToken || options?.workingDir || options?.executionId);
        const body = shouldSendBody ? JSON.stringify({
          creator_id: creatorId,
          command,
          // If control plane provides an ID, sandbox should use it
          pty_id: options?.ptyId,
          // Integration token bound to this PTY
          integration_token: options?.integrationToken,
          // Working directory relative to workspace root
          working_dir: options?.workingDir,
          // Execution ID for schedule tracking — stored before process starts
          execution_id: options?.executionId
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
          const errorBody = await res.text().catch(() => "(no body)");
          console.error(`[createPty] FAILED status=${res.status} sessionId=${sessionId} command=${JSON.stringify(command)} machineId=${machineId} body=${errorBody}`);
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
      // Write text to an existing PTY via HTTP (bypasses turn-taking for system automation)
      // REVISION: server-side-cron-v1-write-pty
      async writePty(sessionId, ptyId, text, machineId, executionId) {
        const headers = new Headers(this.authHeaders());
        headers.set("Content-Type", "application/json");
        if (machineId) {
          headers.set("X-Sandbox-Machine-ID", machineId);
        }
        if (executionId) {
          headers.set("X-Execution-ID", executionId);
        }
        const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/ptys/${ptyId}/write`, {
          method: "POST",
          headers,
          body: JSON.stringify({ text })
        });
        if (!res.ok) {
          const errorBody = await res.text().catch(() => "(no body)");
          console.error(`[writePty] FAILED status=${res.status} sessionId=${sessionId} ptyId=${ptyId} body=${errorBody}`);
          throw new Error(`Failed to write to PTY: ${res.status}`);
        }
      }
    };
    __name(SandboxClient, "SandboxClient");
  }
});

// src/auth/pty-token.ts
function base64UrlEncode2(data) {
  let str;
  if (typeof data === "string") {
    str = data;
  } else {
    let binary = "";
    for (let i = 0; i < data.length; i++) {
      binary += String.fromCharCode(data[i]);
    }
    str = binary;
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlDecode3(str) {
  const padded = str + "=".repeat((4 - str.length % 4) % 4);
  return atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
}
async function hmacSign2(data, secret) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(data);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, messageData);
  return base64UrlEncode2(new Uint8Array(signature));
}
async function hmacVerify2(data, signature, secret) {
  const expectedSignature = await hmacSign2(data, secret);
  if (signature.length !== expectedSignature.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
  }
  return result === 0;
}
async function createPtyToken(terminalId, sandboxId, dashboardId, userId, secret) {
  const now = Math.floor(Date.now() / 1e3);
  const header = { alg: ALGORITHM2, typ: "JWT" };
  const payload = {
    terminal_id: terminalId,
    sandbox_id: sandboxId,
    dashboard_id: dashboardId,
    user_id: userId,
    aud: TOKEN_AUDIENCE2,
    exp: now + TOKEN_EXPIRY_SECONDS2,
    iat: now
  };
  const headerB64 = base64UrlEncode2(JSON.stringify(header));
  const payloadB64 = base64UrlEncode2(JSON.stringify(payload));
  const dataToSign = `${headerB64}.${payloadB64}`;
  const signature = await hmacSign2(dataToSign, secret);
  return `${dataToSign}.${signature}`;
}
async function verifyPtyToken(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [headerB64, payloadB64, signature] = parts;
  const dataToVerify = `${headerB64}.${payloadB64}`;
  const valid = await hmacVerify2(dataToVerify, signature, secret);
  if (!valid) {
    return null;
  }
  try {
    const header = JSON.parse(base64UrlDecode3(headerB64));
    if (header.alg !== ALGORITHM2 || header.typ !== "JWT") {
      return null;
    }
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(base64UrlDecode3(payloadB64));
    if (!payload.terminal_id || !payload.sandbox_id || !payload.dashboard_id || !payload.user_id || !payload.aud || !payload.exp) {
      return null;
    }
    if (payload.aud !== TOKEN_AUDIENCE2) {
      return null;
    }
    const now = Math.floor(Date.now() / 1e3);
    if (payload.exp < now) {
      return null;
    }
    const CLOCK_SKEW_TOLERANCE = 60;
    if (payload.iat && payload.iat > now + CLOCK_SKEW_TOLERANCE) {
      console.warn(`[pty-token] Rejecting token with future iat: ${payload.iat} > ${now + CLOCK_SKEW_TOLERANCE}`);
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
var ALGORITHM2, TOKEN_AUDIENCE2, TOKEN_EXPIRY_SECONDS2;
var init_pty_token = __esm({
  "src/auth/pty-token.ts"() {
    "use strict";
    ALGORITHM2 = "HS256";
    TOKEN_AUDIENCE2 = "integration-gateway";
    TOKEN_EXPIRY_SECONDS2 = 24 * 60 * 60;
    __name(base64UrlEncode2, "base64UrlEncode");
    __name(base64UrlDecode3, "base64UrlDecode");
    __name(hmacSign2, "hmacSign");
    __name(hmacVerify2, "hmacVerify");
    __name(createPtyToken, "createPtyToken");
    __name(verifyPtyToken, "verifyPtyToken");
  }
});

// src/sandbox/fetch.ts
function sandboxUrl(env, path) {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return new URL(path);
  }
  const base = env.SANDBOX_URL.replace(/\/$/, "");
  return new URL(`${base}${path.startsWith("/") ? "" : "/"}${path}`);
}
function sandboxHeaders(env, headers, machineId) {
  const result = new Headers(headers);
  result.set("X-Internal-Token", env.SANDBOX_INTERNAL_TOKEN);
  if (machineId) {
    result.set("X-Sandbox-Machine-ID", machineId);
  }
  return result;
}
async function sandboxFetch(env, path, options = {}) {
  const {
    machineId,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    headers,
    ...init
  } = options;
  const url = sandboxUrl(env, path);
  const requestHeaders = sandboxHeaders(env, headers, machineId);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url.toString(), {
        ...init,
        headers: requestHeaders,
        signal: controller.signal
      });
    } catch (error) {
      lastError = error;
      if (attempt >= retries)
        break;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw lastError;
}
var DEFAULT_TIMEOUT_MS, DEFAULT_RETRIES, DEFAULT_RETRY_DELAY_MS;
var init_fetch = __esm({
  "src/sandbox/fetch.ts"() {
    "use strict";
    DEFAULT_TIMEOUT_MS = 1e4;
    DEFAULT_RETRIES = 1;
    DEFAULT_RETRY_DELAY_MS = 250;
    __name(sandboxUrl, "sandboxUrl");
    __name(sandboxHeaders, "sandboxHeaders");
    __name(sandboxFetch, "sandboxFetch");
  }
});

// src/crypto/secrets.ts
async function importEncryptionKey(base64Key) {
  const keyBytes = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  if (keyBytes.length !== 32) {
    throw new Error("SECRETS_ENCRYPTION_KEY must be 32 bytes (256 bits)");
  }
  return crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
async function getEncryptionKey(env) {
  const keySource = env.SECRETS_ENCRYPTION_KEY;
  if (!keySource) {
    throw new Error("SECRETS_ENCRYPTION_KEY not configured");
  }
  if (cachedKey && cachedKeySource === keySource) {
    return cachedKey;
  }
  cachedKey = await importEncryptionKey(keySource);
  cachedKeySource = keySource;
  return cachedKey;
}
function hasEncryptionKey(env) {
  return !!env.SECRETS_ENCRYPTION_KEY;
}
async function encryptSecret(plaintext, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const plaintextBytes = encoder.encode(plaintext);
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintextBytes
  );
  const ivBase64 = btoa(String.fromCharCode(...iv));
  const ciphertextBase64 = btoa(String.fromCharCode(...new Uint8Array(ciphertextBuffer)));
  return `${ivBase64}:${ciphertextBase64}`;
}
async function decryptSecret(encrypted, key) {
  const colonIndex = encrypted.indexOf(":");
  if (colonIndex === -1) {
    throw new Error("Invalid encrypted format: missing IV separator");
  }
  const ivBase64 = encrypted.substring(0, colonIndex);
  const ciphertextBase64 = encrypted.substring(colonIndex + 1);
  const iv = Uint8Array.from(atob(ivBase64), (c) => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(ciphertextBase64), (c) => c.charCodeAt(0));
  if (iv.length !== 12) {
    throw new Error("Invalid IV length");
  }
  const plaintextBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );
  const decoder = new TextDecoder();
  return decoder.decode(plaintextBuffer);
}
function isEncryptedValue(value) {
  const colonIndex = value.indexOf(":");
  if (colonIndex === -1) {
    return false;
  }
  const part1 = value.substring(0, colonIndex);
  const part2 = value.substring(colonIndex + 1);
  if (part1.length !== 16) {
    return false;
  }
  try {
    atob(part1);
    atob(part2);
    return true;
  } catch {
    return false;
  }
}
var cachedKey, cachedKeySource;
var init_secrets = __esm({
  "src/crypto/secrets.ts"() {
    "use strict";
    cachedKey = null;
    cachedKeySource = null;
    __name(importEncryptionKey, "importEncryptionKey");
    __name(getEncryptionKey, "getEncryptionKey");
    __name(hasEncryptionKey, "hasEncryptionKey");
    __name(encryptSecret, "encryptSecret");
    __name(decryptSecret, "decryptSecret");
    __name(isEncryptedValue, "isEncryptedValue");
  }
});

// src/secrets/handler.ts
var handler_exports = {};
__export(handler_exports, {
  approveSecretDomain: () => approveSecretDomain,
  createPendingApproval: () => createPendingApproval,
  createSecret: () => createSecret,
  deleteSecret: () => deleteSecret,
  dismissPendingApproval: () => dismissPendingApproval,
  getAllowlistForSecret: () => getAllowlistForSecret,
  getApprovedDomainsForDashboard: () => getApprovedDomainsForDashboard,
  getDecryptedGlobalSecrets: () => getDecryptedGlobalSecrets,
  getDecryptedSecretsForDashboard: () => getDecryptedSecretsForDashboard,
  getSecretsWithProtection: () => getSecretsWithProtection,
  listPendingApprovals: () => listPendingApprovals,
  listSecretAllowlist: () => listSecretAllowlist,
  listSecrets: () => listSecrets,
  migrateUnencryptedSecrets: () => migrateUnencryptedSecrets,
  revokeSecretDomain: () => revokeSecretDomain,
  updateSecretProtection: () => updateSecretProtection
});
async function autoApplySecretsToSessions(env, userId, dashboardId) {
  const isGlobal = dashboardId === GLOBAL_SECRETS_ID;
  try {
    let sessions;
    if (isGlobal) {
      sessions = await env.DB.prepare(`
        SELECT s.id, s.dashboard_id, s.sandbox_session_id, s.sandbox_machine_id
        FROM sessions s
        JOIN dashboard_members dm ON s.dashboard_id = dm.dashboard_id
        WHERE dm.user_id = ? AND s.status = 'active' AND s.sandbox_session_id IS NOT NULL
      `).bind(userId).all();
    } else {
      sessions = await env.DB.prepare(`
        SELECT id, dashboard_id, sandbox_session_id, sandbox_machine_id
        FROM sessions
        WHERE dashboard_id = ? AND status = 'active' AND sandbox_session_id IS NOT NULL
      `).bind(dashboardId).all();
    }
    if (!sessions.results || sessions.results.length === 0) {
      return;
    }
    const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
    const processedDashboards = /* @__PURE__ */ new Set();
    for (const session of sessions.results) {
      const sessionDashboardId = session.dashboard_id;
      const sandboxSessionId = session.sandbox_session_id;
      const sandboxMachineId = session.sandbox_machine_id;
      if (processedDashboards.has(sessionDashboardId)) {
        continue;
      }
      processedDashboards.add(sessionDashboardId);
      try {
        const secrets = await getSecretsWithProtection(env, userId, sessionDashboardId);
        const approvedDomains = await getApprovedDomainsForDashboard(env, userId, sessionDashboardId);
        const dashboardSandbox = await env.DB.prepare(`
          SELECT applied_secret_names FROM dashboard_sandboxes WHERE dashboard_id = ?
        `).bind(sessionDashboardId).first();
        const previousNames = dashboardSandbox?.applied_secret_names ? JSON.parse(dashboardSandbox.applied_secret_names) : [];
        const currentNames = Object.keys(secrets);
        const unset = [];
        for (const name of previousNames) {
          if (!currentNames.includes(name)) {
            unset.push(name);
            unset.push(`${name}_BROKER`);
          }
        }
        await sandbox.updateEnv(
          sandboxSessionId,
          {
            secrets,
            approvedDomains: approvedDomains.length > 0 ? approvedDomains : void 0,
            unset: unset.length > 0 ? unset : void 0,
            applyNow: false
          },
          sandboxMachineId || void 0
        );
        await env.DB.prepare(`
          INSERT INTO dashboard_sandboxes (dashboard_id, sandbox_session_id, sandbox_machine_id, applied_secret_names, created_at)
          VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(dashboard_id) DO UPDATE SET applied_secret_names = excluded.applied_secret_names
        `).bind(sessionDashboardId, sandboxSessionId, sandboxMachineId || "", JSON.stringify(currentNames)).run();
      } catch (error) {
        console.error(`[secrets] Failed to apply to session ${sandboxSessionId}:`, error);
      }
    }
  } catch (error) {
    console.error("[secrets] Failed to auto-apply secrets:", error);
  }
}
function formatSecret(row) {
  return {
    id: row.id,
    userId: row.user_id,
    dashboardId: row.dashboard_id,
    name: row.name,
    description: row.description || "",
    type: row.type || "secret",
    // Default to 'secret' for backwards compatibility
    brokerProtected: row.broker_protected !== 0,
    // SQLite stores boolean as 0/1
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
async function ensureDashboardAccess(env, dashboardId, userId) {
  const access = await env.DB.prepare(
    `SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?`
  ).bind(dashboardId, userId).first();
  return access ?? null;
}
async function listSecrets(env, userId, dashboardId, type) {
  const isGlobal = !dashboardId || dashboardId === GLOBAL_SECRETS_ID;
  const effectiveDashboardId = isGlobal ? GLOBAL_SECRETS_ID : dashboardId;
  if (!isGlobal) {
    const access = await ensureDashboardAccess(env, dashboardId, userId);
    if (!access) {
      return Response.json({ error: "E79734: Not found or no access" }, { status: 404 });
    }
  }
  let query = `SELECT id, user_id, dashboard_id, name, description, type, broker_protected, created_at, updated_at
     FROM user_secrets
     WHERE user_id = ? AND dashboard_id = ?`;
  const params = [userId, effectiveDashboardId];
  if (type) {
    query += ` AND type = ?`;
    params.push(type);
  }
  query += ` ORDER BY updated_at DESC`;
  const rows = await env.DB.prepare(query).bind(...params).all();
  return Response.json({
    secrets: rows.results.map((row) => formatSecret(row))
  });
}
async function createSecret(env, userId, data) {
  if (!data.name || !data.value) {
    return Response.json({ error: "E79731: name and value are required" }, { status: 400 });
  }
  if (!hasEncryptionKey(env)) {
    return Response.json({ error: "E79738: Secret encryption not configured" }, { status: 500 });
  }
  const isGlobal = !data.dashboardId || data.dashboardId === GLOBAL_SECRETS_ID;
  const effectiveDashboardId = isGlobal ? GLOBAL_SECRETS_ID : data.dashboardId;
  if (!isGlobal) {
    const access = await ensureDashboardAccess(env, data.dashboardId, userId);
    if (!access || access.role !== "owner" && access.role !== "editor") {
      return Response.json({ error: "E79735: Not found or no edit access" }, { status: 404 });
    }
  }
  const id = crypto.randomUUID();
  const description = data.description || "";
  const type = data.type || "secret";
  const brokerProtected = type === "env_var" ? 0 : data.brokerProtected !== false ? 1 : 0;
  let encryptedValue;
  try {
    const key = await getEncryptionKey(env);
    encryptedValue = await encryptSecret(data.value, key);
  } catch (error) {
    console.error("Failed to encrypt secret:", error);
    return Response.json({ error: "E79739: Failed to encrypt secret" }, { status: 500 });
  }
  await env.DB.prepare(
    `INSERT INTO user_secrets (id, user_id, dashboard_id, name, value, description, type, broker_protected, encrypted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`
  ).bind(id, userId, effectiveDashboardId, data.name, encryptedValue, description, type, brokerProtected).run();
  const row = await env.DB.prepare(
    `SELECT id, user_id, dashboard_id, name, description, type, broker_protected, created_at, updated_at
     FROM user_secrets WHERE id = ?`
  ).bind(id).first();
  autoApplySecretsToSessions(env, userId, effectiveDashboardId).catch((err) => {
    console.error("[secrets] Background auto-apply failed:", err);
  });
  return Response.json({ secret: formatSecret(row) });
}
async function deleteSecret(env, userId, id, dashboardId) {
  const isGlobal = !dashboardId || dashboardId === GLOBAL_SECRETS_ID;
  const effectiveDashboardId = isGlobal ? GLOBAL_SECRETS_ID : dashboardId;
  if (!isGlobal) {
    const access = await ensureDashboardAccess(env, dashboardId, userId);
    if (!access || access.role !== "owner" && access.role !== "editor") {
      return Response.json({ error: "E79737: Not found or no edit access" }, { status: 404 });
    }
  }
  const result = await env.DB.prepare(
    `DELETE FROM user_secrets WHERE id = ? AND user_id = ? AND dashboard_id = ?`
  ).bind(id, userId, effectiveDashboardId).run();
  if (result.meta.changes === 0) {
    return Response.json({ error: "E79732: Secret not found" }, { status: 404 });
  }
  autoApplySecretsToSessions(env, userId, effectiveDashboardId).catch((err) => {
    console.error("[secrets] Background auto-apply failed:", err);
  });
  return new Response(null, { status: 204 });
}
async function getDecryptedSecretsForDashboard(env, userId, dashboardId) {
  const secrets = await getSecretsWithProtection(env, userId, dashboardId);
  const result = {};
  for (const [name, config] of Object.entries(secrets)) {
    result[name] = config.value;
  }
  return result;
}
async function getSecretsWithProtection(env, userId, dashboardId) {
  const access = await ensureDashboardAccess(env, dashboardId, userId);
  if (!access) {
    throw new Error("No access to dashboard");
  }
  if (!hasEncryptionKey(env)) {
    throw new Error("Encryption key not configured");
  }
  const rows = await env.DB.prepare(
    `SELECT name, value, type, broker_protected, dashboard_id FROM user_secrets
     WHERE user_id = ? AND (dashboard_id = ? OR dashboard_id = ?)
     ORDER BY CASE WHEN dashboard_id = ? THEN 0 ELSE 1 END`
  ).bind(userId, GLOBAL_SECRETS_ID, dashboardId, GLOBAL_SECRETS_ID).all();
  const key = await getEncryptionKey(env);
  const result = {};
  for (const row of rows.results) {
    const name = row.name;
    const encryptedValue = row.value;
    const type = row.type || "secret";
    const brokerProtected = type === "env_var" ? false : row.broker_protected !== 0;
    try {
      let decryptedValue;
      if (isEncryptedValue(encryptedValue)) {
        decryptedValue = await decryptSecret(encryptedValue, key);
      } else {
        decryptedValue = encryptedValue;
      }
      result[name] = { value: decryptedValue, brokerProtected };
    } catch (error) {
      console.error(`Failed to decrypt secret ${name}:`, error);
    }
  }
  return result;
}
async function updateSecretProtection(env, userId, secretId, dashboardId, brokerProtected) {
  const isGlobal = !dashboardId || dashboardId === GLOBAL_SECRETS_ID;
  const effectiveDashboardId = isGlobal ? GLOBAL_SECRETS_ID : dashboardId;
  if (!isGlobal) {
    const access = await ensureDashboardAccess(env, dashboardId, userId);
    if (!access || access.role !== "owner" && access.role !== "editor") {
      return Response.json({ error: "E79736: Not found or no edit access" }, { status: 404 });
    }
  }
  const result = await env.DB.prepare(
    `UPDATE user_secrets SET broker_protected = ?, updated_at = datetime('now')
     WHERE id = ? AND user_id = ? AND dashboard_id = ?`
  ).bind(brokerProtected ? 1 : 0, secretId, userId, effectiveDashboardId).run();
  if (result.meta.changes === 0) {
    return Response.json({ error: "E79733: Secret not found" }, { status: 404 });
  }
  const row = await env.DB.prepare(
    `SELECT id, user_id, dashboard_id, name, description, type, broker_protected, created_at, updated_at
     FROM user_secrets WHERE id = ?`
  ).bind(secretId).first();
  autoApplySecretsToSessions(env, userId, effectiveDashboardId).catch((err) => {
    console.error("[secrets] Background auto-apply failed:", err);
  });
  return Response.json({ secret: formatSecret(row) });
}
async function getDecryptedGlobalSecrets(env, userId) {
  if (!hasEncryptionKey(env)) {
    throw new Error("Encryption key not configured");
  }
  const rows = await env.DB.prepare(
    `SELECT name, value FROM user_secrets
     WHERE user_id = ? AND dashboard_id = ?`
  ).bind(userId, GLOBAL_SECRETS_ID).all();
  const key = await getEncryptionKey(env);
  const result = {};
  for (const row of rows.results) {
    const name = row.name;
    const encryptedValue = row.value;
    try {
      if (isEncryptedValue(encryptedValue)) {
        result[name] = await decryptSecret(encryptedValue, key);
      } else {
        result[name] = encryptedValue;
      }
    } catch (error) {
      console.error(`Failed to decrypt secret ${name}:`, error);
    }
  }
  return result;
}
async function migrateUnencryptedSecrets(env) {
  if (!hasEncryptionKey(env)) {
    return Response.json({ error: "E79741: Encryption key not configured" }, { status: 500 });
  }
  const key = await getEncryptionKey(env);
  const rows = await env.DB.prepare(
    `SELECT id, value FROM user_secrets WHERE encrypted_at IS NULL`
  ).all();
  let migrated2 = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows.results) {
    const id = row.id;
    const value = row.value;
    if (isEncryptedValue(value)) {
      await env.DB.prepare(
        `UPDATE user_secrets SET encrypted_at = datetime('now') WHERE id = ?`
      ).bind(id).run();
      skipped++;
      continue;
    }
    try {
      const encryptedValue = await encryptSecret(value, key);
      await env.DB.prepare(
        `UPDATE user_secrets SET value = ?, encrypted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
      ).bind(encryptedValue, id).run();
      migrated2++;
    } catch (error) {
      console.error(`Failed to migrate secret ${id}:`, error);
      failed++;
    }
  }
  return Response.json({
    migrated: migrated2,
    skipped,
    failed,
    total: rows.results.length
  });
}
function formatAllowlistEntry(row) {
  return {
    id: row.id,
    secretId: row.secret_id,
    domain: row.domain,
    headerName: row.header_name,
    headerFormat: row.header_format,
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at
  };
}
async function listSecretAllowlist(env, userId, secretId, dashboardId) {
  const isGlobal = !dashboardId || dashboardId === GLOBAL_SECRETS_ID;
  const effectiveDashboardId = isGlobal ? GLOBAL_SECRETS_ID : dashboardId;
  const secret = await env.DB.prepare(
    `SELECT id FROM user_secrets WHERE id = ? AND user_id = ? AND dashboard_id = ?`
  ).bind(secretId, userId, effectiveDashboardId).first();
  if (!secret) {
    return Response.json({ error: "E79750: Secret not found" }, { status: 404 });
  }
  const rows = await env.DB.prepare(
    `SELECT id, secret_id, domain, header_name, header_format, created_by, created_at, revoked_at
     FROM user_secret_allowlist
     WHERE secret_id = ? AND revoked_at IS NULL
     ORDER BY created_at DESC`
  ).bind(secretId).all();
  return Response.json({
    allowlist: rows.results.map((row) => formatAllowlistEntry(row))
  });
}
async function approveSecretDomain(env, userId, secretId, dashboardId, data) {
  if (!data.domain) {
    return Response.json({ error: "E79751: domain is required" }, { status: 400 });
  }
  const domain = data.domain.toLowerCase().trim();
  if (!domain || domain.includes("/") || domain.includes(" ")) {
    return Response.json({ error: "E79752: Invalid domain format" }, { status: 400 });
  }
  const isGlobal = !dashboardId || dashboardId === GLOBAL_SECRETS_ID;
  const effectiveDashboardId = isGlobal ? GLOBAL_SECRETS_ID : dashboardId;
  const secret = await env.DB.prepare(
    `SELECT id FROM user_secrets WHERE id = ? AND user_id = ? AND dashboard_id = ?`
  ).bind(secretId, userId, effectiveDashboardId).first();
  if (!secret) {
    return Response.json({ error: "E79750: Secret not found" }, { status: 404 });
  }
  const existing = await env.DB.prepare(
    `SELECT id FROM user_secret_allowlist WHERE secret_id = ? AND domain = ? AND revoked_at IS NULL`
  ).bind(secretId, domain).first();
  if (existing) {
    return Response.json({ error: "E79753: Domain already approved" }, { status: 409 });
  }
  const id = crypto.randomUUID();
  const headerName = data.headerName || "Authorization";
  const headerFormat = data.headerFormat || "Bearer %s";
  await env.DB.prepare(
    `INSERT INTO user_secret_allowlist (id, secret_id, domain, header_name, header_format, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  ).bind(id, secretId, domain, headerName, headerFormat, userId).run();
  await env.DB.prepare(
    `UPDATE pending_domain_approvals SET dismissed_at = datetime('now')
     WHERE secret_id = ? AND domain = ? AND dismissed_at IS NULL`
  ).bind(secretId, domain).run();
  const row = await env.DB.prepare(
    `SELECT id, secret_id, domain, header_name, header_format, created_by, created_at, revoked_at
     FROM user_secret_allowlist WHERE id = ?`
  ).bind(id).first();
  autoApplySecretsToSessions(env, userId, effectiveDashboardId).catch((err) => {
    console.error("[secrets] Background auto-apply failed after domain approval:", err);
  });
  return Response.json({ entry: formatAllowlistEntry(row) });
}
async function revokeSecretDomain(env, userId, secretId, entryId, dashboardId) {
  const isGlobal = !dashboardId || dashboardId === GLOBAL_SECRETS_ID;
  const effectiveDashboardId = isGlobal ? GLOBAL_SECRETS_ID : dashboardId;
  const secret = await env.DB.prepare(
    `SELECT id FROM user_secrets WHERE id = ? AND user_id = ? AND dashboard_id = ?`
  ).bind(secretId, userId, effectiveDashboardId).first();
  if (!secret) {
    return Response.json({ error: "E79750: Secret not found" }, { status: 404 });
  }
  const result = await env.DB.prepare(
    `UPDATE user_secret_allowlist SET revoked_at = datetime('now')
     WHERE id = ? AND secret_id = ? AND revoked_at IS NULL`
  ).bind(entryId, secretId).run();
  if (result.meta.changes === 0) {
    return Response.json({ error: "E79754: Allowlist entry not found" }, { status: 404 });
  }
  return new Response(null, { status: 204 });
}
async function listPendingApprovals(env, userId, dashboardId) {
  const isGlobal = !dashboardId || dashboardId === GLOBAL_SECRETS_ID;
  let query;
  let params;
  if (isGlobal) {
    query = `
      SELECT p.id, p.secret_id, p.domain, p.requested_at, s.name as secret_name
      FROM pending_domain_approvals p
      JOIN user_secrets s ON p.secret_id = s.id
      WHERE s.user_id = ? AND s.dashboard_id = ? AND p.dismissed_at IS NULL
      ORDER BY p.requested_at DESC
    `;
    params = [userId, GLOBAL_SECRETS_ID];
  } else {
    query = `
      SELECT p.id, p.secret_id, p.domain, p.requested_at, s.name as secret_name
      FROM pending_domain_approvals p
      JOIN user_secrets s ON p.secret_id = s.id
      WHERE s.user_id = ? AND (s.dashboard_id = ? OR s.dashboard_id = ?) AND p.dismissed_at IS NULL
      ORDER BY p.requested_at DESC
    `;
    params = [userId, GLOBAL_SECRETS_ID, dashboardId];
  }
  const rows = await env.DB.prepare(query).bind(...params).all();
  const approvals = rows.results.map((row) => ({
    id: row.id,
    secretId: row.secret_id,
    secretName: row.secret_name,
    domain: row.domain,
    requestedAt: row.requested_at
  }));
  return Response.json({ pendingApprovals: approvals });
}
async function dismissPendingApproval(env, userId, approvalId) {
  const approval = await env.DB.prepare(
    `SELECT p.id, s.user_id
     FROM pending_domain_approvals p
     JOIN user_secrets s ON p.secret_id = s.id
     WHERE p.id = ? AND s.user_id = ? AND p.dismissed_at IS NULL`
  ).bind(approvalId, userId).first();
  if (!approval) {
    return Response.json({ error: "E79755: Pending approval not found" }, { status: 404 });
  }
  await env.DB.prepare(
    `UPDATE pending_domain_approvals SET dismissed_at = datetime('now') WHERE id = ?`
  ).bind(approvalId).run();
  return new Response(null, { status: 204 });
}
async function getAllowlistForSecret(env, secretId) {
  const rows = await env.DB.prepare(
    `SELECT id, secret_id, domain, header_name, header_format, created_by, created_at, revoked_at
     FROM user_secret_allowlist
     WHERE secret_id = ? AND revoked_at IS NULL`
  ).bind(secretId).all();
  return rows.results.map((row) => formatAllowlistEntry(row));
}
async function createPendingApproval(env, secretId, domain) {
  const existing = await env.DB.prepare(
    `SELECT id FROM pending_domain_approvals WHERE secret_id = ? AND domain = ? AND dismissed_at IS NULL`
  ).bind(secretId, domain).first();
  if (existing) {
    return;
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO pending_domain_approvals (id, secret_id, domain, requested_at)
     VALUES (?, ?, ?, datetime('now'))`
  ).bind(id, secretId, domain).run();
}
async function getApprovedDomainsForDashboard(env, userId, dashboardId) {
  const approvals = await env.DB.prepare(
    `SELECT
      s.name as secret_name,
      a.domain,
      a.header_name,
      a.header_format
    FROM user_secret_allowlist a
    JOIN user_secrets s ON a.secret_id = s.id
    WHERE s.user_id = ?
      AND (s.dashboard_id = ? OR s.dashboard_id = '_global')
      AND a.revoked_at IS NULL`
  ).bind(userId, dashboardId).all();
  return approvals.results.map((row) => ({
    secretName: row.secret_name,
    domain: row.domain,
    headerName: row.header_name,
    headerFormat: row.header_format
  }));
}
var GLOBAL_SECRETS_ID;
var init_handler = __esm({
  "src/secrets/handler.ts"() {
    "use strict";
    init_secrets();
    init_client();
    __name(autoApplySecretsToSessions, "autoApplySecretsToSessions");
    __name(formatSecret, "formatSecret");
    __name(ensureDashboardAccess, "ensureDashboardAccess");
    GLOBAL_SECRETS_ID = "_global";
    __name(listSecrets, "listSecrets");
    __name(createSecret, "createSecret");
    __name(deleteSecret, "deleteSecret");
    __name(getDecryptedSecretsForDashboard, "getDecryptedSecretsForDashboard");
    __name(getSecretsWithProtection, "getSecretsWithProtection");
    __name(updateSecretProtection, "updateSecretProtection");
    __name(getDecryptedGlobalSecrets, "getDecryptedGlobalSecrets");
    __name(migrateUnencryptedSecrets, "migrateUnencryptedSecrets");
    __name(formatAllowlistEntry, "formatAllowlistEntry");
    __name(listSecretAllowlist, "listSecretAllowlist");
    __name(approveSecretDomain, "approveSecretDomain");
    __name(revokeSecretDomain, "revokeSecretDomain");
    __name(listPendingApprovals, "listPendingApprovals");
    __name(dismissPendingApproval, "dismissPendingApproval");
    __name(getAllowlistForSecret, "getAllowlistForSecret");
    __name(createPendingApproval, "createPendingApproval");
    __name(getApprovedDomainsForDashboard, "getApprovedDomainsForDashboard");
  }
});

// src/sessions/handler.ts
var handler_exports2 = {};
__export(handler_exports2, {
  applySecretsToSession: () => applySecretsToSession,
  createApprovalRequestInternal: () => createApprovalRequestInternal,
  createSessi\u043En: () => createSessi\u043En,
  ensureDashb\u043EardSandb\u043Ex: () => ensureDashb\u043EardSandb\u043Ex,
  getApprovedDomainsInternal: () => getApprovedDomainsInternal,
  getDashb\u043EardBrowserStatus: () => getDashb\u043EardBrowserStatus,
  getSessi\u043En: () => getSessi\u043En,
  getWorkspaceSnapshot: () => getWorkspaceSnapshot,
  openBrowserFromSandb\u043ExSessionInternal: () => openBrowserFromSandb\u043ExSessionInternal,
  openDashb\u043EardBrowser: () => openDashb\u043EardBrowser,
  startDashb\u043EardBrowser: () => startDashb\u043EardBrowser,
  st\u043EpDashb\u043EardBrowser: () => st\u043EpDashb\u043EardBrowser,
  st\u043EpSessi\u043En: () => st\u043EpSessi\u043En,
  updateSessi\u043EnEnv: () => updateSessi\u043EnEnv
});
function getMirrorTableName(provider) {
  return MIRROR_TABLES[provider] ?? null;
}
function generateId2() {
  return crypto.randomUUID();
}
function parseTerminalConfig(content) {
  if (typeof content !== "string") {
    return { bootCommand: "" };
  }
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) {
    return { bootCommand: "" };
  }
  try {
    const parsed = JSON.parse(trimmed);
    let bootCommand = typeof parsed.bootCommand === "string" ? parsed.bootCommand : "";
    const workingDir = typeof parsed.workingDir === "string" ? parsed.workingDir : void 0;
    if (parsed.ttsProvider && parsed.ttsProvider !== "none" && bootCommand) {
      const provider = parsed.ttsProvider;
      let voice = parsed.ttsVoice || "";
      if (provider === "elevenlabs" && voice && ELEVENLABS_VOICE_IDS[voice]) {
        voice = ELEVENLABS_VOICE_IDS[voice];
      }
      if (provider === "deepgram" && voice && DEEPGRAM_VOICE_MODELS[voice]) {
        voice = DEEPGRAM_VOICE_MODELS[voice];
      }
      const talkitoArgs = [
        "talkito",
        "--disable-mcp",
        "--tts-provider",
        provider,
        ...voice ? ["--tts-voice", voice] : [],
        "--orcabot",
        "--asr-provider",
        "off",
        bootCommand
      ];
      bootCommand = talkitoArgs.join(" ");
    }
    return { bootCommand, workingDir };
  } catch {
    return { bootCommand: "" };
  }
}
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
async function getDashb\u043EardSandb\u043Ex(env, dashboardId) {
  return env.DB.prepare(`
    SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes WHERE dashboard_id = ?
  `).bind(dashboardId).first();
}
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
    const checkRes = await sandboxFetch(
      env,
      `/sessions/${existingSandbox.sandbox_session_id}/ptys`,
      { machineId: existingSandbox.sandbox_machine_id || void 0 }
    );
    if (checkRes.ok) {
      return {
        sandboxSessionId: existingSandbox.sandbox_session_id,
        sandboxMachineId: existingSandbox.sandbox_machine_id || ""
      };
    }
    console.log(`Stale sandbox session detected in ensureDashboardSandbox (${existingSandbox.sandbox_session_id}), clearing`);
    await env.DB.prepare(`
      DELETE FROM dashboard_sandboxes WHERE dashboard_id = ?
    `).bind(dashboardId).run();
  }
  const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const mcpToken = await createDashboardToken(dashboardId, env.INTERNAL_API_TOKEN);
  const sandboxSession = await sandbox.createSessi\u043En(dashboardId, mcpToken);
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
function driveManifestKey(dashboardId) {
  return `drive/${dashboardId}/manifest.json`;
}
function mirrorManifestKey(provider, dashboardId) {
  return `mirror/${provider}/${dashboardId}/manifest.json`;
}
function workspaceSnapshotKey(dashboardId) {
  return `workspace/${dashboardId}/snapshot.json`;
}
async function captureWorkspaceSnapshot(env, dashboardId, sandboxSessionId, sandboxMachineId) {
  try {
    const res = await sandboxFetch(
      env,
      `/sessions/${sandboxSessionId}/files?path=/&recursive=true`,
      { machineId: sandboxMachineId || void 0, timeoutMs: 15e3 }
    );
    if (!res.ok)
      return;
    const data = await res.json();
    if (!data.files || data.files.length === 0)
      return;
    const snapshot = {
      version: 1,
      dashboardId,
      capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
      fileCount: data.files.length,
      files: data.files
    };
    await env.DRIVE_CACHE.put(
      workspaceSnapshotKey(dashboardId),
      JSON.stringify(snapshot),
      { httpMetadata: { contentType: "application/json" } }
    );
  } catch {
  }
}
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
  await sandboxFetch(env, `/sessions/${sandboxSessionId}/drive/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      dashboard_id: dashboardId,
      folder_name: mirror.folder_name
    }),
    machineId: sandboxMachineId || void 0
  });
}
async function triggerMirrorSync(env, provider, dashboardId, sandboxSessionId, sandboxMachineId, folderName) {
  const manifest = await env.DRIVE_CACHE.head(mirrorManifestKey(provider, dashboardId));
  if (!manifest) {
    return;
  }
  const tableName = getMirrorTableName(provider);
  if (!tableName) {
    console.error(`[sessions] Invalid mirror provider: ${provider}`);
    return;
  }
  await env.DB.prepare(`
    UPDATE ${tableName}
    SET status = 'syncing_workspace', sync_error = null, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(dashboardId).run();
  await sandboxFetch(env, `/sessions/${sandboxSessionId}/mirror/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      provider,
      dashboard_id: dashboardId,
      folder_name: folderName
    }),
    machineId: sandboxMachineId || void 0
  });
}
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
    const terminalConfig = parseTerminalConfig(item.content);
    const { bootCommand, workingDir } = terminalConfig;
    console.log(`[createSession] itemId=${itemId} bootCommand=${JSON.stringify(bootCommand)} workingDir=${JSON.stringify(workingDir)} contentPreview=${JSON.stringify(String(item.content).slice(0, 200))}`);
    const existingSandbox = await getDashb\u043EardSandb\u043Ex(env, dashboardId);
    let sandboxSessionId = existingSandbox?.sandbox_session_id || "";
    let sandboxMachineId = existingSandbox?.sandbox_machine_id || "";
    if (!sandboxSessionId) {
      const mcpToken = await createDashboardToken(dashboardId, env.INTERNAL_API_TOKEN);
      const sandboxSession = await sandbox.createSessi\u043En(dashboardId, mcpToken);
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
    const ptyId = generateId2();
    const integrationToken = await createPtyToken(
      ptyId,
      sandboxSessionId,
      dashboardId,
      userId,
      env.INTERNAL_API_TOKEN
    );
    let pty;
    try {
      console.log(`[createSession] calling createPty: sandboxSessionId=${sandboxSessionId} userId=${userId} bootCommand=${JSON.stringify(bootCommand)} workingDir=${JSON.stringify(workingDir)} machineId=${sandboxMachineId} ptyId=${ptyId}`);
      pty = await sandbox.createPty(sandboxSessionId, userId, bootCommand, sandboxMachineId, {
        ptyId,
        integrationToken,
        workingDir
      });
    } catch (err) {
      const isStaleSession = err instanceof Error && err.message.includes("404");
      if (!isStaleSession) {
        throw err;
      }
      console.log(`Stale sandbox session detected (${sandboxSessionId}), creating fresh session`);
      await env.DB.prepare(`
        DELETE FROM dashboard_sandboxes WHERE dashboard_id = ?
      `).bind(dashboardId).run();
      const mcpToken = await createDashboardToken(dashboardId, env.INTERNAL_API_TOKEN);
      const freshSandbox = await sandbox.createSessi\u043En(dashboardId, mcpToken);
      sandboxSessionId = freshSandbox.id;
      sandboxMachineId = freshSandbox.machineId || "";
      await env.DB.prepare(`
        INSERT INTO dashboard_sandboxes (dashboard_id, sandbox_session_id, sandbox_machine_id, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(dashboardId, sandboxSessionId, sandboxMachineId, now).run();
      const freshIntegrationToken = await createPtyToken(
        ptyId,
        sandboxSessionId,
        dashboardId,
        userId,
        env.INTERNAL_API_TOKEN
      );
      pty = await sandbox.createPty(sandboxSessionId, userId, bootCommand, sandboxMachineId, {
        ptyId,
        integrationToken: freshIntegrationToken,
        workingDir
      });
    }
    await env.DB.prepare(`
      UPDATE sessions SET sandbox_session_id = ?, sandbox_machine_id = ?, pty_id = ?, status = 'active' WHERE id = ?
    `).bind(sandboxSessionId, sandboxMachineId, pty.id, id).run();
    try {
      const migrated2 = await env.DB.prepare(`
        UPDATE terminal_integrations
        SET terminal_id = ?, updated_at = datetime('now')
        WHERE item_id = ? AND dashboard_id = ? AND deleted_at IS NULL
          AND terminal_id != ?
      `).bind(pty.id, itemId, dashboardId, pty.id).run();
      if (migrated2.meta.changes > 0) {
        console.log(`[createSession] Migrated ${migrated2.meta.changes} integration(s) for item=${itemId} to ptyId=${pty.id}`);
      }
    } catch (err) {
      console.error("[createSession] Failed to migrate integrations:", err);
    }
    try {
      const { getSecretsWithProtection: getSecretsWithProtection2, getApprovedDomainsForDashboard: getApprovedDomainsForDashboard2 } = await Promise.resolve().then(() => (init_handler(), handler_exports));
      const secrets = await getSecretsWithProtection2(env, userId, dashboardId);
      const approvedDomains = await getApprovedDomainsForDashboard2(env, userId, dashboardId);
      const secretNames = Object.keys(secrets);
      if (secretNames.length > 0 || approvedDomains.length > 0) {
        await sandbox.updateEnv(
          sandboxSessionId,
          {
            secrets: secretNames.length > 0 ? secrets : void 0,
            approvedDomains: approvedDomains.length > 0 ? approvedDomains : void 0,
            applyNow: false
          },
          sandboxMachineId || void 0
        );
      }
      await env.DB.prepare(`
        INSERT INTO dashboard_sandboxes (dashboard_id, sandbox_session_id, sandbox_machine_id, applied_secret_names, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(dashboard_id) DO UPDATE SET applied_secret_names = excluded.applied_secret_names
      `).bind(dashboardId, sandboxSessionId, sandboxMachineId || "", JSON.stringify(secretNames), now).run();
    } catch (err) {
      console.error("Failed to auto-apply secrets:", err);
    }
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
async function startDashb\u043EardBrowser(env, dashboardId, userId) {
  const sandboxInfo = await ensureDashb\u043EardSandb\u043Ex(env, dashboardId, userId);
  if (sandboxInfo instanceof Response) {
    return sandboxInfo;
  }
  const { sandboxSessionId, sandboxMachineId } = sandboxInfo;
  const statusResponse = await sandboxFetch(
    env,
    `/sessions/${sandboxSessionId}/browser/status`,
    { machineId: sandboxMachineId || void 0 }
  );
  if (statusResponse.ok) {
    try {
      const status = await statusResponse.json();
      if (status?.running) {
        return Response.json({ status: "running" });
      }
    } catch {
    }
  }
  const response = await sandboxFetch(env, `/sessions/${sandboxSessionId}/browser/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    machineId: sandboxMachineId || void 0
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
async function st\u043EpDashb\u043EardBrowser(env, dashboardId, userId) {
  const sandboxInfo = await ensureDashb\u043EardSandb\u043Ex(env, dashboardId, userId);
  if (sandboxInfo instanceof Response) {
    return sandboxInfo;
  }
  const { sandboxSessionId, sandboxMachineId } = sandboxInfo;
  await sandboxFetch(env, `/sessions/${sandboxSessionId}/browser/stop`, {
    method: "POST",
    machineId: sandboxMachineId || void 0
  });
  return new Response(null, { status: 204 });
}
async function getDashb\u043EardBrowserStatus(env, dashboardId, userId) {
  const sandboxInfo = await ensureDashb\u043EardSandb\u043Ex(env, dashboardId, userId);
  if (sandboxInfo instanceof Response) {
    return sandboxInfo;
  }
  const { sandboxSessionId, sandboxMachineId } = sandboxInfo;
  const response = await sandboxFetch(
    env,
    `/sessions/${sandboxSessionId}/browser/status`,
    { machineId: sandboxMachineId || void 0 }
  );
  if (!response.ok) {
    return Response.json({ running: false }, { status: 200 });
  }
  return response;
}
async function openDashb\u043EardBrowser(env, dashboardId, userId, url) {
  const sandboxInfo = await ensureDashb\u043EardSandb\u043Ex(env, dashboardId, userId);
  if (sandboxInfo instanceof Response) {
    return sandboxInfo;
  }
  const { sandboxSessionId, sandboxMachineId } = sandboxInfo;
  const response = await sandboxFetch(env, `/sessions/${sandboxSessionId}/browser/open`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ url }),
    machineId: sandboxMachineId || void 0
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
async function openBrowserFromSandb\u043ExSessionInternal(env, sandboxSessionId, url) {
  if (!sandboxSessionId || !url) {
    return Response.json({ error: "E79821: Missing session or URL" }, { status: 400 });
  }
  const session = await env.DB.prepare(`
    SELECT dashboard_id, item_id FROM sessions WHERE sandbox_session_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(sandboxSessionId).first();
  if (!session?.dashboard_id) {
    return Response.json({ error: "E79820: Session not found" }, { status: 404 });
  }
  const dashboardId = session.dashboard_id;
  const terminalItemId = session.item_id;
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
  let formattedEdge = null;
  if (!existingBrowser && terminalItemId && browserItemId) {
    const existingEdge = await env.DB.prepare(`
      SELECT * FROM dashboard_edges
      WHERE dashboard_id = ?
        AND source_item_id = ?
        AND target_item_id = ?
        AND COALESCE(source_handle, '') = 'right-out'
        AND COALESCE(target_handle, '') = 'left-in'
    `).bind(dashboardId, terminalItemId, browserItemId).first();
    if (!existingEdge) {
      const edgeId = generateId2();
      await env.DB.prepare(`
        INSERT INTO dashboard_edges
          (id, dashboard_id, source_item_id, target_item_id, source_handle, target_handle, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        edgeId,
        dashboardId,
        terminalItemId,
        browserItemId,
        "right-out",
        "left-in",
        now,
        now
      ).run();
      formattedEdge = {
        id: edgeId,
        dashboardId,
        sourceItemId: terminalItemId,
        targetItemId: browserItemId,
        sourceHandle: "right-out",
        targetHandle: "left-in",
        createdAt: now,
        updatedAt: now
      };
    }
  }
  const doId = env.DASHBOARD.idFromName(dashboardId);
  const stub = env.DASHBOARD.get(doId);
  if (formattedItem) {
    await stub.fetch(new Request("http://do/item", {
      method: existingBrowser ? "PUT" : "POST",
      body: JSON.stringify(formattedItem)
    }));
  }
  if (formattedEdge) {
    await stub.fetch(new Request("http://do/edge", {
      method: "POST",
      body: JSON.stringify(formattedEdge)
    }));
  }
  await stub.fetch(new Request("http://do/browser", {
    method: "POST",
    body: JSON.stringify({ url })
  }));
  return new Response(null, { status: 204 });
}
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
async function updateSessi\u043EnEnv(env, sessionId, userId, payload) {
  const session = await env.DB.prepare(`
    SELECT s.* FROM sessions s
    JOIN dashboard_members dm ON s.dashboard_id = dm.dashboard_id
    WHERE s.id = ? AND dm.user_id = ? AND dm.role IN ('owner', 'editor')
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
      await captureWorkspaceSnapshot(
        env,
        session.dashboard_id,
        session.sandbox_session_id,
        session.sandbox_machine_id
      );
      await sandbox.deleteSession(session.sandbox_session_id, session.sandbox_machine_id);
      await env.DB.prepare(`
        DELETE FROM dashboard_sandboxes WHERE dashboard_id = ?
      `).bind(session.dashboard_id).run();
    } else if (session.pty_id) {
      await sandbox.deletePty(session.sandbox_session_id, session.pty_id);
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
async function getWorkspaceSnapshot(env, dashboardId, userId) {
  const member = await env.DB.prepare(`
    SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first();
  if (!member) {
    return Response.json({ error: "E79740: Dashboard not found or no access" }, { status: 404 });
  }
  let object;
  try {
    object = await env.DRIVE_CACHE.get(workspaceSnapshotKey(dashboardId));
  } catch (error) {
    if (isDesktopFeatureDisabledError(error)) {
      return Response.json({ error: "E79741: No workspace snapshot available (desktop mode)" }, { status: 404 });
    }
    throw error;
  }
  if (!object) {
    return Response.json({ error: "E79741: No workspace snapshot available" }, { status: 404 });
  }
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  return new Response(object.body, { headers });
}
async function applySecretsToSession(env, sessionId, userId) {
  const { getSecretsWithProtection: getSecretsWithProtection2, getApprovedDomainsForDashboard: getApprovedDomainsForDashboard2 } = await Promise.resolve().then(() => (init_handler(), handler_exports));
  const session = await env.DB.prepare(`
    SELECT s.*, dm.role FROM sessions s
    JOIN dashboard_members dm ON s.dashboard_id = dm.dashboard_id
    WHERE s.id = ? AND dm.user_id = ? AND dm.role IN ('owner', 'editor')
  `).bind(sessionId, userId).first();
  if (!session) {
    return Response.json({ error: "E79217: Session not found or no access" }, { status: 404 });
  }
  if (session.status !== "active") {
    return Response.json({ error: "E79218: Session is not active" }, { status: 400 });
  }
  try {
    const secrets = await getSecretsWithProtection2(
      env,
      userId,
      session.dashboard_id
    );
    const approvedDomains = await getApprovedDomainsForDashboard2(
      env,
      userId,
      session.dashboard_id
    );
    const dashboardSandbox = await env.DB.prepare(`
      SELECT applied_secret_names FROM dashboard_sandboxes WHERE dashboard_id = ?
    `).bind(session.dashboard_id).first();
    const previousNames = dashboardSandbox?.applied_secret_names ? JSON.parse(dashboardSandbox.applied_secret_names) : [];
    const currentNames = Object.keys(secrets);
    const unset = [];
    for (const name of previousNames) {
      if (!currentNames.includes(name)) {
        unset.push(name);
        unset.push(`${name}_BROKER`);
      }
    }
    await env.DB.prepare(`
      INSERT INTO dashboard_sandboxes (dashboard_id, sandbox_session_id, applied_secret_names)
      VALUES (?, ?, ?)
      ON CONFLICT(dashboard_id) DO UPDATE SET applied_secret_names = excluded.applied_secret_names
    `).bind(session.dashboard_id, session.sandbox_session_id, JSON.stringify(currentNames)).run();
    const hasSecrets = Object.keys(secrets).length > 0;
    const hasUnset = unset.length > 0;
    const hasApprovedDomains = approvedDomains.length > 0;
    if (!hasSecrets && !hasUnset && !hasApprovedDomains) {
      return Response.json({ applied: 0, approvedDomains: 0, unset: 0 });
    }
    const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
    await sandbox.updateEnv(
      session.sandbox_session_id,
      {
        secrets: hasSecrets ? secrets : void 0,
        approvedDomains: hasApprovedDomains ? approvedDomains : void 0,
        unset: hasUnset ? unset : void 0,
        applyNow: false
      },
      session.sandbox_machine_id || void 0
    );
    return Response.json({ applied: Object.keys(secrets).length, approvedDomains: approvedDomains.length, unset: unset.length });
  } catch (error) {
    console.error("Failed to apply secrets:", error);
    return Response.json(
      { error: "E79219: Failed to apply secrets" },
      { status: 500 }
    );
  }
}
async function createApprovalRequestInternal(env, sandboxSessionId, data) {
  const { secretName, domain } = data;
  if (!secretName || !domain) {
    return Response.json(
      { error: "E79220: secretName and domain are required" },
      { status: 400 }
    );
  }
  const session = await env.DB.prepare(`
    SELECT dashboard_id FROM sessions WHERE sandbox_session_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).bind(sandboxSessionId).first();
  if (!session?.dashboard_id) {
    const sandbox = await env.DB.prepare(`
      SELECT dashboard_id FROM dashboard_sandboxes WHERE sandbox_session_id = ?
    `).bind(sandboxSessionId).first();
    if (!sandbox?.dashboard_id) {
      return Response.json(
        { error: "E79221: Session not found" },
        { status: 404 }
      );
    }
    session.dashboard_id = sandbox.dashboard_id;
  }
  const dashboardId = session.dashboard_id;
  const dashboard = await env.DB.prepare(`
    SELECT owner_id FROM dashboards WHERE id = ?
  `).bind(dashboardId).first();
  if (!dashboard?.owner_id) {
    return Response.json(
      { error: "E79222: Dashboard not found" },
      { status: 404 }
    );
  }
  const userId = dashboard.owner_id;
  const secret = await env.DB.prepare(`
    SELECT id, name FROM user_secrets
    WHERE user_id = ? AND name = ? AND (dashboard_id = ? OR dashboard_id = '_global')
    ORDER BY CASE WHEN dashboard_id = ? THEN 1 ELSE 0 END DESC
    LIMIT 1
  `).bind(userId, secretName, dashboardId, dashboardId).first();
  if (!secret?.id) {
    return Response.json(
      { error: "E79223: Secret not found" },
      { status: 404 }
    );
  }
  const existingPending = await env.DB.prepare(`
    SELECT id FROM pending_domain_approvals
    WHERE secret_id = ? AND domain = ? AND dismissed_at IS NULL
  `).bind(secret.id, domain.toLowerCase()).first();
  if (existingPending) {
    return Response.json({ status: "already_pending" });
  }
  const existingApproval = await env.DB.prepare(`
    SELECT id FROM user_secret_allowlist
    WHERE secret_id = ? AND domain = ? AND revoked_at IS NULL
  `).bind(secret.id, domain.toLowerCase()).first();
  if (existingApproval) {
    return Response.json({ status: "already_approved" });
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO pending_domain_approvals (id, secret_id, domain, requested_at)
    VALUES (?, ?, ?, datetime('now'))
  `).bind(id, secret.id, domain.toLowerCase()).run();
  try {
    const doId = env.DASHBOARD.idFromName(dashboardId);
    const stub = env.DASHBOARD.get(doId);
    await stub.fetch(new Request("http://do/pending-approval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secretName, domain: domain.toLowerCase() })
    }));
  } catch (e) {
    console.warn("[approval] Failed to push notification to DO:", e);
  }
  return Response.json({ status: "pending", id });
}
async function getApprovedDomainsInternal(env, sandboxSessionId) {
  const session = await env.DB.prepare(`
    SELECT dashboard_id FROM sessions WHERE sandbox_session_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).bind(sandboxSessionId).first();
  let dashboardId = session?.dashboard_id;
  if (!dashboardId) {
    const sandbox = await env.DB.prepare(`
      SELECT dashboard_id FROM dashboard_sandboxes WHERE sandbox_session_id = ?
    `).bind(sandboxSessionId).first();
    dashboardId = sandbox?.dashboard_id;
  }
  if (!dashboardId) {
    return Response.json(
      { error: "E79224: Session not found" },
      { status: 404 }
    );
  }
  const dashboard = await env.DB.prepare(`
    SELECT owner_id FROM dashboards WHERE id = ?
  `).bind(dashboardId).first();
  if (!dashboard?.owner_id) {
    return Response.json(
      { error: "E79225: Dashboard not found" },
      { status: 404 }
    );
  }
  const userId = dashboard.owner_id;
  const approvals = await env.DB.prepare(`
    SELECT
      s.name as secret_name,
      a.domain,
      a.header_name,
      a.header_format
    FROM user_secret_allowlist a
    JOIN user_secrets s ON a.secret_id = s.id
    WHERE s.user_id = ?
      AND (s.dashboard_id = ? OR s.dashboard_id = '_global')
      AND a.revoked_at IS NULL
  `).bind(userId, dashboardId).all();
  const result = approvals.results.map((row) => ({
    secretName: row.secret_name,
    domain: row.domain,
    headerName: row.header_name,
    headerFormat: row.header_format
  }));
  return Response.json({ approvedDomains: result });
}
var sessionsRevision, MIRROR_TABLES, ELEVENLABS_VOICE_IDS, DEEPGRAM_VOICE_MODELS;
var init_handler2 = __esm({
  "src/sessions/handler.ts"() {
    "use strict";
    init_drive_cache();
    init_client();
    init_dashboard_token();
    init_pty_token();
    init_fetch();
    sessionsRevision = "sessions-v6-integration-persistence";
    console.log(`[sessions] REVISION: ${sessionsRevision} loaded at ${(/* @__PURE__ */ new Date()).toISOString()}`);
    MIRROR_TABLES = {
      github: "github_mirrors",
      box: "box_mirrors",
      onedrive: "onedrive_mirrors",
      drive: "drive_mirrors"
    };
    __name(getMirrorTableName, "getMirrorTableName");
    __name(generateId2, "generateId");
    ELEVENLABS_VOICE_IDS = {
      "Rachel": "21m00Tcm4TlvDq8ikWAM",
      "Domi": "AZnzlk1XvdvUeBnXmlld",
      "Bella": "EXAVITQu4vr4xnSDxMaL",
      "Antoni": "ErXwobaYiN019PkySvjV",
      "Elli": "MF3mGyEYCl7XYWbV9V6O",
      "Josh": "TxGEqnHWrfWFTfGW9XjX",
      "Arnold": "VR6AewLTigWG4xSOukaG",
      "Adam": "pNInz6obpgDQGcFmaJgB",
      "Sam": "yoZ06aMxZJJ28mfd3POQ"
    };
    DEEPGRAM_VOICE_MODELS = {
      "asteria": "aura-asteria-en",
      "luna": "aura-luna-en",
      "stella": "aura-stella-en",
      "athena": "aura-athena-en",
      "hera": "aura-hera-en",
      "orion": "aura-orion-en",
      "arcas": "aura-arcas-en",
      "perseus": "aura-perseus-en",
      "angus": "aura-angus-en",
      "orpheus": "aura-orpheus-en"
    };
    __name(parseTerminalConfig, "parseTerminalConfig");
    __name(f\u043ErmatDashb\u043EardItem, "f\u043ErmatDashb\u043EardItem");
    __name(getDashb\u043EardSandb\u043Ex, "getDashb\u043EardSandb\u043Ex");
    __name(ensureDashb\u043EardSandb\u043Ex, "ensureDashb\u043EardSandb\u043Ex");
    __name(driveManifestKey, "driveManifestKey");
    __name(mirrorManifestKey, "mirrorManifestKey");
    __name(workspaceSnapshotKey, "workspaceSnapshotKey");
    __name(captureWorkspaceSnapshot, "captureWorkspaceSnapshot");
    __name(triggerDriveMirrorSync, "triggerDriveMirrorSync");
    __name(triggerMirrorSync, "triggerMirrorSync");
    __name(createSessi\u043En, "createSessi\u043En");
    __name(startDashb\u043EardBrowser, "startDashb\u043EardBrowser");
    __name(st\u043EpDashb\u043EardBrowser, "st\u043EpDashb\u043EardBrowser");
    __name(getDashb\u043EardBrowserStatus, "getDashb\u043EardBrowserStatus");
    __name(openDashb\u043EardBrowser, "openDashb\u043EardBrowser");
    __name(openBrowserFromSandb\u043ExSessionInternal, "openBrowserFromSandb\u043ExSessionInternal");
    __name(getSessi\u043En, "getSessi\u043En");
    __name(updateSessi\u043EnEnv, "updateSessi\u043EnEnv");
    __name(st\u043EpSessi\u043En, "st\u043EpSessi\u043En");
    __name(getWorkspaceSnapshot, "getWorkspaceSnapshot");
    __name(applySecretsToSession, "applySecretsToSession");
    __name(createApprovalRequestInternal, "createApprovalRequestInternal");
    __name(getApprovedDomainsInternal, "getApprovedDomainsInternal");
  }
});

// src/schedules/executor.ts
var executor_exports = {};
__export(executor_exports, {
  executeScheduleByEdges: () => executeScheduleByEdges
});
function generateId5() {
  return crypto.randomUUID();
}
async function executeScheduleByEdges(env, schedule, triggeredBy, actorUserId) {
  const dashboardId = schedule.dashboardId;
  const itemId = schedule.dashboardItemId;
  if (!dashboardId || !itemId) {
    throw new Error("Edge-based schedule requires dashboardId and dashboardItemId");
  }
  const edges = await env.DB.prepare(`
    SELECT e.target_item_id, i.type
    FROM dashboard_edges e
    INNER JOIN dashboard_items i ON e.target_item_id = i.id
    WHERE e.source_item_id = ?
      AND i.type = 'terminal'
  `).bind(itemId).all();
  const terminalItemIds = edges.results.map((e) => e.target_item_id);
  const terminals = terminalItemIds.map((id) => ({
    itemId: id,
    ptyId: null,
    status: "pending",
    lastMessage: null,
    error: null
  }));
  const executionId = generateId5();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const executionStatus = terminals.length === 0 ? "completed" : "running";
  await env.DB.prepare(`
    INSERT INTO schedule_executions (id, schedule_id, status, triggered_by, terminals_json, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    executionId,
    schedule.id,
    executionStatus,
    triggeredBy,
    JSON.stringify(terminals),
    now,
    terminals.length === 0 ? now : null
  ).run();
  if (terminals.length === 0) {
    console.log(`[executor] Schedule ${schedule.id} has no connected terminals \u2014 marked complete`);
    return {
      id: executionId,
      scheduleId: schedule.id,
      status: "completed",
      triggeredBy,
      terminals: [],
      startedAt: now,
      completedAt: now,
      error: null
    };
  }
  let effectiveUserId = actorUserId;
  if (!effectiveUserId) {
    const owner = await env.DB.prepare(`
      SELECT user_id FROM dashboard_members
      WHERE dashboard_id = ? AND role = 'owner'
      LIMIT 1
    `).bind(dashboardId).first();
    if (!owner) {
      await markExecutionFailed(env, executionId, "Dashboard has no owner");
      throw new Error(`Dashboard ${dashboardId} has no owner`);
    }
    effectiveUserId = owner.user_id;
  }
  const envWithCache = env;
  const sandboxResult = await ensureDashb\u043EardSandb\u043Ex(envWithCache, dashboardId, effectiveUserId);
  if (sandboxResult instanceof Response) {
    await markExecutionFailed(env, executionId, "Failed to ensure sandbox");
    throw new Error("Failed to ensure sandbox for dashboard");
  }
  const { sandboxSessionId, sandboxMachineId } = sandboxResult;
  const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
  for (let i = 0; i < terminals.length; i++) {
    const terminal = terminals[i];
    try {
      const activeSession = await env.DB.prepare(`
        SELECT id, pty_id, sandbox_session_id, sandbox_machine_id
        FROM sessions
        WHERE item_id = ? AND status = 'active'
        ORDER BY created_at DESC LIMIT 1
      `).bind(terminal.itemId).first();
      if (activeSession?.pty_id) {
        const command = (schedule.command || "").trim();
        terminal.ptyId = activeSession.pty_id;
        if (!command) {
          terminal.status = "completed";
          console.log(`[executor] No command for existing PTY ${terminal.ptyId} \u2014 marked completed`);
        } else {
          await sandbox.writePty(
            activeSession.sandbox_session_id,
            activeSession.pty_id,
            command,
            activeSession.sandbox_machine_id || sandboxMachineId
            // No executionId — fire-and-forget, no callback needed
          );
          terminal.status = "completed";
          console.log(`[executor] Wrote command to existing PTY ${terminal.ptyId} for terminal ${terminal.itemId} \u2014 marked completed (fire-and-forget)`);
        }
      } else {
        const command = (schedule.command || "").trim();
        if (!command) {
          terminal.status = "completed";
          console.log(`[executor] No command and no active PTY for terminal ${terminal.itemId} \u2014 marked completed`);
        } else {
          const ptyId = generateId5();
          const integrationToken = await createPtyToken(
            ptyId,
            sandboxSessionId,
            dashboardId,
            effectiveUserId,
            env.INTERNAL_API_TOKEN
          );
          terminal.ptyId = ptyId;
          terminal.status = "running";
          await env.DB.prepare(`
            UPDATE schedule_executions SET terminals_json = ? WHERE id = ?
          `).bind(JSON.stringify(terminals), executionId).run();
          await sandbox.createPty(
            sandboxSessionId,
            "system",
            // creatorId
            command,
            sandboxMachineId,
            {
              ptyId,
              integrationToken,
              executionId
              // Set at creation time so callback is registered before process starts
            }
          );
          const sessionId = generateId5();
          await env.DB.prepare(`
            INSERT INTO sessions (id, dashboard_id, item_id, owner_user_id, owner_name, sandbox_session_id, sandbox_machine_id, pty_id, status, created_at)
            VALUES (?, ?, ?, ?, 'system', ?, ?, ?, 'active', ?)
          `).bind(
            sessionId,
            dashboardId,
            terminal.itemId,
            effectiveUserId,
            sandboxSessionId,
            sandboxMachineId,
            ptyId,
            now
          ).run();
          console.log(`[executor] Created PTY ${ptyId} for terminal ${terminal.itemId}`);
        }
      }
    } catch (error) {
      console.error(`[executor] Failed to trigger terminal ${terminal.itemId}:`, error);
      terminal.status = "failed";
      terminal.error = error instanceof Error ? error.message : "Unknown error";
    }
  }
  const latest = await env.DB.prepare(`
    SELECT status, terminals_json FROM schedule_executions WHERE id = ?
  `).bind(executionId).first();
  if (!latest || latest.status !== "running") {
    const finalTerminals = latest ? JSON.parse(latest.terminals_json) : terminals;
    return {
      id: executionId,
      scheduleId: schedule.id,
      status: latest?.status || "completed",
      triggeredBy,
      terminals: finalTerminals,
      startedAt: now,
      completedAt: (/* @__PURE__ */ new Date()).toISOString(),
      error: null
    };
  }
  const dbTerminals = JSON.parse(latest.terminals_json);
  const isDone = /* @__PURE__ */ __name((s) => s === "completed" || s === "failed" || s === "timed_out", "isDone");
  const mergedTerminals = terminals.map((local) => {
    const dbEntry = dbTerminals.find((d) => d.itemId === local.itemId);
    if (dbEntry && isDone(dbEntry.status)) {
      return dbEntry;
    }
    return local;
  });
  const allDone = mergedTerminals.every((t) => isDone(t.status));
  const allFailed = mergedTerminals.every((t) => t.status === "failed");
  const anyFailed = mergedTerminals.some((t) => t.status === "failed");
  let finalStatus;
  let finalError = null;
  if (allFailed) {
    finalStatus = "failed";
    finalError = "All terminals failed to trigger";
  } else if (allDone && anyFailed) {
    finalStatus = "failed";
    finalError = "One or more terminals failed";
  } else if (allDone) {
    finalStatus = "completed";
  } else {
    finalStatus = "running";
  }
  const completedAt = allDone ? (/* @__PURE__ */ new Date()).toISOString() : null;
  await env.DB.prepare(`
    UPDATE schedule_executions SET terminals_json = ?, status = ?, completed_at = COALESCE(?, completed_at), error = ?
    WHERE id = ? AND status = 'running'
  `).bind(JSON.stringify(mergedTerminals), finalStatus, completedAt, finalError, executionId).run();
  return {
    id: executionId,
    scheduleId: schedule.id,
    status: finalStatus,
    triggeredBy,
    terminals: mergedTerminals,
    startedAt: now,
    completedAt,
    error: finalError
  };
}
async function markExecutionFailed(env, executionId, error) {
  await env.DB.prepare(`
    UPDATE schedule_executions SET status = 'failed', completed_at = datetime('now'), error = ? WHERE id = ?
  `).bind(error, executionId).run();
}
var MODULE_REVISION;
var init_executor = __esm({
  "src/schedules/executor.ts"() {
    "use strict";
    init_handler2();
    init_client();
    init_pty_token();
    MODULE_REVISION = "server-side-cron-v1-edge-executor";
    console.log(`[executor] REVISION: ${MODULE_REVISION} loaded at ${(/* @__PURE__ */ new Date()).toISOString()}`);
    __name(generateId5, "generateId");
    __name(executeScheduleByEdges, "executeScheduleByEdges");
    __name(markExecutionFailed, "markExecutionFailed");
  }
});

// src/types.ts
var HIGH_RISK_CAPABILITIES;
var init_types = __esm({
  "src/types.ts"() {
    "use strict";
    HIGH_RISK_CAPABILITIES = {
      gmail: ["canSend", "canTrash"],
      google_calendar: ["canDelete"],
      google_contacts: ["canDelete"],
      google_sheets: ["writePolicy.canDeleteSheets"],
      google_forms: ["canDelete"],
      google_drive: ["canDelete", "canShare"],
      onedrive: ["canDelete", "canShare"],
      box: ["canDelete", "canShare"],
      github: ["canPush", "canMergePRs", "canApprovePRs", "canDeleteRepos"],
      browser: ["canSubmitForms", "canExecuteJs", "canUpload", "canInputCredentials"],
      slack: ["canSend", "canEditMessages", "canDeleteMessages"],
      discord: ["canSend", "canEditMessages", "canDeleteMessages"],
      telegram: ["canSend", "canEditMessages", "canDeleteMessages"],
      whatsapp: ["canSend", "canEditMessages", "canDeleteMessages"],
      teams: ["canSend", "canEditMessages", "canDeleteMessages"],
      matrix: ["canSend", "canEditMessages", "canDeleteMessages"],
      google_chat: ["canSend", "canEditMessages", "canDeleteMessages"]
    };
  }
});

// src/integration-policies/handler.ts
function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp("^" + escaped + "$", "i");
}
function generateId7(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}
function getActionCategory(provider, action) {
  if (action.includes("download") || action.includes("clone")) {
    return "downloads";
  }
  if (action.includes("upload")) {
    return "uploads";
  }
  if (action.includes("send") || action.includes("push") || action.includes("create_pr") || action.includes("reply") || action.includes("draft")) {
    return "sends";
  }
  if (action.includes("delete") || action.includes("trash") || action.includes("remove")) {
    return "deletes";
  }
  if (action.includes("create") || action.includes("update") || action.includes("write") || action.includes("archive") || action.includes("label") || action.includes("move") || action.includes("share") || action.includes("edit") || action.includes("react")) {
    return "writes";
  }
  return "reads";
}
async function checkRateLimit(env, terminalIntegrationId, provider, action, policy) {
  const rateLimits = policy.rateLimits;
  if (!rateLimits) {
    return { allowed: true };
  }
  const category = getActionCategory(provider, action);
  let limit;
  let window;
  switch (category) {
    case "reads":
      limit = rateLimits.readsPerMinute;
      window = "minute";
      break;
    case "writes":
      limit = rateLimits.writesPerHour;
      window = "hour";
      break;
    case "deletes":
      limit = rateLimits.deletesPerHour ?? rateLimits.writesPerHour;
      window = "hour";
      break;
    case "sends":
      if (rateLimits.sendsPerDay) {
        limit = rateLimits.sendsPerDay;
        window = "day";
      } else {
        limit = rateLimits.sendsPerHour ?? rateLimits.writesPerHour;
        window = "hour";
      }
      break;
    case "downloads":
      limit = rateLimits.downloadsPerHour ?? rateLimits.readsPerMinute;
      window = rateLimits.downloadsPerHour ? "hour" : "minute";
      break;
    case "uploads":
      limit = rateLimits.uploadsPerHour ?? rateLimits.writesPerHour;
      window = "hour";
      break;
  }
  if (!limit) {
    return { allowed: true };
  }
  const counterKey = `${terminalIntegrationId}:${provider}:${category}`;
  const counterId = env.RATE_LIMIT_COUNTER.idFromName(counterKey);
  const counter = env.RATE_LIMIT_COUNTER.get(counterId);
  try {
    const response = await counter.fetch(new Request("http://rate-limit/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ window, limit, increment: true })
    }));
    const result = await response.json();
    if (!result.allowed) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${result.current}/${result.limit} ${category} per ${window}`
      };
    }
    return { allowed: true };
  } catch (e) {
    console.error("[rate-limit] Failed to check rate limit (failing closed):", e);
    return { allowed: false, reason: "Rate limiter unavailable - request denied for safety" };
  }
}
function calculateSecurityLevel(provider, policy) {
  switch (provider) {
    case "gmail": {
      const p = policy;
      if (p.canSend)
        return "full";
      if (p.canTrash || p.canArchive || p.canLabel || p.canMarkRead)
        return "elevated";
      return "restricted";
    }
    case "google_calendar": {
      const p = policy;
      if (p.canDelete)
        return "full";
      if (p.canCreate || p.canUpdate)
        return "elevated";
      return "restricted";
    }
    case "google_contacts": {
      const p = policy;
      if (p.canDelete)
        return "full";
      if (p.canCreate || p.canUpdate)
        return "elevated";
      return "restricted";
    }
    case "google_sheets": {
      const p = policy;
      if (p.writePolicy?.canDeleteSheets)
        return "full";
      if (p.canWrite || p.canUseFormulas)
        return "elevated";
      return "restricted";
    }
    case "google_forms": {
      const p = policy;
      if (p.canDelete)
        return "full";
      if (p.canCreate || p.canUpdate || p.canReadResponses)
        return "elevated";
      return "restricted";
    }
    case "google_drive":
    case "onedrive":
    case "box": {
      const p = policy;
      if (p.canDelete || p.canShare)
        return "full";
      if (p.canUpload || p.canUpdate || p.canMove)
        return "elevated";
      return "restricted";
    }
    case "github": {
      const p = policy;
      if (p.canMergePRs || p.canPush || p.canDeleteRepos || p.canApprovePRs)
        return "full";
      if (p.canCreatePRs || p.canCreateIssues || p.canCommentIssues || p.canClone)
        return "elevated";
      return "restricted";
    }
    case "browser": {
      const p = policy;
      if (p.canSubmitForms || p.canExecuteJs || p.canUpload || p.canInputCredentials)
        return "full";
      if (p.canClick || p.canType || p.canFillForms || p.canDownload)
        return "elevated";
      return "restricted";
    }
    case "slack":
    case "discord":
    case "telegram":
    case "whatsapp":
    case "teams":
    case "matrix":
    case "google_chat": {
      const p = policy;
      if (p.canSend || p.canDeleteMessages || p.canEditMessages)
        return "full";
      if (p.canReceive || p.canReact || p.canReadHistory || p.canUploadFiles)
        return "elevated";
      return "restricted";
    }
    default: {
      const _exhaustive = provider;
      return "restricted";
    }
  }
}
function createDefaultFullAccessPolicy(provider) {
  switch (provider) {
    case "gmail":
      return {
        canRead: true,
        canArchive: true,
        canTrash: true,
        canMarkRead: true,
        canLabel: true,
        canSend: true
      };
    case "google_calendar":
      return {
        canRead: true,
        canCreate: true,
        canUpdate: true,
        canDelete: true
      };
    case "google_contacts":
      return {
        canRead: true,
        canCreate: true,
        canUpdate: true,
        canDelete: true
      };
    case "google_sheets":
      return {
        canRead: true,
        canWrite: true,
        canUseFormulas: true,
        writePolicy: { canCreateNew: true, canDeleteSheets: true }
      };
    case "google_forms":
      return {
        canRead: true,
        canReadResponses: true,
        canCreate: true,
        canUpdate: true,
        canDelete: true
      };
    case "google_drive":
      return {
        canRead: true,
        canDownload: true,
        canUpload: true,
        canCreate: true,
        canUpdate: true,
        canDelete: true,
        canMove: true,
        canShare: true,
        sharePolicy: { noPublicSharing: false }
      };
    case "onedrive":
      return {
        canRead: true,
        canDownload: true,
        canUpload: true,
        canCreate: true,
        canUpdate: true,
        canDelete: true,
        canMove: true,
        canShare: true,
        sharePolicy: { noAnonymousLinks: false }
      };
    case "box":
      return {
        canRead: true,
        canDownload: true,
        canUpload: true,
        canCreate: true,
        canUpdate: true,
        canDelete: true,
        canMove: true,
        canShare: true,
        sharePolicy: { noOpenAccess: false }
      };
    case "github":
      return {
        canReadRepos: true,
        canReadCode: true,
        canClone: true,
        canPush: true,
        canReadIssues: true,
        canCreateIssues: true,
        canCommentIssues: true,
        canCloseIssues: true,
        canReadPRs: true,
        canCreatePRs: true,
        canApprovePRs: true,
        canMergePRs: true,
        canCreateReleases: true,
        canTriggerActions: true,
        canCreateRepos: false,
        canDeleteRepos: false,
        canManageSettings: false
      };
    case "browser":
      return {
        canNavigate: true,
        urlFilter: { mode: "allowlist", patterns: [] },
        canClick: true,
        canType: true,
        canScroll: true,
        canScreenshot: true,
        canExtractText: true,
        canFillForms: false,
        canSubmitForms: false,
        canDownload: false,
        canUpload: false,
        canExecuteJs: false,
        canUseStoredCredentials: false,
        canInputCredentials: false,
        canReadCookies: false,
        canInspectNetwork: false,
        canModifyRequests: false
      };
    case "slack":
    case "discord":
    case "telegram":
    case "whatsapp":
    case "teams":
    case "matrix":
    case "google_chat":
      return {
        canReceive: true,
        channelFilter: { mode: "all" },
        // No channel restriction
        senderFilter: { mode: "all" },
        canSend: true,
        sendPolicy: {},
        canReact: true,
        canEditMessages: true,
        canDeleteMessages: false,
        // Deleting still off by default — destructive
        canUploadFiles: true,
        canReadHistory: true
      };
    default: {
      const _exhaustive = provider;
      throw new Error(`Unknown provider: ${provider}`);
    }
  }
}
async function enforcePolicy(env, provider, action, policy, terminalIntegrationId, context) {
  const providerActions = ACTION_TO_CAPABILITY[provider];
  if (!providerActions) {
    return { allowed: false, decision: "denied", reason: `Unknown provider: ${provider}` };
  }
  const capability = providerActions[action];
  if (!capability) {
    return { allowed: false, decision: "denied", reason: `Unknown action: ${action}` };
  }
  const policyObj = policy;
  const capabilityEnabled = policyObj[capability];
  if (capabilityEnabled !== true) {
    return {
      allowed: false,
      decision: "denied",
      reason: `Policy does not allow ${capability}`
    };
  }
  const highRiskCaps = HIGH_RISK_CAPABILITIES[provider] || [];
  if (highRiskCaps.includes(capability)) {
    const confirmed = await env.DB.prepare(`
      SELECT id FROM high_risk_confirmations
      WHERE terminal_integration_id = ? AND capability = ?
      LIMIT 1
    `).bind(terminalIntegrationId, capability).first();
    if (!confirmed) {
      return {
        allowed: false,
        decision: "denied",
        reason: `High-risk capability ${capability} requires explicit user confirmation`
      };
    }
  }
  if (provider === "gmail" && context) {
    const gmailPolicy = policy;
    if (action === "gmail.send" || action === "gmail.reply" || action === "gmail.draft") {
      if (gmailPolicy.sendPolicy) {
        const { allowedRecipients, allowedDomains } = gmailPolicy.sendPolicy;
        if (allowedDomains?.length || allowedRecipients?.length) {
          const allRecipients = context.recipients?.length ? context.recipients : context.recipient ? [context.recipient] : [];
          const allDomains = context.recipientDomains?.length ? context.recipientDomains : context.recipientDomain ? [context.recipientDomain] : [];
          if (allRecipients.length === 0) {
            return {
              allowed: false,
              decision: "denied",
              reason: "No recipients provided for send operation"
            };
          }
          for (let i = 0; i < allRecipients.length; i++) {
            const recipient = allRecipients[i]?.toLowerCase();
            const recipientDomain = allDomains[i]?.toLowerCase();
            const domainAllowed = allowedDomains?.some((d) => d.toLowerCase() === recipientDomain);
            const recipientAllowed = allowedRecipients?.some((r) => r.toLowerCase() === recipient);
            if (!domainAllowed && !recipientAllowed) {
              return {
                allowed: false,
                decision: "denied",
                reason: `Recipient ${recipient} not in allowed list`
              };
            }
          }
        }
      }
    }
  }
  if (provider === "github" && context) {
    const githubPolicy = policy;
    if (githubPolicy.repoFilter && githubPolicy.repoFilter.mode !== "all" && context.repoOwner) {
      const { mode, repos: repoPatterns, orgs } = githubPolicy.repoFilter;
      const ownerName = context.repoOwner.toLowerCase();
      const fullName = context.repoName ? `${context.repoOwner}/${context.repoName}`.toLowerCase() : "";
      let orgMatch = true;
      let repoMatch = true;
      if (orgs?.length) {
        orgMatch = orgs.some((o) => o.toLowerCase() === ownerName);
      }
      if (repoPatterns?.length && fullName) {
        repoMatch = repoPatterns.some((pattern) => {
          return globToRegex(pattern.toLowerCase()).test(fullName);
        });
      }
      if (mode === "allowlist") {
        const orgAllowed = orgs?.length ? orgMatch : false;
        const repoAllowed = repoPatterns?.length ? repoMatch : false;
        if (!orgAllowed && !repoAllowed) {
          return {
            allowed: false,
            decision: "denied",
            reason: `Repository ${fullName || ownerName} not in allowlist`
          };
        }
      }
      if (mode === "blocklist") {
        const orgBlocked = orgs?.length && orgMatch;
        const repoBlocked = repoPatterns?.length && repoMatch;
        if (orgBlocked || repoBlocked) {
          return {
            allowed: false,
            decision: "denied",
            reason: `Repository ${fullName || ownerName} is blocklisted`
          };
        }
      }
    }
  }
  if (provider === "google_calendar" && context) {
    const calendarPolicy = policy;
    const isCalendarScoped = action !== "calendar.list_calendars" && action !== "calendar.list";
    if (isCalendarScoped) {
      const calendarId = context.calendarId?.toLowerCase() || "primary";
      if (calendarPolicy.calendarFilter && calendarPolicy.calendarFilter.mode !== "all") {
        const { calendarIds } = calendarPolicy.calendarFilter;
        if (calendarIds?.length) {
          const allowed = calendarIds.some((id) => id.toLowerCase() === calendarId || calendarId === "primary" && id === "primary");
          if (!allowed) {
            return {
              allowed: false,
              decision: "denied",
              reason: `Calendar ${calendarId} not in allowlist`
            };
          }
        }
      }
      if (action.includes("create") && calendarPolicy.createPolicy?.allowedCalendars?.length) {
        const allowed = calendarPolicy.createPolicy.allowedCalendars.some(
          (id) => id.toLowerCase() === calendarId || calendarId === "primary" && id === "primary"
        );
        if (!allowed) {
          return {
            allowed: false,
            decision: "denied",
            reason: `Cannot create events in calendar ${calendarId}`
          };
        }
      }
    }
  }
  if (provider === "google_drive" && context) {
    const drivePolicy = policy;
    if (drivePolicy.folderFilter && drivePolicy.folderFilter.mode !== "all" && drivePolicy.folderFilter.folderIds?.length) {
      const { mode, folderIds } = drivePolicy.folderFilter;
      if (action === "drive.create" && context.folderId) {
        const inAllowedFolder = folderIds.includes(context.folderId);
        if (mode === "allowlist" && !inAllowedFolder) {
          return {
            allowed: false,
            decision: "denied",
            reason: `Folder ${context.folderId} not in allowed folder list`
          };
        }
        if (mode === "blocklist" && inAllowedFolder) {
          return {
            allowed: false,
            decision: "denied",
            reason: `Folder ${context.folderId} is blocklisted`
          };
        }
      }
    }
    if (drivePolicy.fileTypeFilter && drivePolicy.fileTypeFilter.mode !== "all") {
      const { mode, mimeTypes, extensions } = drivePolicy.fileTypeFilter;
      if (action === "drive.create") {
        const fileMime = context.mimeType?.toLowerCase();
        const fileName = context.fileName?.toLowerCase();
        const mimeMatch = mimeTypes?.some((t) => fileMime?.includes(t.toLowerCase()));
        const extMatch = extensions?.some((ext) => fileName?.endsWith(ext.toLowerCase()));
        const typeMatch = mimeMatch || extMatch;
        if (mode === "allowlist" && !typeMatch) {
          return {
            allowed: false,
            decision: "denied",
            reason: `File type ${fileMime || "unknown"} (${fileName || "unnamed"}) not in allowed types`
          };
        }
        if (mode === "blocklist" && typeMatch) {
          return {
            allowed: false,
            decision: "denied",
            reason: `File type ${fileMime || "unknown"} (${fileName || "unnamed"}) is blocklisted`
          };
        }
      }
    }
  }
  if (provider === "browser") {
    const browserPolicy = policy;
    if (browserPolicy.urlFilter && browserPolicy.urlFilter.patterns?.length) {
      const BROWSER_LIFECYCLE_ACTIONS = /* @__PURE__ */ new Set([
        "browser.lifecycle"
        // start/stop/status mapped to this action
      ]);
      if (!BROWSER_LIFECYCLE_ACTIONS.has(action)) {
        if (!context?.url) {
          return {
            allowed: false,
            decision: "denied",
            reason: "Browser URL required for URL filter enforcement but not available"
          };
        }
      }
      if (context?.url) {
        const { mode, patterns } = browserPolicy.urlFilter;
        const url = context.url.toLowerCase();
        if (mode === "allowlist") {
          const allowed = patterns.some((pattern) => globToRegex(pattern).test(url));
          if (!allowed) {
            return {
              allowed: false,
              decision: "denied",
              reason: `URL ${url} not in allowlist`
            };
          }
        } else if (mode === "blocklist") {
          const blocked = patterns.some((pattern) => globToRegex(pattern).test(url));
          if (blocked) {
            return {
              allowed: false,
              decision: "denied",
              reason: `URL ${url} is blocklisted`
            };
          }
        }
      }
    }
  }
  const messagingProviders = ["slack", "discord", "telegram", "whatsapp", "teams", "matrix", "google_chat"];
  if (messagingProviders.includes(provider) && context) {
    const msgPolicy = policy;
    const CHANNEL_TARGETED_CAPABILITIES = /* @__PURE__ */ new Set([
      "canSend",
      "canReadHistory",
      "canReact",
      "canEditMessages",
      "canDeleteMessages"
    ]);
    if (msgPolicy.channelFilter && CHANNEL_TARGETED_CAPABILITIES.has(capability)) {
      if (msgPolicy.channelFilter.mode === "allowlist") {
        const { channelIds, channelNames } = msgPolicy.channelFilter;
        const hasChannelAllowlist = channelIds?.length || channelNames?.length;
        if (hasChannelAllowlist) {
          if (!context.channelId) {
            return {
              allowed: false,
              decision: "denied",
              reason: "Channel allowlist is configured but no channel specified in request"
            };
          }
          const channelIdAllowed = channelIds?.some((id) => id === context.channelId);
          const normalizedCtxName = context.channelName?.replace(/^#/, "").toLowerCase();
          const channelNameAllowed = normalizedCtxName && channelNames?.some(
            (name) => name.replace(/^#/, "").toLowerCase() === normalizedCtxName
          );
          if (!channelIdAllowed && !channelNameAllowed) {
            return {
              allowed: false,
              decision: "denied",
              reason: `Channel ${context.channelName || context.channelId} not in allowlist`
            };
          }
        } else {
          return {
            allowed: false,
            decision: "denied",
            reason: "No channels configured in allowlist \u2014 add channels to policy"
          };
        }
      }
    }
    if (capability === "canSend" && msgPolicy.sendPolicy) {
      const { allowedChannels, allowedRecipients, maxMessageLength, requireThreadReply } = msgPolicy.sendPolicy;
      if (allowedChannels?.length) {
        const idMatch = context.channelId && allowedChannels.includes(context.channelId);
        const normalizedCtxName = context.channelName?.replace(/^#/, "").toLowerCase();
        const nameMatch = normalizedCtxName && allowedChannels.some(
          (ch) => ch.replace(/^#/, "").toLowerCase() === normalizedCtxName
        );
        if (!idMatch && !nameMatch) {
          return {
            allowed: false,
            decision: "denied",
            reason: `Cannot send to channel ${context.channelName || context.channelId || "(unspecified)"}`
          };
        }
      }
      if (requireThreadReply && !context.threadTs) {
        return {
          allowed: false,
          decision: "denied",
          reason: "Policy requires thread replies \u2014 provide a thread_ts or reply_to_message_id"
        };
      }
      if (maxMessageLength && context.messageText && context.messageText.length > maxMessageLength) {
        return {
          allowed: false,
          decision: "denied",
          reason: `Message length ${context.messageText.length} exceeds limit of ${maxMessageLength} characters`
        };
      }
      if (allowedRecipients?.length && context.recipientUserId) {
        if (!allowedRecipients.includes(context.recipientUserId)) {
          return {
            allowed: false,
            decision: "denied",
            reason: `Recipient ${context.recipientUserId} not in allowed recipients list`
          };
        }
      }
    }
  }
  return { allowed: true, decision: "allowed" };
}
function formatTerminalIntegration(row) {
  return {
    id: row.id,
    terminalId: row.terminal_id,
    itemId: row.item_id ?? null,
    dashboardId: row.dashboard_id,
    userId: row.user_id,
    provider: row.provider,
    userIntegrationId: row.user_integration_id,
    activePolicyId: row.active_policy_id,
    accountEmail: row.account_email,
    accountLabel: row.account_label,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by
  };
}
function formatIntegrationPolicy(row) {
  return {
    id: row.id,
    terminalIntegrationId: row.terminal_integration_id,
    version: row.version,
    policy: JSON.parse(row.policy),
    securityLevel: row.security_level,
    createdAt: row.created_at,
    createdBy: row.created_by
  };
}
async function ensureDashboardAccess2(env, dashboardId, userId) {
  const access = await env.DB.prepare(
    `SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?`
  ).bind(dashboardId, userId).first();
  return access ?? null;
}
async function ensureTerminalAccess(env, terminalId, userId) {
  const session = await env.DB.prepare(`
    SELECT s.dashboard_id
    FROM sessions s
    JOIN dashboard_members dm ON s.dashboard_id = dm.dashboard_id
    WHERE s.pty_id = ? AND dm.user_id = ?
  `).bind(terminalId, userId).first();
  if (!session)
    return null;
  return { dashboardId: session.dashboard_id };
}
async function listAvailableIntegrations(env, dashboardId, terminalId, userId) {
  const access = await ensureDashboardAccess2(env, dashboardId, userId);
  if (!access) {
    return Response.json({ error: "E79734: Not found or no access" }, { status: 404 });
  }
  const terminalAccess = await ensureTerminalAccess(env, terminalId, userId);
  if (!terminalAccess || terminalAccess.dashboardId !== dashboardId) {
    return Response.json({ error: "E79735: Terminal not found or does not belong to this dashboard" }, { status: 404 });
  }
  const userIntegrations = await env.DB.prepare(`
    SELECT id, provider, metadata
    FROM user_integrations
    WHERE user_id = ?
  `).bind(userId).all();
  const attachedIntegrations = await env.DB.prepare(`
    SELECT provider, id as terminal_integration_id, active_policy_id, user_integration_id
    FROM terminal_integrations
    WHERE terminal_id = ? AND deleted_at IS NULL
  `).bind(terminalId).all();
  const attachedMap = /* @__PURE__ */ new Map();
  for (const row of attachedIntegrations.results) {
    attachedMap.set(row.provider, row);
  }
  const integrations = [];
  for (const row of userIntegrations.results) {
    const provider = row.provider;
    const metadata = row.metadata ? JSON.parse(row.metadata) : {};
    const attached = attachedMap.get(provider);
    integrations.push({
      provider,
      userIntegrationId: row.id,
      accountEmail: metadata.email || metadata.login || null,
      accountLabel: metadata.name || null,
      connected: true,
      attached: !!attached && attached.user_integration_id === row.id,
      terminalIntegrationId: attached?.terminal_integration_id,
      policyId: attached?.active_policy_id
    });
  }
  const browserAttached = attachedMap.get("browser");
  integrations.push({
    provider: "browser",
    connected: true,
    attached: !!browserAttached,
    terminalIntegrationId: browserAttached?.terminal_integration_id,
    policyId: browserAttached?.active_policy_id
  });
  const connectedProviders = new Set(userIntegrations.results.map((r) => r.provider));
  const allProviders = [
    "gmail",
    "google_calendar",
    "google_contacts",
    "google_sheets",
    "google_forms",
    "google_drive",
    "onedrive",
    "box",
    "github"
  ];
  for (const provider of allProviders) {
    if (!connectedProviders.has(provider)) {
      integrations.push({
        provider,
        connected: false,
        attached: false
      });
    }
  }
  return Response.json({ integrations });
}
async function listTerminalIntegrations(env, dashboardId, terminalId, userId) {
  const access = await ensureDashboardAccess2(env, dashboardId, userId);
  if (!access) {
    return Response.json({ error: "E79734: Not found or no access" }, { status: 404 });
  }
  const terminalAccess = await ensureTerminalAccess(env, terminalId, userId);
  if (!terminalAccess || terminalAccess.dashboardId !== dashboardId) {
    return Response.json({ error: "E79735: Terminal not found or does not belong to this dashboard" }, { status: 404 });
  }
  const rows = await env.DB.prepare(`
    SELECT ti.*, ip.policy, ip.version as policy_version, ip.security_level
    FROM terminal_integrations ti
    LEFT JOIN integration_policies ip ON ti.active_policy_id = ip.id
    WHERE ti.terminal_id = ? AND ti.dashboard_id = ? AND ti.deleted_at IS NULL
    ORDER BY ti.created_at DESC
  `).bind(terminalId, dashboardId).all();
  const integrations = rows.results.map((row) => {
    const base = formatTerminalIntegration(row);
    return {
      ...base,
      policy: row.policy ? JSON.parse(row.policy) : null,
      policyVersion: row.policy_version ?? null,
      securityLevel: row.security_level ?? null
    };
  });
  return Response.json({ integrations });
}
async function listDashboardIntegrationLabels(env, dashboardId, userId) {
  const access = await ensureDashboardAccess2(env, dashboardId, userId);
  if (!access) {
    return Response.json({ error: "E79780: Not found or no access" }, { status: 404 });
  }
  const rows = await env.DB.prepare(`
    SELECT ti.item_id, ti.provider, ip.security_level
    FROM terminal_integrations ti
    LEFT JOIN integration_policies ip ON ti.active_policy_id = ip.id
    WHERE ti.dashboard_id = ? AND ti.deleted_at IS NULL AND ti.item_id IS NOT NULL
  `).bind(dashboardId).all();
  const labels = rows.results.map((row) => ({
    itemId: row.item_id,
    provider: row.provider,
    securityLevel: row.security_level ?? null
  }));
  return Response.json({ labels });
}
async function attachIntegration(env, dashboardId, terminalId, userId, data) {
  const { provider, userIntegrationId, policy: providedPolicy, accountLabel, highRiskConfirmations } = data;
  const access = await ensureDashboardAccess2(env, dashboardId, userId);
  if (!access || access.role === "viewer") {
    return Response.json({ error: "E79734: Not found or no access" }, { status: 404 });
  }
  const terminalAccess = await ensureTerminalAccess(env, terminalId, userId);
  if (!terminalAccess) {
    return Response.json({ error: "E79735: Terminal not found or no access" }, { status: 404 });
  }
  if (terminalAccess.dashboardId !== dashboardId) {
    return Response.json({ error: "E79736: Terminal does not belong to this dashboard" }, { status: 403 });
  }
  if (provider === "browser") {
    const browserPolicy = providedPolicy;
    if (!browserPolicy?.urlFilter?.patterns?.length) {
      return Response.json(
        { error: "Browser integration requires at least one URL pattern" },
        { status: 400 }
      );
    }
  } else {
    if (!userIntegrationId) {
      return Response.json(
        { error: "userIntegrationId is required for non-browser providers" },
        { status: 400 }
      );
    }
    const userInt = await env.DB.prepare(
      `SELECT user_id, metadata FROM user_integrations WHERE id = ?`
    ).bind(userIntegrationId).first();
    if (!userInt || userInt.user_id !== userId) {
      return Response.json(
        { error: "OAuth connection does not belong to user" },
        { status: 403 }
      );
    }
  }
  const existing = await env.DB.prepare(`
    SELECT id FROM terminal_integrations
    WHERE terminal_id = ? AND provider = ? AND deleted_at IS NULL
  `).bind(terminalId, provider).first();
  if (existing) {
    return Response.json(
      { error: `${provider} is already attached to this terminal` },
      { status: 409 }
    );
  }
  let accountEmail = null;
  if (userIntegrationId) {
    const userInt = await env.DB.prepare(
      `SELECT metadata FROM user_integrations WHERE id = ?`
    ).bind(userIntegrationId).first();
    if (userInt?.metadata) {
      const meta = JSON.parse(userInt.metadata);
      accountEmail = meta.email || meta.login || null;
    }
  }
  const policy = providedPolicy ?? createDefaultFullAccessPolicy(provider);
  const securityLevel = calculateSecurityLevel(provider, policy);
  const terminalIntegrationId = generateId7("ti");
  const policyId = generateId7("pol");
  const sessionForItem = await env.DB.prepare(
    `SELECT item_id FROM sessions WHERE pty_id = ? ORDER BY created_at DESC LIMIT 1`
  ).bind(terminalId).first();
  const itemId = sessionForItem?.item_id ?? null;
  const statements = [
    env.DB.prepare(`
      INSERT INTO terminal_integrations
        (id, terminal_id, item_id, dashboard_id, user_id, provider, user_integration_id,
         active_policy_id, account_email, account_label, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      terminalIntegrationId,
      terminalId,
      itemId,
      dashboardId,
      userId,
      provider,
      userIntegrationId ?? null,
      policyId,
      accountEmail,
      accountLabel ?? null,
      userId
    ),
    env.DB.prepare(`
      INSERT INTO integration_policies
        (id, terminal_integration_id, version, policy, security_level, created_by)
      VALUES (?, ?, 1, ?, ?, ?)
    `).bind(policyId, terminalIntegrationId, JSON.stringify(policy), securityLevel, userId)
  ];
  if (highRiskConfirmations?.length) {
    for (const capability of highRiskConfirmations) {
      const confirmId = generateId7("hrc");
      statements.push(
        env.DB.prepare(`
          INSERT INTO high_risk_confirmations
            (id, terminal_integration_id, capability, confirmed_by)
          VALUES (?, ?, ?, ?)
        `).bind(confirmId, terminalIntegrationId, capability, userId)
      );
    }
  }
  await env.DB.batch(statements);
  return Response.json({
    id: terminalIntegrationId,
    provider,
    userIntegrationId: userIntegrationId ?? null,
    activePolicyId: policyId,
    policyVersion: 1,
    securityLevel,
    accountEmail,
    accountLabel: accountLabel ?? null
  });
}
async function updateIntegrationPolicy(env, dashboardId, terminalId, provider, userId, data) {
  const { policy, highRiskConfirmations } = data;
  const access = await ensureDashboardAccess2(env, dashboardId, userId);
  if (!access || access.role === "viewer") {
    return Response.json({ error: "E79734: Not found or no access" }, { status: 404 });
  }
  const terminalAccess = await ensureTerminalAccess(env, terminalId, userId);
  if (!terminalAccess || terminalAccess.dashboardId !== dashboardId) {
    return Response.json({ error: "E79735: Terminal not found or does not belong to this dashboard" }, { status: 404 });
  }
  const existing = await env.DB.prepare(`
    SELECT id, active_policy_id
    FROM terminal_integrations
    WHERE terminal_id = ? AND dashboard_id = ? AND provider = ? AND deleted_at IS NULL
  `).bind(terminalId, dashboardId, provider).first();
  if (!existing) {
    return Response.json(
      { error: `${provider} is not attached to this terminal` },
      { status: 404 }
    );
  }
  if (provider === "browser") {
    const browserPolicy = policy;
    if (!browserPolicy?.urlFilter?.patterns?.length) {
      return Response.json(
        { error: "Browser policy requires at least one URL pattern" },
        { status: 400 }
      );
    }
  }
  const currentPolicy = await env.DB.prepare(`
    SELECT MAX(version) as max_version FROM integration_policies
    WHERE terminal_integration_id = ?
  `).bind(existing.id).first();
  const newVersion = (currentPolicy?.max_version ?? 0) + 1;
  const securityLevel = calculateSecurityLevel(provider, policy);
  const newPolicyId = generateId7("pol");
  const statements = [
    // Insert new policy revision
    env.DB.prepare(`
      INSERT INTO integration_policies
        (id, terminal_integration_id, version, policy, security_level, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(newPolicyId, existing.id, newVersion, JSON.stringify(policy), securityLevel, userId),
    // Update active_policy_id pointer
    env.DB.prepare(`
      UPDATE terminal_integrations
      SET active_policy_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(newPolicyId, existing.id)
  ];
  if (highRiskConfirmations?.length) {
    for (const capability of highRiskConfirmations) {
      const confirmId = generateId7("hrc");
      statements.push(
        env.DB.prepare(`
          INSERT INTO high_risk_confirmations
            (id, terminal_integration_id, capability, confirmed_by)
          VALUES (?, ?, ?, ?)
        `).bind(confirmId, existing.id, capability, userId)
      );
    }
  }
  await env.DB.batch(statements);
  return Response.json({
    activePolicyId: newPolicyId,
    policyVersion: newVersion,
    previousPolicyId: existing.active_policy_id,
    securityLevel
  });
}
async function detachIntegration(env, dashboardId, terminalId, provider, userId) {
  const access = await ensureDashboardAccess2(env, dashboardId, userId);
  if (!access || access.role === "viewer") {
    return Response.json({ error: "E79734: Not found or no access" }, { status: 404 });
  }
  const terminalAccess = await ensureTerminalAccess(env, terminalId, userId);
  if (!terminalAccess || terminalAccess.dashboardId !== dashboardId) {
    return Response.json({ error: "E79735: Terminal not found or does not belong to this dashboard" }, { status: 404 });
  }
  const existing = await env.DB.prepare(`
    SELECT id FROM terminal_integrations
    WHERE terminal_id = ? AND dashboard_id = ? AND provider = ? AND deleted_at IS NULL
  `).bind(terminalId, dashboardId, provider).first();
  if (!existing) {
    return Response.json(
      { error: `${provider} is not attached to this terminal` },
      { status: 404 }
    );
  }
  await env.DB.prepare(`
    UPDATE terminal_integrations
    SET deleted_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).bind(existing.id).run();
  return Response.json({
    detached: true,
    deletedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
}
async function getPolicyHistory(env, dashboardId, terminalId, provider, userId) {
  const access = await ensureDashboardAccess2(env, dashboardId, userId);
  if (!access) {
    return Response.json({ error: "E79734: Not found or no access" }, { status: 404 });
  }
  const terminalAccess = await ensureTerminalAccess(env, terminalId, userId);
  if (!terminalAccess || terminalAccess.dashboardId !== dashboardId) {
    return Response.json({ error: "E79735: Terminal not found or does not belong to this dashboard" }, { status: 404 });
  }
  const ti = await env.DB.prepare(`
    SELECT id FROM terminal_integrations
    WHERE terminal_id = ? AND dashboard_id = ? AND provider = ?
    ORDER BY created_at DESC LIMIT 1
  `).bind(terminalId, dashboardId, provider).first();
  if (!ti) {
    return Response.json(
      { error: `${provider} has never been attached to this terminal` },
      { status: 404 }
    );
  }
  const policies = await env.DB.prepare(`
    SELECT * FROM integration_policies
    WHERE terminal_integration_id = ?
    ORDER BY version DESC
  `).bind(ti.id).all();
  return Response.json({
    policies: policies.results.map((row) => formatIntegrationPolicy(row))
  });
}
async function getAuditLog(env, dashboardId, terminalId, provider, userId, limit = 100, offset = 0) {
  const access = await ensureDashboardAccess2(env, dashboardId, userId);
  if (!access) {
    return Response.json({ error: "E79734: Not found or no access" }, { status: 404 });
  }
  const terminalAccess = await ensureTerminalAccess(env, terminalId, userId);
  if (!terminalAccess || terminalAccess.dashboardId !== dashboardId) {
    return Response.json({ error: "E79735: Terminal not found or does not belong to this dashboard" }, { status: 404 });
  }
  const rows = await env.DB.prepare(`
    SELECT * FROM integration_audit_log
    WHERE dashboard_id = ? AND terminal_id = ? AND provider = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).bind(dashboardId, terminalId, provider, limit, offset).all();
  return Response.json({
    entries: rows.results.map((row) => ({
      id: row.id,
      action: row.action,
      resourceId: row.resource_id,
      policyVersion: row.policy_version,
      decision: row.policy_decision,
      denialReason: row.denial_reason,
      requestSummary: row.request_summary,
      createdAt: row.created_at
    }))
  });
}
async function getDashboardAuditLog(env, dashboardId, userId, limit = 100, offset = 0) {
  const access = await ensureDashboardAccess2(env, dashboardId, userId);
  if (!access) {
    return Response.json({ error: "E79734: Not found or no access" }, { status: 404 });
  }
  const rows = await env.DB.prepare(`
    SELECT * FROM integration_audit_log
    WHERE dashboard_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).bind(dashboardId, limit, offset).all();
  return Response.json({
    entries: rows.results.map((row) => ({
      id: row.id,
      terminalId: row.terminal_id,
      provider: row.provider,
      action: row.action,
      resourceId: row.resource_id,
      policyVersion: row.policy_version,
      decision: row.policy_decision,
      denialReason: row.denial_reason,
      requestSummary: row.request_summary,
      createdAt: row.created_at
    }))
  });
}
async function validateGatewayRequest(env, terminalId, provider, dashboardId, userId) {
  const ti = await env.DB.prepare(`
    SELECT id, active_policy_id, user_integration_id, dashboard_id, user_id
    FROM terminal_integrations
    WHERE terminal_id = ? AND provider = ? AND deleted_at IS NULL
  `).bind(terminalId, provider).first();
  if (!ti) {
    return Response.json(
      { error: "NOT_ATTACHED", reason: `${provider} not attached to terminal` },
      { status: 404 }
    );
  }
  if (ti.dashboard_id !== dashboardId || ti.user_id !== userId) {
    return Response.json(
      { error: "AUTH_DENIED", reason: "Terminal integration does not match token context" },
      { status: 403 }
    );
  }
  if (!ti.active_policy_id) {
    return Response.json(
      { error: "POLICY_DENIED", reason: "No policy configured for this integration" },
      { status: 403 }
    );
  }
  const policy = await env.DB.prepare(
    `SELECT * FROM integration_policies WHERE id = ?`
  ).bind(ti.active_policy_id).first();
  if (!policy) {
    return Response.json(
      { error: "POLICY_DENIED", reason: "Policy configuration error" },
      { status: 500 }
    );
  }
  if (policy.terminal_integration_id !== ti.id) {
    return Response.json(
      { error: "POLICY_DENIED", reason: "Policy configuration error" },
      { status: 500 }
    );
  }
  let accessToken = null;
  if (provider !== "browser" && ti.user_integration_id) {
    const userInt = await env.DB.prepare(`
      SELECT access_token, refresh_token, expires_at
      FROM user_integrations WHERE id = ?
    `).bind(ti.user_integration_id).first();
    if (!userInt) {
      return Response.json(
        { error: "AUTH_DENIED", reason: "OAuth connection not found" },
        { status: 403 }
      );
    }
    accessToken = userInt.access_token;
  }
  return Response.json({
    terminalIntegrationId: ti.id,
    policyId: policy.id,
    policyVersion: policy.version,
    policy: JSON.parse(policy.policy),
    securityLevel: policy.security_level,
    accessToken
  });
}
async function validateGatewayWithToken(env, ptyToken, provider, action, context) {
  const claims = await verifyPtyToken(ptyToken, env.INTERNAL_API_TOKEN);
  if (!claims) {
    return Response.json(
      { error: "AUTH_DENIED", reason: "Invalid or expired PTY token" },
      { status: 401 }
    );
  }
  const terminalId = claims.terminal_id;
  const dashboardId = claims.dashboard_id;
  const userId = claims.user_id;
  const ti = await env.DB.prepare(`
    SELECT id, active_policy_id, user_integration_id, dashboard_id, user_id
    FROM terminal_integrations
    WHERE terminal_id = ? AND provider = ? AND deleted_at IS NULL
  `).bind(terminalId, provider).first();
  if (!ti) {
    return Response.json(
      { error: "NOT_ATTACHED", reason: `${provider} not attached to terminal` },
      { status: 404 }
    );
  }
  if (ti.dashboard_id !== dashboardId || ti.user_id !== userId) {
    return Response.json(
      { error: "AUTH_DENIED", reason: "Terminal integration does not match token context" },
      { status: 403 }
    );
  }
  if (!ti.active_policy_id) {
    return Response.json(
      { error: "POLICY_DENIED", reason: "No policy configured for this integration" },
      { status: 403 }
    );
  }
  const policyRow = await env.DB.prepare(
    `SELECT * FROM integration_policies WHERE id = ?`
  ).bind(ti.active_policy_id).first();
  if (!policyRow) {
    return Response.json(
      { error: "POLICY_DENIED", reason: "Policy configuration error" },
      { status: 500 }
    );
  }
  if (policyRow.terminal_integration_id !== ti.id) {
    return Response.json(
      { error: "POLICY_DENIED", reason: "Policy configuration error" },
      { status: 500 }
    );
  }
  const policy = JSON.parse(policyRow.policy);
  if (action) {
    const rateLimitResult = await checkRateLimit(env, ti.id, provider, action, policy);
    if (!rateLimitResult.allowed) {
      await logAuditEntryInternal(env, {
        terminalIntegrationId: ti.id,
        terminalId,
        dashboardId,
        userId,
        provider,
        action,
        resourceId: context?.resourceId,
        policyId: policyRow.id,
        policyVersion: policyRow.version,
        decision: "denied",
        denialReason: rateLimitResult.reason
      });
      return Response.json(
        { error: "RATE_LIMITED", reason: rateLimitResult.reason },
        { status: 429 }
      );
    }
  }
  if (action) {
    const enforcement = await enforcePolicy(env, provider, action, policy, ti.id, context);
    await logAuditEntryInternal(env, {
      terminalIntegrationId: ti.id,
      terminalId,
      dashboardId,
      userId,
      provider,
      action,
      resourceId: context?.resourceId,
      policyId: policyRow.id,
      policyVersion: policyRow.version,
      decision: enforcement.decision,
      denialReason: enforcement.reason
    });
    if (!enforcement.allowed) {
      return Response.json(
        {
          error: enforcement.decision === "filtered" ? "FILTERED" : "POLICY_DENIED",
          reason: enforcement.reason,
          decision: enforcement.decision
        },
        { status: 403 }
      );
    }
  }
  let accessToken = null;
  if (provider !== "browser" && ti.user_integration_id) {
    const userInt = await env.DB.prepare(`
      SELECT access_token, refresh_token, expires_at
      FROM user_integrations WHERE id = ?
    `).bind(ti.user_integration_id).first();
    if (!userInt) {
      return Response.json(
        { error: "AUTH_DENIED", reason: "OAuth connection not found" },
        { status: 403 }
      );
    }
    accessToken = userInt.access_token;
  }
  return Response.json({
    terminalIntegrationId: ti.id,
    policyId: policyRow.id,
    policyVersion: policyRow.version,
    policy,
    securityLevel: policyRow.security_level,
    accessToken
  });
}
async function logAuditEntryInternal(env, data) {
  const id = generateId7("aud");
  await env.DB.prepare(`
    INSERT INTO integration_audit_log
      (id, terminal_integration_id, terminal_id, dashboard_id, user_id, provider,
       action, resource_id, policy_id, policy_version, policy_decision, denial_reason, request_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    data.terminalIntegrationId,
    data.terminalId,
    data.dashboardId,
    data.userId,
    data.provider,
    data.action,
    data.resourceId ?? null,
    data.policyId,
    data.policyVersion,
    data.decision,
    data.denialReason ?? null,
    data.requestSummary ?? null
  ).run();
}
async function logAuditEntry(env, data) {
  await logAuditEntryInternal(env, data);
  return Response.json({ logged: true });
}
var ACTION_TO_CAPABILITY;
var init_handler3 = __esm({
  "src/integration-policies/handler.ts"() {
    "use strict";
    init_types();
    init_pty_token();
    console.log(`[integration-handler] REVISION: handler-v12-dashboard-integration-labels loaded at ${(/* @__PURE__ */ new Date()).toISOString()}`);
    __name(globToRegex, "globToRegex");
    __name(generateId7, "generateId");
    __name(getActionCategory, "getActionCategory");
    __name(checkRateLimit, "checkRateLimit");
    __name(calculateSecurityLevel, "calculateSecurityLevel");
    __name(createDefaultFullAccessPolicy, "createDefaultFullAccessPolicy");
    ACTION_TO_CAPABILITY = {
      gmail: {
        "gmail.read": "canRead",
        "gmail.search": "canRead",
        "gmail.get": "canRead",
        "gmail.list": "canRead",
        "gmail.archive": "canArchive",
        "gmail.trash": "canTrash",
        "gmail.markRead": "canMarkRead",
        "gmail.mark_read": "canMarkRead",
        "gmail.markUnread": "canMarkRead",
        "gmail.mark_unread": "canMarkRead",
        "gmail.label": "canLabel",
        "gmail.add_label": "canLabel",
        "gmail.removeLabel": "canLabel",
        "gmail.remove_label": "canLabel",
        "gmail.send": "canSend",
        "gmail.draft": "canSend",
        "gmail.reply": "canSend"
      },
      google_calendar: {
        "calendar.read": "canRead",
        "calendar.list": "canRead",
        "calendar.get": "canRead",
        "calendar.create": "canCreate",
        "calendar.update": "canUpdate",
        "calendar.delete": "canDelete",
        "calendar.list_calendars": "canRead",
        "calendar.list_events": "canRead",
        "calendar.get_event": "canRead",
        "calendar.search_events": "canRead",
        "calendar.create_event": "canCreate",
        "calendar.update_event": "canUpdate",
        "calendar.delete_event": "canDelete"
      },
      google_contacts: {
        "contacts.read": "canRead",
        "contacts.list": "canRead",
        "contacts.get": "canRead",
        "contacts.create": "canCreate",
        "contacts.update": "canUpdate",
        "contacts.delete": "canDelete"
      },
      google_sheets: {
        "sheets.read": "canRead",
        "sheets.get": "canRead",
        "sheets.list": "canRead",
        "sheets.write": "canWrite",
        "sheets.update": "canWrite",
        "sheets.append": "canWrite",
        "sheets.create": "canWrite"
      },
      google_forms: {
        "forms.read": "canRead",
        "forms.get": "canRead",
        "forms.list": "canRead",
        "forms.readResponses": "canReadResponses",
        "forms.create": "canCreate",
        "forms.update": "canUpdate",
        "forms.delete": "canDelete"
      },
      google_drive: {
        "drive.read": "canRead",
        "drive.list": "canRead",
        "drive.get": "canRead",
        "drive.download": "canDownload",
        "drive.upload": "canUpload",
        "drive.create": "canCreate",
        "drive.update": "canUpdate",
        "drive.delete": "canDelete",
        "drive.move": "canMove",
        "drive.share": "canShare",
        "drive.sync_list": "canRead",
        "drive.changes_start_token": "canRead",
        "drive.changes_list": "canRead",
        "drive.sync_config": "canRead"
      },
      onedrive: {
        "onedrive.read": "canRead",
        "onedrive.list": "canRead",
        "onedrive.get": "canRead",
        "onedrive.download": "canDownload",
        "onedrive.upload": "canUpload",
        "onedrive.create": "canCreate",
        "onedrive.update": "canUpdate",
        "onedrive.delete": "canDelete",
        "onedrive.move": "canMove",
        "onedrive.share": "canShare"
      },
      box: {
        "box.read": "canRead",
        "box.list": "canRead",
        "box.get": "canRead",
        "box.download": "canDownload",
        "box.upload": "canUpload",
        "box.create": "canCreate",
        "box.update": "canUpdate",
        "box.delete": "canDelete",
        "box.move": "canMove",
        "box.share": "canShare"
      },
      github: {
        "github.readRepos": "canReadRepos",
        "github.listRepos": "canReadRepos",
        "github.list_repos": "canReadRepos",
        "github.get_repo": "canReadRepos",
        "github.readCode": "canReadCode",
        "github.getFile": "canReadCode",
        "github.get_file": "canReadCode",
        "github.list_files": "canReadCode",
        "github.search_code": "canReadCode",
        "github.clone": "canClone",
        "github.push": "canPush",
        "github.commit": "canPush",
        "github.readIssues": "canReadIssues",
        "github.listIssues": "canReadIssues",
        "github.list_issues": "canReadIssues",
        "github.createIssue": "canCreateIssues",
        "github.create_issue": "canCreateIssues",
        "github.commentIssue": "canCommentIssues",
        "github.closeIssue": "canCloseIssues",
        "github.readPRs": "canReadPRs",
        "github.listPRs": "canReadPRs",
        "github.list_prs": "canReadPRs",
        "github.createPR": "canCreatePRs",
        "github.create_pr": "canCreatePRs",
        "github.approvePR": "canApprovePRs",
        "github.mergePR": "canMergePRs",
        "github.createRelease": "canCreateReleases",
        "github.triggerAction": "canTriggerActions",
        "github.createRepo": "canCreateRepos",
        "github.deleteRepo": "canDeleteRepos",
        "github.manageSettings": "canManageSettings"
      },
      browser: {
        "browser.lifecycle": "canNavigate",
        // start/stop/status - no URL needed
        "browser.navigate": "canNavigate",
        "browser.click": "canClick",
        "browser.type": "canType",
        "browser.scroll": "canScroll",
        "browser.screenshot": "canScreenshot",
        "browser.extractText": "canExtractText",
        "browser.fillForm": "canFillForms",
        "browser.submitForm": "canSubmitForms",
        "browser.download": "canDownload",
        "browser.upload": "canUpload",
        "browser.executeJs": "canExecuteJs",
        "browser.useCredentials": "canUseStoredCredentials",
        "browser.inputCredentials": "canInputCredentials",
        "browser.readCookies": "canReadCookies",
        "browser.inspectNetwork": "canInspectNetwork",
        "browser.modifyRequests": "canModifyRequests"
      },
      // Messaging providers
      slack: {
        "slack.list_channels": "canReceive",
        // Non-channel-targeted: lists all channels
        "slack.read_messages": "canReadHistory",
        // Channel-targeted: reads specific channel
        "slack.send_message": "canSend",
        "slack.reply_thread": "canSend",
        "slack.react": "canReact",
        "slack.search": "canReceive",
        // Non-channel-targeted: global search
        "slack.get_user_info": "canReceive",
        // Non-channel-targeted: user lookup
        "slack.edit_message": "canEditMessages",
        "slack.delete_message": "canDeleteMessages"
      },
      discord: {
        "discord.list_channels": "canReceive",
        // Non-channel-targeted
        "discord.read_messages": "canReadHistory",
        "discord.send_message": "canSend",
        "discord.reply": "canSend",
        "discord.react": "canReact",
        "discord.edit_message": "canEditMessages",
        "discord.delete_message": "canDeleteMessages"
      },
      telegram: {
        "telegram.send_message": "canSend",
        "telegram.reply": "canSend",
        "telegram.edit_message": "canEditMessages",
        "telegram.delete_message": "canDeleteMessages",
        "telegram.get_chat_info": "canReceive"
        // Non-channel-targeted
      },
      whatsapp: {
        "whatsapp.send_message": "canSend",
        "whatsapp.reply": "canSend",
        "whatsapp.read_messages": "canReadHistory"
      },
      teams: {
        "teams.list_channels": "canReceive",
        // Non-channel-targeted
        "teams.read_messages": "canReadHistory",
        "teams.send_message": "canSend",
        "teams.reply": "canSend"
      },
      matrix: {
        "matrix.list_rooms": "canReceive",
        // Non-channel-targeted
        "matrix.read_messages": "canReadHistory",
        "matrix.send_message": "canSend",
        "matrix.reply": "canSend"
      },
      google_chat: {
        "google_chat.list_spaces": "canReceive",
        // Non-channel-targeted
        "google_chat.read_messages": "canReadHistory",
        "google_chat.send_message": "canSend",
        "google_chat.reply": "canSend"
      }
    };
    __name(enforcePolicy, "enforcePolicy");
    __name(formatTerminalIntegration, "formatTerminalIntegration");
    __name(formatIntegrationPolicy, "formatIntegrationPolicy");
    __name(ensureDashboardAccess2, "ensureDashboardAccess");
    __name(ensureTerminalAccess, "ensureTerminalAccess");
    __name(listAvailableIntegrations, "listAvailableIntegrations");
    __name(listTerminalIntegrations, "listTerminalIntegrations");
    __name(listDashboardIntegrationLabels, "listDashboardIntegrationLabels");
    __name(attachIntegration, "attachIntegration");
    __name(updateIntegrationPolicy, "updateIntegrationPolicy");
    __name(detachIntegration, "detachIntegration");
    __name(getPolicyHistory, "getPolicyHistory");
    __name(getAuditLog, "getAuditLog");
    __name(getDashboardAuditLog, "getDashboardAuditLog");
    __name(validateGatewayRequest, "validateGatewayRequest");
    __name(validateGatewayWithToken, "validateGatewayWithToken");
    __name(logAuditEntryInternal, "logAuditEntryInternal");
    __name(logAuditEntry, "logAuditEntry");
  }
});

// src/messaging/webhook-handler.ts
var webhook_handler_exports = {};
__export(webhook_handler_exports, {
  SubscriptionError: () => SubscriptionError,
  channelMatchesFilter: () => channelMatchesFilter,
  createSubscription: () => createSubscription,
  deleteSubscription: () => deleteSubscription,
  handleInboundWebhook: () => handleInboundWebhook,
  listSubscriptions: () => listSubscriptions
});
async function verifySlackSignature(request, signingSecret) {
  const signature = request.headers.get("X-Slack-Signature");
  const timestamp = request.headers.get("X-Slack-Request-Timestamp");
  if (!signature || !timestamp)
    return false;
  const now = Math.floor(Date.now() / 1e3);
  const parsedTimestamp = parseInt(timestamp, 10);
  if (!Number.isFinite(parsedTimestamp))
    return false;
  if (Math.abs(now - parsedTimestamp) > 300)
    return false;
  const body = await request.clone().text();
  const basestring = `v0:${timestamp}:${body}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(basestring));
  const computed = `v0=${Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  if (computed.length !== signature.length)
    return false;
  let mismatch = 0;
  for (let i = 0; i < computed.length; i++) {
    mismatch |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}
async function verifyDiscordSignature(request, publicKey) {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp)
    return false;
  const body = await request.clone().text();
  const message = new TextEncoder().encode(timestamp + body);
  try {
    const keyData = new Uint8Array(publicKey.match(/.{2}/g).map((byte) => parseInt(byte, 16)));
    const key = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    const sigData = new Uint8Array(signature.match(/.{2}/g).map((byte) => parseInt(byte, 16)));
    return await crypto.subtle.verify("Ed25519", key, sigData, message);
  } catch {
    return false;
  }
}
function verifyTelegramSecret(request, webhookSecret) {
  const headerToken = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!headerToken || !webhookSecret)
    return false;
  if (headerToken.length !== webhookSecret.length)
    return false;
  let mismatch = 0;
  for (let i = 0; i < headerToken.length; i++) {
    mismatch |= headerToken.charCodeAt(i) ^ webhookSecret.charCodeAt(i);
  }
  return mismatch === 0;
}
function parseSlackEvent(body) {
  const event = body.event;
  if (!event || event.type !== "message")
    return null;
  const subtype = event.subtype;
  if (event.bot_id || subtype === "bot_message")
    return null;
  const ACCEPTED_SUBTYPES = /* @__PURE__ */ new Set([
    void 0,
    "file_share",
    "thread_broadcast",
    "message_changed"
  ]);
  if (!ACCEPTED_SUBTYPES.has(subtype))
    return null;
  let text;
  let user;
  let messageId;
  if (subtype === "message_changed") {
    const inner = event.message;
    if (!inner)
      return null;
    if (inner.bot_id)
      return null;
    text = inner.text || "";
    user = inner.user || "";
    const originalTs = inner.ts || "";
    const editEventTs = event.ts || "";
    messageId = `${originalTs}:edit:${editEventTs}`;
  } else {
    text = event.text || "";
    user = event.user || "";
    messageId = event.client_msg_id || event.ts || "";
  }
  if (!text.trim())
    return null;
  return {
    platformMessageId: messageId,
    senderId: user,
    senderName: user || "unknown",
    channelId: event.channel || "",
    channelName: event.channel || "",
    text,
    metadata: {
      // For message_changed, thread_ts is on the inner event.message, not the outer event
      thread_ts: subtype === "message_changed" ? event.message?.thread_ts ?? event.thread_ts : event.thread_ts,
      ts: event.ts,
      team: body.team_id || "",
      subtype: subtype || void 0,
      is_edit: subtype === "message_changed"
    }
  };
}
function parseDiscordEvent(body) {
  if (typeof body.t === "string" && body.t === "MESSAGE_CREATE" && body.d) {
    const data = body.d;
    const author = data.author;
    if (author?.bot)
      return null;
    const content = (data.content || "").trim();
    if (!content)
      return null;
    return {
      platformMessageId: data.id || "",
      senderId: author?.id || "",
      senderName: author?.username || "unknown",
      channelId: data.channel_id || "",
      channelName: data.channel_id || "",
      text: content,
      metadata: {
        guild_id: data.guild_id,
        message_reference: data.message_reference
      }
    };
  }
  if (body.type === 2) {
    const interactionData = body.data;
    const resolved = interactionData?.resolved;
    const messages = resolved?.messages;
    if (messages) {
      const firstMessageId = Object.keys(messages)[0];
      if (firstMessageId) {
        const msg = messages[firstMessageId];
        const author = msg.author;
        if (author?.bot)
          return null;
        const resolvedContent = (msg.content || "").trim();
        if (!resolvedContent)
          return null;
        return {
          platformMessageId: msg.id || firstMessageId,
          senderId: author?.id || "",
          senderName: author?.username || "unknown",
          channelId: body.channel_id || msg.channel_id || "",
          channelName: body.channel_id || msg.channel_id || "",
          text: resolvedContent,
          metadata: {
            guild_id: body.guild_id,
            interaction_type: "application_command",
            command_name: interactionData?.name
          }
        };
      }
    }
  }
  return null;
}
function parseTelegramUpdate(body) {
  const message = body.message;
  if (!message)
    return null;
  const from = message.from;
  if (from?.is_bot)
    return null;
  const chat = message.chat;
  const text = (message.text || message.caption || "").trim();
  if (!text)
    return null;
  return {
    platformMessageId: String(message.message_id || ""),
    senderId: String(from?.id || ""),
    senderName: from?.username || from?.first_name || "unknown",
    channelId: String(chat?.id || ""),
    channelName: chat?.title || chat?.username || String(chat?.id || ""),
    text,
    metadata: {
      chat_type: chat?.type,
      reply_to_message_id: message.reply_to_message?.message_id,
      update_id: body.update_id
    }
  };
}
async function resolveChannelName(env, provider, channelId, userId) {
  if (!channelId)
    return null;
  try {
    if (provider === "slack") {
      const integration = await env.DB.prepare(
        `SELECT access_token FROM user_integrations WHERE user_id = ? AND provider = 'slack'`
      ).bind(userId).first();
      if (!integration?.access_token)
        return null;
      const response = await fetch("https://slack.com/api/conversations.info", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${integration.access_token}`,
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({ channel: channelId })
      });
      if (!response.ok)
        return null;
      const data = await response.json();
      return data.ok ? data.channel?.name || null : null;
    }
    if (provider === "discord") {
      return null;
    }
  } catch (err) {
    console.error(`[webhook] Failed to resolve channel name for ${provider}/${channelId}:`, err);
  }
  return null;
}
async function resolveSlackSenderName(env, senderId, userId) {
  if (!senderId)
    return null;
  try {
    const integration = await env.DB.prepare(
      `SELECT access_token FROM user_integrations WHERE user_id = ? AND provider = 'slack'`
    ).bind(userId).first();
    if (!integration?.access_token)
      return null;
    const response = await fetch("https://slack.com/api/users.info", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${integration.access_token}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({ user: senderId })
    });
    if (!response.ok)
      return null;
    const data = await response.json();
    if (!data.ok || !data.user)
      return null;
    return data.user.profile?.display_name || data.user.real_name || data.user.name || null;
  } catch (err) {
    console.error(`[webhook] Failed to resolve Slack sender name for ${senderId}:`, err);
    return null;
  }
}
function normalizeChannelName(name) {
  return name.replace(/^#/, "").toLowerCase();
}
function channelMatchesFilter(channelId, channelName, filterChannelIds, filterChannelNames) {
  if (filterChannelIds?.includes(channelId))
    return true;
  const normalizedName = normalizeChannelName(channelName);
  if (filterChannelNames?.some((n) => normalizeChannelName(n) === normalizedName))
    return true;
  if (filterChannelNames?.some((n) => normalizeChannelName(n) === channelId.toLowerCase()))
    return true;
  if (channelName && filterChannelIds?.includes(channelName))
    return true;
  return false;
}
async function handleInboundWebhook(request, env, provider, hookId, ctx) {
  let signatureValid = false;
  if (provider === "telegram") {
    if (!hookId) {
      return Response.json({ error: "Telegram webhooks require a hookId" }, { status: 400 });
    }
    const sub = await env.DB.prepare(`
      SELECT webhook_secret FROM messaging_subscriptions
      WHERE webhook_id = ? AND provider = 'telegram'
      LIMIT 1
    `).bind(hookId).first();
    if (!sub)
      return Response.json({ ok: true });
    signatureValid = verifyTelegramSecret(request, sub.webhook_secret);
  } else {
    switch (provider) {
      case "slack": {
        const signingSecret = env.SLACK_SIGNING_SECRET;
        if (!signingSecret) {
          console.error("[webhook] SLACK_SIGNING_SECRET not configured");
          return Response.json({ error: "Server configuration error" }, { status: 500 });
        }
        signatureValid = await verifySlackSignature(request, signingSecret);
        break;
      }
      case "discord": {
        const publicKey = env.DISCORD_PUBLIC_KEY;
        if (!publicKey) {
          console.error("[webhook] DISCORD_PUBLIC_KEY not configured");
          return Response.json({ error: "Server configuration error" }, { status: 500 });
        }
        signatureValid = await verifyDiscordSignature(request, publicKey);
        break;
      }
      default:
        console.error(`[webhook] No verification for provider: ${provider}`);
        return Response.json({ error: "Unsupported provider" }, { status: 400 });
    }
  }
  if (!signatureValid) {
    console.error(`[webhook] Signature verification failed for ${provider}/${hookId ?? "global"}`);
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }
  let body;
  try {
    body = await request.clone().json();
  } catch {
    console.error(`[webhook] Non-JSON or malformed payload from ${provider}/${hookId ?? "global"}`);
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }
  if (provider === "slack" && body.type === "url_verification") {
    return Response.json({ challenge: body.challenge });
  }
  if (provider === "discord" && body.type === 1) {
    return Response.json({ type: 1 });
  }
  let message = null;
  switch (provider) {
    case "slack":
      message = parseSlackEvent(body);
      break;
    case "discord":
      message = parseDiscordEvent(body);
      break;
    case "telegram":
      message = parseTelegramUpdate(body);
      break;
  }
  if (!message) {
    return Response.json({ ok: true });
  }
  let subscriptions;
  if (provider === "telegram") {
    const sub = await env.DB.prepare(`
      SELECT * FROM messaging_subscriptions
      WHERE webhook_id = ? AND provider = 'telegram'
      LIMIT 1
    `).bind(hookId).first();
    subscriptions = sub ? [sub] : [];
  } else {
    const channelId = message.channelId;
    if (!channelId) {
      return Response.json({ ok: true });
    }
    if (provider === "slack") {
      const teamId = body.team_id;
      if (!teamId) {
        console.error("[webhook] Slack event missing team_id \u2014 cannot route safely");
        return Response.json({ ok: true });
      }
      const results = await env.DB.prepare(`
        SELECT * FROM messaging_subscriptions
        WHERE provider = 'slack' AND team_id = ? AND channel_id = ? AND status = 'active'
      `).bind(teamId, channelId).all();
      subscriptions = results.results || [];
    } else {
      const results = await env.DB.prepare(`
        SELECT * FROM messaging_subscriptions
        WHERE provider = ? AND channel_id = ? AND status = 'active'
      `).bind(provider, channelId).all();
      subscriptions = results.results || [];
    }
  }
  if (!subscriptions.length) {
    return Response.json({ ok: true });
  }
  subscriptions = subscriptions.filter((s) => s.status === "active");
  if (!subscriptions.length) {
    return Response.json({ ok: true });
  }
  for (const subscription of subscriptions) {
    const msgClone = {
      ...message,
      metadata: { ...message.metadata }
    };
    ctx.waitUntil(processSubscriptionMessage(env, provider, subscription, msgClone, body, ctx));
  }
  return Response.json({ ok: true });
}
async function processSubscriptionMessage(env, provider, subscription, message, body, ctx) {
  const hookId = subscription.webhook_id || "global";
  const RESOLVE_TIMEOUT_MS = 1500;
  if ((provider === "slack" || provider === "discord") && message.channelId) {
    const resolvePromises = [];
    resolvePromises.push(
      resolveChannelName(env, provider, message.channelId, subscription.user_id).then((name) => {
        if (name)
          message.channelName = name;
      }).catch(() => {
      })
    );
    if (provider === "slack" && message.senderId) {
      resolvePromises.push(
        resolveSlackSenderName(env, message.senderId, subscription.user_id).then((name) => {
          if (name)
            message.senderName = name;
        }).catch(() => {
        })
      );
    }
    await Promise.race([
      Promise.allSettled(resolvePromises),
      new Promise((resolve) => setTimeout(resolve, RESOLVE_TIMEOUT_MS))
    ]);
  }
  const subChannelId = subscription.channel_id;
  const subChatId = subscription.chat_id;
  const subChannelName = subscription.channel_name;
  if (subChannelId || subChatId || subChannelName) {
    const incomingChannel = message.channelId || "";
    const incomingName = normalizeChannelName(message.channelName || "");
    let scopeMatch = false;
    if (subChannelId) {
      scopeMatch = incomingChannel === subChannelId;
    } else if (subChatId) {
      scopeMatch = incomingChannel === subChatId;
    } else if (subChannelName) {
      scopeMatch = incomingName === normalizeChannelName(subChannelName);
    }
    if (!scopeMatch)
      return;
  }
  const terminalPolicies = await env.DB.prepare(`
    SELECT ip.policy
    FROM dashboard_edges de
    JOIN dashboard_items di ON di.id = de.target_item_id AND di.type = 'terminal'
    JOIN terminal_integrations ti ON ti.item_id = de.target_item_id AND ti.provider = ? AND ti.deleted_at IS NULL
    JOIN integration_policies ip ON ip.id = ti.active_policy_id
    WHERE de.source_item_id = ?
  `).bind(provider, subscription.item_id).all();
  const policies = (terminalPolicies.results || []).map((row) => {
    try {
      return JSON.parse(row.policy);
    } catch {
      return null;
    }
  }).filter((p) => p !== null);
  if (policies.length > 0) {
    const allowedByAnyPolicy = policies.some((policy) => {
      if (!policy.canReceive)
        return false;
      if (policy.channelFilter) {
        if (policy.channelFilter.mode === "allowlist") {
          const { channelIds, channelNames } = policy.channelFilter;
          const hasFilter = channelIds?.length || channelNames?.length;
          if (!hasFilter)
            return false;
          if (!channelMatchesFilter(message.channelId, message.channelName, channelIds, channelNames)) {
            return false;
          }
        }
      }
      if (policy.senderFilter && policy.senderFilter.mode !== "all") {
        const { mode, userIds, userNames } = policy.senderFilter;
        const senderIdMatch = userIds?.includes(message.senderId);
        const senderNameMatch = userNames?.some(
          (n) => n.toLowerCase() === message.senderName.toLowerCase()
        );
        if (mode === "allowlist" && !senderIdMatch && !senderNameMatch)
          return false;
        if (mode === "blocklist" && (senderIdMatch || senderNameMatch))
          return false;
      }
      return true;
    });
    if (!allowedByAnyPolicy) {
      console.log(`[webhook] Inbound denied for subscription ${subscription.id}: no policy allows message from ${message.senderId} in ${message.channelId}`);
      return;
    }
  } else {
    console.log(`[webhook] Inbound denied (fail-closed): no terminal policies for subscription ${subscription.id} \u2014 message dropped`);
    return;
  }
  const messageId = crypto.randomUUID();
  const expiresDate = new Date(Date.now() + 24 * 60 * 60 * 1e3);
  const expiresAt = expiresDate.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  try {
    await env.DB.prepare(`
      INSERT INTO inbound_messages (
        id, subscription_id, dashboard_id, provider,
        platform_message_id, sender_id, sender_name,
        channel_id, channel_name, message_text, message_metadata,
        status, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'buffered', ?)
    `).bind(
      messageId,
      subscription.id,
      subscription.dashboard_id,
      provider,
      message.platformMessageId,
      message.senderId,
      message.senderName,
      message.channelId,
      message.channelName,
      message.text,
      JSON.stringify(message.metadata),
      expiresAt
    ).run();
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE")) {
      return;
    }
    throw err;
  }
  await env.DB.prepare(`
    UPDATE messaging_subscriptions SET last_message_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).bind(subscription.id).run();
  const dashboardId = subscription.dashboard_id;
  const messagingItemId = subscription.item_id;
  const userId = subscription.user_id;
  await deliverOrWakeAndDrain(env, dashboardId, messagingItemId, userId, provider).catch((err) => {
    console.error(`[webhook] Background delivery failed for dashboard ${dashboardId}:`, err);
  });
}
async function createSubscription(env, dashboardId, itemId, userId, provider, data, webhookBaseUrl) {
  const item = await env.DB.prepare(
    "SELECT type FROM dashboard_items WHERE id = ? AND dashboard_id = ?"
  ).bind(itemId, dashboardId).first();
  if (!item) {
    throw new Error(`Item ${itemId} not found in dashboard ${dashboardId}`);
  }
  if (item.type !== provider) {
    throw new Error(`Item type '${item.type}' does not match provider '${provider}'`);
  }
  if ((provider === "slack" || provider === "discord") && !data.channelId) {
    throw new Error(`channelId is required for ${provider} subscriptions`);
  }
  if (provider === "telegram" && !data.chatId) {
    throw new Error("chatId is required for telegram subscriptions");
  }
  let resolvedTeamId = data.teamId || null;
  if (provider === "slack" && !resolvedTeamId) {
    const integration = await env.DB.prepare(
      `SELECT access_token, metadata FROM user_integrations WHERE user_id = ? AND provider = 'slack'`
    ).bind(userId).first();
    if (integration?.metadata) {
      try {
        const meta = JSON.parse(integration.metadata);
        resolvedTeamId = meta.team_id || null;
      } catch {
      }
    }
    if (!resolvedTeamId && integration?.access_token) {
      try {
        const resp = await fetch("https://slack.com/api/auth.test", {
          headers: { Authorization: `Bearer ${integration.access_token}` }
        });
        if (resp.ok) {
          const authResult = await resp.json();
          if (authResult.ok && authResult.team_id) {
            resolvedTeamId = authResult.team_id;
            const existingMeta = integration.metadata ? JSON.parse(integration.metadata) : {};
            existingMeta.team_id = authResult.team_id;
            if (authResult.team)
              existingMeta.team_name = authResult.team;
            await env.DB.prepare(
              `UPDATE user_integrations SET metadata = ?, updated_at = datetime('now') WHERE user_id = ? AND provider = 'slack'`
            ).bind(JSON.stringify(existingMeta), userId).run();
            console.log(`[messaging] Backfilled team_id=${authResult.team_id} for legacy Slack integration (user=${userId})`);
          }
        }
      } catch (err) {
        console.error("[messaging] auth.test fallback failed:", err);
      }
    }
    if (!resolvedTeamId) {
      throw new SubscriptionError(
        "SLACK_RECONNECT_REQUIRED",
        "Slack team could not be identified. Please disconnect and reconnect Slack to continue."
      );
    }
  }
  const scopeKey = data.channelId || data.chatId || null;
  const existing = scopeKey ? await env.DB.prepare(`
    SELECT id, webhook_id, channel_id, channel_name, chat_id, team_id FROM messaging_subscriptions
    WHERE dashboard_id = ? AND item_id = ? AND provider = ?
      AND COALESCE(channel_id, chat_id) = ?
      AND status IN ('pending', 'active')
    LIMIT 1
  `).bind(dashboardId, itemId, provider, scopeKey).first() : null;
  if (existing) {
    const metadataChanged = (data.channelName ?? null) !== existing.channel_name || resolvedTeamId !== existing.team_id;
    if (metadataChanged) {
      await env.DB.prepare(`
        UPDATE messaging_subscriptions
        SET channel_name = ?, team_id = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(
        data.channelName ?? existing.channel_name,
        resolvedTeamId ?? existing.team_id,
        existing.id
      ).run();
      console.log(`[messaging] Reconciled subscription ${existing.id} metadata: name=${data.channelName ?? "unchanged"}, team=${resolvedTeamId ?? "unchanged"}`);
    }
    return { id: existing.id, webhookId: existing.webhook_id };
  }
  if (provider === "telegram") {
    const existingTelegram = await env.DB.prepare(`
      SELECT id, dashboard_id, item_id FROM messaging_subscriptions
      WHERE user_id = ? AND provider = 'telegram' AND status IN ('pending', 'active')
      LIMIT 1
    `).bind(userId).first();
    if (existingTelegram) {
      throw new Error(
        `Only one active Telegram subscription per bot is allowed. Existing subscription ${existingTelegram.id} on dashboard ${existingTelegram.dashboard_id}. Delete it first to create a new one.`
      );
    }
  }
  const id = crypto.randomUUID();
  const webhookId = crypto.randomUUID();
  const webhookSecret = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO messaging_subscriptions (
      id, dashboard_id, item_id, user_id, provider,
      channel_id, channel_name, chat_id, team_id,
      webhook_id, webhook_secret, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).bind(
    id,
    dashboardId,
    itemId,
    userId,
    provider,
    data.channelId || null,
    data.channelName || null,
    data.chatId || null,
    resolvedTeamId,
    webhookId,
    webhookSecret
  ).run();
  if (provider === "telegram") {
    try {
      await registerTelegramWebhook(env, userId, webhookBaseUrl, webhookId, webhookSecret);
    } catch (err) {
      await env.DB.prepare(`
        UPDATE messaging_subscriptions SET status = 'error', error_message = ? WHERE id = ?
      `).bind(
        err instanceof Error ? err.message : "Failed to register webhook with Telegram",
        id
      ).run();
      throw err;
    }
  }
  return { id, webhookId };
}
async function registerTelegramWebhook(env, userId, webhookBaseUrl, webhookId, webhookSecret) {
  const integration = await env.DB.prepare(
    `SELECT access_token FROM user_integrations WHERE user_id = ? AND provider = 'telegram'`
  ).bind(userId).first();
  if (!integration?.access_token) {
    throw new Error("Telegram bot token not found \u2014 connect Telegram first");
  }
  const callbackUrl = `${webhookBaseUrl.replace(/\/$/, "")}/webhooks/telegram/${webhookId}`;
  const response = await fetch(
    `https://api.telegram.org/bot${integration.access_token}/setWebhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: callbackUrl,
        secret_token: webhookSecret,
        allowed_updates: ["message"]
      })
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram setWebhook failed: ${response.status} \u2014 ${text}`);
  }
  const result = await response.json();
  if (!result.ok) {
    throw new Error(`Telegram setWebhook error: ${result.description || "unknown"}`);
  }
  console.log(`[subscription] Registered Telegram webhook for user ${userId}: ${callbackUrl}`);
}
async function listSubscriptions(env, dashboardId) {
  const result = await env.DB.prepare(`
    SELECT id, dashboard_id, item_id, provider,
           channel_id, channel_name, chat_id,
           status, last_message_at, error_message,
           created_at, updated_at
    FROM messaging_subscriptions
    WHERE dashboard_id = ? AND status != 'error'
    ORDER BY created_at DESC
  `).bind(dashboardId).all();
  return result.results || [];
}
async function deleteSubscription(env, subscriptionId, userId) {
  const sub = await env.DB.prepare(`
    SELECT provider FROM messaging_subscriptions
    WHERE id = ? AND user_id = ?
  `).bind(subscriptionId, userId).first();
  await env.DB.prepare(`
    DELETE FROM messaging_subscriptions
    WHERE id = ? AND user_id = ?
  `).bind(subscriptionId, userId).run();
  if (sub?.provider === "telegram") {
    const remaining = await env.DB.prepare(`
      SELECT COUNT(*) as cnt FROM messaging_subscriptions
      WHERE user_id = ? AND provider = 'telegram' AND status IN ('pending', 'active')
    `).bind(userId).first();
    if (!remaining?.cnt) {
      try {
        await deregisterTelegramWebhook(env, userId);
      } catch (err) {
        console.error(`[subscription] Failed to deregister Telegram webhook for user ${userId}:`, err);
      }
    }
  }
}
async function deregisterTelegramWebhook(env, userId) {
  const integration = await env.DB.prepare(
    `SELECT access_token FROM user_integrations WHERE user_id = ? AND provider = 'telegram'`
  ).bind(userId).first();
  if (!integration?.access_token)
    return;
  const response = await fetch(
    `https://api.telegram.org/bot${integration.access_token}/deleteWebhook`,
    { method: "POST" }
  );
  if (!response.ok) {
    const text = await response.text();
    console.warn(`[subscription] Telegram deleteWebhook returned ${response.status}: ${text}`);
  } else {
    console.log(`[subscription] Deregistered Telegram webhook for user ${userId}`);
  }
}
var MODULE_REVISION3, SubscriptionError;
var init_webhook_handler = __esm({
  "src/messaging/webhook-handler.ts"() {
    "use strict";
    init_delivery();
    MODULE_REVISION3 = "messaging-webhook-v28-legacy-team-id";
    console.log(`[messaging-webhook] REVISION: ${MODULE_REVISION3} loaded at ${(/* @__PURE__ */ new Date()).toISOString()}`);
    SubscriptionError = class extends Error {
      code;
      constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "SubscriptionError";
      }
    };
    __name(SubscriptionError, "SubscriptionError");
    __name(verifySlackSignature, "verifySlackSignature");
    __name(verifyDiscordSignature, "verifyDiscordSignature");
    __name(verifyTelegramSecret, "verifyTelegramSecret");
    __name(parseSlackEvent, "parseSlackEvent");
    __name(parseDiscordEvent, "parseDiscordEvent");
    __name(parseTelegramUpdate, "parseTelegramUpdate");
    __name(resolveChannelName, "resolveChannelName");
    __name(resolveSlackSenderName, "resolveSlackSenderName");
    __name(normalizeChannelName, "normalizeChannelName");
    __name(channelMatchesFilter, "channelMatchesFilter");
    __name(handleInboundWebhook, "handleInboundWebhook");
    __name(processSubscriptionMessage, "processSubscriptionMessage");
    __name(createSubscription, "createSubscription");
    __name(registerTelegramWebhook, "registerTelegramWebhook");
    __name(listSubscriptions, "listSubscriptions");
    __name(deleteSubscription, "deleteSubscription");
    __name(deregisterTelegramWebhook, "deregisterTelegramWebhook");
  }
});

// src/messaging/delivery.ts
var delivery_exports = {};
__export(delivery_exports, {
  cleanupExpiredMessages: () => cleanupExpiredMessages,
  deliverOrWakeAndDrain: () => deliverOrWakeAndDrain,
  retryBufferedMessages: () => retryBufferedMessages,
  wakeAndDrainStaleMessages: () => wakeAndDrainStaleMessages
});
async function deliverOrWakeAndDrain(env, dashboardId, messagingItemId, userId, provider) {
  const connectedTerminals = await env.DB.prepare(`
    SELECT DISTINCT de.target_item_id
    FROM dashboard_edges de
    JOIN dashboard_items di ON di.id = de.target_item_id AND di.type = 'terminal'
    JOIN terminal_integrations ti ON ti.item_id = de.target_item_id AND ti.provider = ? AND ti.deleted_at IS NULL AND ti.active_policy_id IS NOT NULL
    WHERE de.source_item_id = ?
  `).bind(provider, messagingItemId).all();
  if (!connectedTerminals.results?.length) {
    console.log(`[delivery] No terminal with ${provider} integration+policy connected to messaging block ${messagingItemId} \u2014 messages stay buffered`);
    return;
  }
  let effectiveUserId = userId;
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, effectiveUserId).first();
  if (!access) {
    const owner = await env.DB.prepare(`
      SELECT user_id FROM dashboard_members
      WHERE dashboard_id = ? AND role = 'owner'
      LIMIT 1
    `).bind(dashboardId).first();
    if (!owner) {
      console.error(`[delivery] Dashboard ${dashboardId} has no owner \u2014 cannot wake sandbox`);
      return;
    }
    effectiveUserId = owner.user_id;
  }
  const envWithCache = env;
  const sandboxResult = await ensureDashb\u043EardSandb\u043Ex(envWithCache, dashboardId, effectiveUserId);
  if (sandboxResult instanceof Response) {
    console.error(`[delivery] Failed to ensure sandbox for dashboard ${dashboardId}`);
    return;
  }
  const { sandboxSessionId, sandboxMachineId } = sandboxResult;
  const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
  const terminalPtys = [];
  for (const terminal of connectedTerminals.results) {
    try {
      const pty = await resolveTerminalPty(
        env,
        sandbox,
        dashboardId,
        terminal.target_item_id,
        effectiveUserId,
        sandboxSessionId,
        sandboxMachineId
      );
      if (pty)
        terminalPtys.push(pty);
    } catch (err) {
      console.error(`[delivery] Failed to resolve PTY for terminal ${terminal.target_item_id}:`, err);
    }
  }
  if (!terminalPtys.length) {
    console.log(`[delivery] No active PTYs for dashboard ${dashboardId} \u2014 messages stay buffered`);
    return;
  }
  await claimAndFanOut(env, sandbox, dashboardId, messagingItemId, provider, terminalPtys);
}
async function resolveTerminalPty(env, sandbox, dashboardId, terminalItemId, effectiveUserId, sandboxSessionId, sandboxMachineId) {
  const activeSession = await env.DB.prepare(`
    SELECT id, pty_id, sandbox_session_id, sandbox_machine_id
    FROM sessions
    WHERE item_id = ? AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `).bind(terminalItemId).first();
  if (activeSession?.pty_id) {
    return {
      terminalItemId,
      sessionId: activeSession.sandbox_session_id,
      ptyId: activeSession.pty_id,
      machineId: activeSession.sandbox_machine_id || sandboxMachineId
    };
  }
  const ptyId = crypto.randomUUID();
  const integrationToken = await createPtyToken(
    ptyId,
    sandboxSessionId,
    dashboardId,
    effectiveUserId,
    env.INTERNAL_API_TOKEN
  );
  await sandbox.createPty(
    sandboxSessionId,
    "system",
    void 0,
    // No boot command
    sandboxMachineId,
    {
      ptyId,
      integrationToken
    }
  );
  const newSessionId = crypto.randomUUID();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare(`
    INSERT INTO sessions (id, dashboard_id, item_id, owner_user_id, owner_name, sandbox_session_id, sandbox_machine_id, pty_id, status, created_at)
    VALUES (?, ?, ?, ?, 'system', ?, ?, ?, 'active', ?)
  `).bind(
    newSessionId,
    dashboardId,
    terminalItemId,
    effectiveUserId,
    sandboxSessionId,
    sandboxMachineId,
    ptyId,
    now
  ).run();
  console.log(`[delivery] Created PTY ${ptyId} for message delivery to terminal ${terminalItemId}`);
  return {
    terminalItemId,
    sessionId: sandboxSessionId,
    ptyId,
    machineId: sandboxMachineId
  };
}
function policyAllowsMessage(policy, msg) {
  if (!policy.canReceive)
    return false;
  if (policy.channelFilter) {
    if (policy.channelFilter.mode === "allowlist") {
      const { channelIds, channelNames } = policy.channelFilter;
      const hasFilter = channelIds?.length || channelNames?.length;
      if (!hasFilter)
        return false;
      if (!channelMatchesFilter(
        msg.channel_id || "",
        msg.channel_name || "",
        channelIds,
        channelNames
      ))
        return false;
    }
  }
  if (policy.senderFilter && policy.senderFilter.mode !== "all") {
    const { mode, userIds, userNames } = policy.senderFilter;
    const senderIdMatch = userIds?.includes(msg.sender_id || "");
    const senderNameMatch = userNames?.some(
      (n) => n.toLowerCase() === (msg.sender_name || "").toLowerCase()
    );
    if (mode === "allowlist" && !senderIdMatch && !senderNameMatch)
      return false;
    if (mode === "blocklist" && (senderIdMatch || senderNameMatch))
      return false;
  }
  return true;
}
async function checkPerTerminalPolicy(env, msg, messagingItemId, terminalItemIds) {
  const terminalPolicies = await env.DB.prepare(`
    SELECT de.target_item_id AS terminal_item_id, ip.policy
    FROM dashboard_edges de
    JOIN dashboard_items di ON di.id = de.target_item_id AND di.type = 'terminal'
    JOIN terminal_integrations ti ON ti.item_id = de.target_item_id AND ti.provider = ? AND ti.deleted_at IS NULL
    JOIN integration_policies ip ON ip.id = ti.active_policy_id
    WHERE de.source_item_id = ?
  `).bind(msg.provider, messagingItemId).all();
  if (!terminalPolicies.results?.length)
    return "no_policy";
  const result = /* @__PURE__ */ new Map();
  let anyAllowed = false;
  for (const terminalId of terminalItemIds) {
    const row = terminalPolicies.results.find((r) => r.terminal_item_id === terminalId);
    if (!row) {
      result.set(terminalId, false);
      continue;
    }
    let policy;
    try {
      policy = JSON.parse(row.policy);
    } catch {
      result.set(terminalId, false);
      continue;
    }
    const allowed = policyAllowsMessage(policy, msg);
    result.set(terminalId, allowed);
    if (allowed)
      anyAllowed = true;
  }
  return anyAllowed ? result : "all_denied";
}
async function claimAndFanOut(env, sandbox, dashboardId, messagingItemId, provider, terminalPtys) {
  await env.DB.prepare(`
    UPDATE inbound_messages
    SET status = 'expired'
    WHERE dashboard_id = ? AND status = 'buffered' AND expires_at <= datetime('now')
  `).bind(dashboardId).run();
  const messages = await env.DB.prepare(`
    SELECT im.* FROM inbound_messages im
    JOIN messaging_subscriptions ms ON ms.id = im.subscription_id
    WHERE im.dashboard_id = ? AND im.status = 'buffered'
      AND im.provider = ?
      AND ms.item_id = ?
      AND ms.status = 'active'
      AND im.expires_at > datetime('now')
    ORDER BY im.created_at ASC
    LIMIT 50
  `).bind(dashboardId, provider, messagingItemId).all();
  if (!messages.results?.length) {
    return;
  }
  console.log(`[delivery] Fanning out ${messages.results.length} messages to ${terminalPtys.length} terminal(s) for dashboard ${dashboardId}`);
  for (const msg of messages.results) {
    try {
      const claim = await env.DB.prepare(`
        UPDATE inbound_messages
        SET status = 'delivering', delivery_attempts = delivery_attempts + 1, claimed_at = datetime('now')
        WHERE id = ? AND status = 'buffered'
      `).bind(msg.id).run();
      if (!claim.meta?.changes) {
        console.log(`[delivery] Message ${msg.id} already claimed by another worker \u2014 skipping`);
        continue;
      }
      const attemptsAfterClaim = msg.delivery_attempts + 1;
      const allTerminalIds = terminalPtys.map((p) => p.terminalItemId);
      const policyResult = await checkPerTerminalPolicy(env, msg, messagingItemId, allTerminalIds);
      if (policyResult === "all_denied") {
        console.log(`[delivery] Message ${msg.id} denied by all terminal policies \u2014 dropping`);
        await env.DB.prepare(`
          UPDATE inbound_messages SET status = 'failed' WHERE id = ?
        `).bind(msg.id).run();
        continue;
      }
      if (policyResult === "no_policy") {
        console.log(`[delivery] Message ${msg.id} has no policy configured \u2014 keeping buffered`);
        await env.DB.prepare(`
          UPDATE inbound_messages
          SET status = 'buffered', claimed_at = NULL, delivery_attempts = delivery_attempts - 1
          WHERE id = ?
        `).bind(msg.id).run();
        continue;
      }
      let alreadyDelivered;
      try {
        alreadyDelivered = new Set(JSON.parse(msg.delivered_terminals || "[]"));
      } catch {
        alreadyDelivered = /* @__PURE__ */ new Set();
      }
      const remainingPtys = terminalPtys.filter(
        (p) => !alreadyDelivered.has(p.terminalItemId) && policyResult.get(p.terminalItemId) === true
      );
      if (!remainingPtys.length) {
        await env.DB.prepare(`
          UPDATE inbound_messages SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?
        `).bind(msg.id).run();
        continue;
      }
      const formattedMessage = formatMessageForPty(msg);
      const newlyDelivered = [];
      const failedTerminals = [];
      for (const pty of remainingPtys) {
        try {
          await sandbox.writePty(pty.sessionId, pty.ptyId, formattedMessage, pty.machineId);
          newlyDelivered.push(pty.terminalItemId);
        } catch (err) {
          console.error(`[delivery] Failed to write message ${msg.id} to terminal ${pty.terminalItemId}:`, err);
          failedTerminals.push(pty.terminalItemId);
        }
      }
      const allDeliveredTerminals = [...alreadyDelivered, ...newlyDelivered];
      if (!failedTerminals.length) {
        await env.DB.prepare(`
          UPDATE inbound_messages
          SET status = 'delivered', delivered_at = datetime('now'), delivered_terminals = ?
          WHERE id = ?
        `).bind(JSON.stringify(allDeliveredTerminals), msg.id).run();
      } else {
        const newStatus = attemptsAfterClaim >= 3 ? "failed" : "buffered";
        await env.DB.prepare(`
          UPDATE inbound_messages SET status = ?, delivered_terminals = ? WHERE id = ?
        `).bind(newStatus, JSON.stringify(allDeliveredTerminals), msg.id).run();
        if (newStatus === "buffered") {
          console.log(`[delivery] Message ${msg.id}: ${newlyDelivered.length} delivered, ${failedTerminals.length} failed \u2014 will retry for remaining`);
        }
      }
    } catch (err) {
      console.error(`[delivery] Failed to deliver message ${msg.id}:`, err);
      const attemptsAfterClaim = msg.delivery_attempts + 1;
      const newStatus = attemptsAfterClaim >= 3 ? "failed" : "buffered";
      await env.DB.prepare(`
        UPDATE inbound_messages SET status = ? WHERE id = ?
      `).bind(newStatus, msg.id).run();
    }
  }
}
function stripAnsiAndControlChars(text) {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z@-~]/g, "").replace(/\x1b\][\s\S]*?(?:\x1b\\|\x07)/g, "").replace(/\x1b[^[\]]/g, "").replace(/\x1b/g, "").replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
}
function formatMessageForPty(msg) {
  const provider = msg.provider.charAt(0).toUpperCase() + msg.provider.slice(1);
  const channelDisplay = stripAnsiAndControlChars(msg.channel_name || msg.channel_id || "unknown");
  const senderDisplay = stripAnsiAndControlChars(msg.sender_name || msg.sender_id || "unknown");
  const messageText = stripAnsiAndControlChars(msg.message_text || "(empty)");
  let metadata = {};
  try {
    metadata = JSON.parse(msg.message_metadata || "{}");
  } catch {
  }
  const isEdit = metadata.is_edit === true;
  const lines = [];
  lines.push(`
[${isEdit ? "EDITED" : "INBOUND"} from ${provider} ${channelDisplay}]`);
  lines.push(`From: ${senderDisplay}`);
  lines.push(`Channel: ${channelDisplay}`);
  if (metadata.thread_ts) {
    lines.push(`Thread: ${stripAnsiAndControlChars(String(metadata.thread_ts))}`);
  }
  if (metadata.reply_to_message_id) {
    lines.push(`Reply to: ${stripAnsiAndControlChars(String(metadata.reply_to_message_id))}`);
  }
  lines.push(`Message: ${messageText}`);
  lines.push("---");
  const replyTool = getReplyToolName(msg.provider, metadata);
  if (replyTool) {
    lines.push(`Reply with ${replyTool} tool.`);
  }
  lines.push("");
  return lines.join("\n");
}
function getReplyToolName(provider, metadata) {
  switch (provider) {
    case "slack":
      return metadata.thread_ts ? "slack_reply_thread" : "slack_send_message";
    default:
      return null;
  }
}
async function cleanupExpiredMessages(env) {
  const stuckReset = await env.DB.prepare(`
    UPDATE inbound_messages
    SET status = 'buffered', claimed_at = NULL
    WHERE status = 'delivering'
      AND claimed_at IS NOT NULL AND claimed_at < datetime('now', '-5 minutes')
      AND delivery_attempts < 3
  `).run();
  if (stuckReset.meta?.changes && stuckReset.meta.changes > 0) {
    console.log(`[delivery] Reset ${stuckReset.meta.changes} stuck delivering messages back to buffered`);
  }
  const stuckFailed = await env.DB.prepare(`
    UPDATE inbound_messages
    SET status = 'failed'
    WHERE status = 'delivering'
      AND claimed_at IS NOT NULL AND claimed_at < datetime('now', '-5 minutes')
      AND delivery_attempts >= 3
  `).run();
  if (stuckFailed.meta?.changes && stuckFailed.meta.changes > 0) {
    console.log(`[delivery] Failed ${stuckFailed.meta.changes} stuck delivering messages (max retries exceeded)`);
  }
  const legacyStuck = await env.DB.prepare(`
    UPDATE inbound_messages
    SET status = CASE WHEN delivery_attempts >= 3 THEN 'failed' ELSE 'buffered' END
    WHERE status = 'delivering'
      AND claimed_at IS NULL
      AND created_at < datetime('now', '-10 minutes')
  `).run();
  if (legacyStuck.meta?.changes && legacyStuck.meta.changes > 0) {
    console.log(`[delivery] Reset ${legacyStuck.meta.changes} legacy stuck delivering messages`);
  }
  const expired = await env.DB.prepare(`
    UPDATE inbound_messages
    SET status = 'expired'
    WHERE status IN ('buffered', 'failed') AND expires_at < datetime('now')
  `).run();
  if (expired.meta?.changes && expired.meta.changes > 0) {
    console.log(`[delivery] Expired ${expired.meta.changes} old messages`);
  }
  const cleaned = await env.DB.prepare(`
    DELETE FROM inbound_messages
    WHERE status = 'delivered' AND delivered_at < datetime('now', '-7 days')
  `).run();
  if (cleaned.meta?.changes && cleaned.meta.changes > 0) {
    console.log(`[delivery] Cleaned ${cleaned.meta.changes} old delivered messages`);
  }
  const cleanedExpired = await env.DB.prepare(`
    DELETE FROM inbound_messages
    WHERE status = 'expired' AND created_at < datetime('now', '-7 days')
  `).run();
  if (cleanedExpired.meta?.changes && cleanedExpired.meta.changes > 0) {
    console.log(`[delivery] Cleaned ${cleanedExpired.meta.changes} old expired messages`);
  }
}
async function retryBufferedMessages(env) {
  const targets = await env.DB.prepare(`
    SELECT DISTINCT im.dashboard_id, ms.item_id as messaging_item_id, ms.user_id, im.provider,
      ds.sandbox_session_id, ds.sandbox_machine_id
    FROM inbound_messages im
    JOIN messaging_subscriptions ms ON ms.id = im.subscription_id
    JOIN dashboard_sandboxes ds ON ds.dashboard_id = im.dashboard_id
    WHERE im.status = 'buffered'
      AND ms.status = 'active'
      AND im.delivery_attempts < 3
      AND im.expires_at > datetime('now')
    LIMIT 10
  `).all();
  if (!targets.results?.length) {
    return;
  }
  const sandbox = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
  for (const row of targets.results) {
    try {
      const connectedTerminals = await env.DB.prepare(`
        SELECT DISTINCT de.target_item_id
        FROM dashboard_edges de
        JOIN dashboard_items di ON di.id = de.target_item_id AND di.type = 'terminal'
        JOIN terminal_integrations ti ON ti.item_id = de.target_item_id AND ti.provider = ? AND ti.deleted_at IS NULL AND ti.active_policy_id IS NOT NULL
        WHERE de.source_item_id = ?
      `).bind(row.provider, row.messaging_item_id).all();
      if (!connectedTerminals.results?.length)
        continue;
      const owner = await env.DB.prepare(`
        SELECT user_id FROM dashboard_members
        WHERE dashboard_id = ? AND role = 'owner' LIMIT 1
      `).bind(row.dashboard_id).first();
      const effectiveUserId = owner?.user_id || row.user_id;
      const terminalPtys = [];
      for (const terminal of connectedTerminals.results) {
        try {
          const pty = await resolveTerminalPty(
            env,
            sandbox,
            row.dashboard_id,
            terminal.target_item_id,
            effectiveUserId,
            row.sandbox_session_id,
            row.sandbox_machine_id
          );
          if (pty)
            terminalPtys.push(pty);
        } catch (err) {
          console.error(`[delivery] Retry: failed to resolve PTY for terminal ${terminal.target_item_id}:`, err);
        }
      }
      if (!terminalPtys.length)
        continue;
      await claimAndFanOut(env, sandbox, row.dashboard_id, row.messaging_item_id, row.provider, terminalPtys);
    } catch (err) {
      console.error(`[delivery] Retry failed for dashboard ${row.dashboard_id}:`, err);
    }
  }
}
async function wakeAndDrainStaleMessages(env) {
  const targets = await env.DB.prepare(`
    SELECT DISTINCT im.dashboard_id, ms.item_id as messaging_item_id, ms.user_id, im.provider
    FROM inbound_messages im
    JOIN messaging_subscriptions ms ON ms.id = im.subscription_id
    WHERE im.status = 'buffered'
      AND ms.status = 'active'
      AND im.delivery_attempts < 3
      AND im.expires_at > datetime('now')
      AND im.created_at < datetime('now', '-1 minutes')
      AND NOT EXISTS (
        SELECT 1 FROM dashboard_sandboxes ds WHERE ds.dashboard_id = im.dashboard_id
      )
    LIMIT 2
  `).all();
  if (!targets.results?.length) {
    return;
  }
  console.log(`[delivery] Waking ${targets.results.length} sleeping dashboard(s) to drain stale messages`);
  for (const row of targets.results) {
    try {
      await deliverOrWakeAndDrain(env, row.dashboard_id, row.messaging_item_id, row.user_id, row.provider);
    } catch (err) {
      console.error(`[delivery] Wake-and-drain failed for dashboard ${row.dashboard_id}:`, err);
    }
  }
}
var MODULE_REVISION4;
var init_delivery = __esm({
  "src/messaging/delivery.ts"() {
    "use strict";
    init_handler2();
    init_client();
    init_pty_token();
    init_webhook_handler();
    MODULE_REVISION4 = "messaging-delivery-v21-strip-cr";
    console.log(`[messaging-delivery] REVISION: ${MODULE_REVISION4} loaded at ${(/* @__PURE__ */ new Date()).toISOString()}`);
    __name(deliverOrWakeAndDrain, "deliverOrWakeAndDrain");
    __name(resolveTerminalPty, "resolveTerminalPty");
    __name(policyAllowsMessage, "policyAllowsMessage");
    __name(checkPerTerminalPolicy, "checkPerTerminalPolicy");
    __name(claimAndFanOut, "claimAndFanOut");
    __name(stripAnsiAndControlChars, "stripAnsiAndControlChars");
    __name(formatMessageForPty, "formatMessageForPty");
    __name(getReplyToolName, "getReplyToolName");
    __name(cleanupExpiredMessages, "cleanupExpiredMessages");
    __name(retryBufferedMessages, "retryBufferedMessages");
    __name(wakeAndDrainStaleMessages, "wakeAndDrainStaleMessages");
  }
});

// src/integration-policies/response-filter.ts
function filterResponse(provider, action, response, policy) {
  switch (provider) {
    case "gmail":
      return filterGmailResponse(action, response, policy);
    case "github":
      return filterGitHubResponse(action, response, policy);
    case "google_drive":
      return filterDriveResponse(action, response, policy);
    case "google_calendar":
      return filterCalendarResponse(action, response, policy);
    case "slack":
    case "discord":
    case "telegram":
    case "whatsapp":
    case "teams":
    case "matrix":
    case "google_chat":
      return filterMessagingResponse(action, response, policy);
    default:
      return { data: response, filtered: false };
  }
}
function extractEmailDomain(email) {
  if (!email)
    return void 0;
  const match = email.match(/<([^>]+)>/) || email.match(/([^\s<>]+@[^\s<>]+)/);
  const addr = match ? match[1] : email;
  const parts = addr.split("@");
  return parts.length === 2 ? parts[1].toLowerCase() : void 0;
}
function extractEmailAddress(email) {
  if (!email)
    return void 0;
  const match = email.match(/<([^>]+)>/) || email.match(/([^\s<>]+@[^\s<>]+)/);
  return match ? match[1].toLowerCase() : email.toLowerCase();
}
function filterGmailResponse(action, response, policy) {
  if (!action.includes("search") && !action.includes("list") && action !== "gmail.get") {
    return { data: response, filtered: false };
  }
  if (Array.isArray(response)) {
    return filterGmailMessages(response, policy);
  }
  if (response && typeof response === "object" && "id" in response) {
    const result = filterGmailMessages([response], policy);
    if (result.removedCount === 1) {
      return { data: null, filtered: true, removedCount: 1 };
    }
    return { data: response, filtered: false };
  }
  if (response && typeof response === "object" && "messages" in response) {
    const listResponse = response;
    const result = filterGmailMessages(listResponse.messages || [], policy);
    return {
      data: {
        ...listResponse,
        messages: result.data
      },
      filtered: result.filtered,
      removedCount: result.removedCount
    };
  }
  return { data: response, filtered: false };
}
function filterGmailMessages(messages, policy) {
  const hasSenderFilter = policy.senderFilter && policy.senderFilter.mode !== "all";
  const hasLabelFilter = policy.labelFilter && policy.labelFilter.mode !== "all";
  if (!hasSenderFilter && !hasLabelFilter) {
    return { data: messages, filtered: false };
  }
  const originalCount = messages.length;
  const filtered = messages.filter((msg) => {
    if (hasSenderFilter) {
      const { mode, domains, addresses } = policy.senderFilter;
      let from = msg.from;
      if (!from && msg.payload?.headers) {
        const fromHeader = msg.payload.headers.find((h) => h.name.toLowerCase() === "from");
        from = fromHeader?.value;
      }
      const senderDomain = extractEmailDomain(from);
      const senderAddress = extractEmailAddress(from);
      if (mode === "allowlist") {
        const domainMatch = domains?.some((d) => d.toLowerCase() === senderDomain);
        const addressMatch = addresses?.some((a) => a.toLowerCase() === senderAddress);
        if (!domainMatch && !addressMatch)
          return false;
      }
      if (mode === "blocklist") {
        const domainBlocked = domains?.some((d) => d.toLowerCase() === senderDomain);
        const addressBlocked = addresses?.some((a) => a.toLowerCase() === senderAddress);
        if (domainBlocked || addressBlocked)
          return false;
      }
    }
    if (hasLabelFilter) {
      const { labels } = policy.labelFilter;
      if (labels?.length) {
        const msgLabels = msg.labelIds || [];
        const hasAllowedLabel = msgLabels.some(
          (label) => labels.some((allowed) => allowed.toLowerCase() === label.toLowerCase())
        );
        if (!hasAllowedLabel)
          return false;
      }
    }
    return true;
  });
  const removedCount = originalCount - filtered.length;
  return {
    data: filtered,
    filtered: removedCount > 0,
    removedCount
  };
}
function filterGitHubResponse(action, response, policy) {
  if (!policy.repoFilter || policy.repoFilter.mode === "all") {
    return { data: response, filtered: false };
  }
  if (action.includes("list_repos") || action.includes("search_repos")) {
    if (Array.isArray(response)) {
      return filterGitHubRepos(response, policy);
    }
  }
  if (action.includes("search_code")) {
    if (response && typeof response === "object" && "items" in response) {
      const searchResponse = response;
      const items = searchResponse.items || [];
      const originalCount = items.length;
      const filtered = items.filter((item) => {
        if (!item.repository)
          return true;
        return isRepoAllowed(item.repository.full_name, item.repository.owner.login, policy);
      });
      const removedCount = originalCount - filtered.length;
      return {
        data: { ...searchResponse, items: filtered, total_count: searchResponse.total_count - removedCount },
        filtered: removedCount > 0,
        removedCount
      };
    }
    if (Array.isArray(response)) {
      const items = response;
      const originalCount = items.length;
      const filtered = items.filter((item) => {
        if (!item.repository)
          return true;
        return isRepoAllowed(item.repository.full_name, item.repository.owner.login, policy);
      });
      const removedCount = originalCount - filtered.length;
      return { data: filtered, filtered: removedCount > 0, removedCount };
    }
  }
  return { data: response, filtered: false };
}
function isRepoAllowed(fullName, ownerLogin, policy) {
  if (!policy.repoFilter || policy.repoFilter.mode === "all")
    return true;
  const { mode, repos: repoPatterns, orgs } = policy.repoFilter;
  const repoName = fullName.toLowerCase();
  const ownerName = ownerLogin.toLowerCase();
  const orgMatch = orgs?.length ? orgs.some((o) => o.toLowerCase() === ownerName) : false;
  const patternMatch = repoPatterns?.length ? repoPatterns.some((pattern) => {
    return globToRegex(pattern.toLowerCase()).test(repoName);
  }) : false;
  if (mode === "allowlist") {
    const orgAllowed = orgs?.length ? orgMatch : false;
    const repoAllowed = repoPatterns?.length ? patternMatch : false;
    return orgAllowed || repoAllowed;
  }
  if (mode === "blocklist") {
    if (orgMatch || patternMatch)
      return false;
  }
  return true;
}
function filterGitHubRepos(repos, policy) {
  if (!policy.repoFilter || policy.repoFilter.mode === "all") {
    return { data: repos, filtered: false };
  }
  const originalCount = repos.length;
  const filtered = repos.filter((repo) => isRepoAllowed(repo.full_name, repo.owner.login, policy));
  const removedCount = originalCount - filtered.length;
  return {
    data: filtered,
    filtered: removedCount > 0,
    removedCount
  };
}
function filterDriveResponse(action, response, policy) {
  const hasFileTypeFilter = policy.fileTypeFilter && policy.fileTypeFilter.mode !== "all";
  const hasFolderFilter = policy.folderFilter && policy.folderFilter.mode !== "all" && policy.folderFilter.folderIds?.length;
  if (!hasFileTypeFilter && !hasFolderFilter) {
    return { data: response, filtered: false };
  }
  if (action.includes("list") || action.includes("search") || action === "drive.sync_list") {
    if (response && typeof response === "object" && "files" in response) {
      const listResponse = response;
      const result = filterDriveFiles(listResponse.files || [], policy);
      return {
        data: {
          ...listResponse,
          files: result.data
        },
        filtered: result.filtered,
        removedCount: result.removedCount
      };
    }
    if (Array.isArray(response)) {
      return filterDriveFiles(response, policy);
    }
  }
  if (action === "drive.changes_list") {
    if (response && typeof response === "object" && "changes" in response) {
      const changesResponse = response;
      const originalCount = changesResponse.changes.length;
      const filteredChanges = changesResponse.changes.filter((change) => {
        if (change.removed || !change.file)
          return true;
        const result = filterDriveFiles([change.file], policy);
        return result.data.length > 0;
      });
      const removedCount = originalCount - filteredChanges.length;
      return {
        data: {
          ...changesResponse,
          changes: filteredChanges
        },
        filtered: removedCount > 0,
        removedCount
      };
    }
  }
  if (action.includes("get") || action.includes("download")) {
    if (response && typeof response === "object" && "id" in response) {
      const file = response;
      const result = filterDriveFiles([file], policy);
      if (result.removedCount === 1) {
        return {
          data: null,
          filtered: true,
          removedCount: 1
        };
      }
    }
  }
  return { data: response, filtered: false };
}
function filterDriveFiles(files, policy) {
  const originalCount = files.length;
  let filtered = files;
  if (policy.fileTypeFilter && policy.fileTypeFilter.mode !== "all") {
    const { mode, mimeTypes, extensions } = policy.fileTypeFilter;
    filtered = filtered.filter((file) => {
      const mimeType = file.mimeType.toLowerCase();
      const fileName = file.name.toLowerCase();
      const mimeMatch = mimeTypes?.some((t) => mimeType.includes(t.toLowerCase()));
      const extMatch = extensions?.some((ext) => fileName.endsWith(ext.toLowerCase()));
      const typeMatch = mimeMatch || extMatch;
      if (mode === "allowlist")
        return typeMatch;
      if (mode === "blocklist")
        return !typeMatch;
      return true;
    });
  }
  if (policy.folderFilter && policy.folderFilter.mode !== "all" && policy.folderFilter.folderIds?.length) {
    const { mode, folderIds } = policy.folderFilter;
    filtered = filtered.filter((file) => {
      if (!file.parents?.length)
        return mode === "blocklist";
      const inAllowedFolder = file.parents.some((parent) => folderIds.includes(parent));
      if (mode === "allowlist")
        return inAllowedFolder;
      if (mode === "blocklist")
        return !inAllowedFolder;
      return true;
    });
  }
  const removedCount = originalCount - filtered.length;
  return {
    data: filtered,
    filtered: removedCount > 0,
    removedCount
  };
}
function filterCalendarResponse(action, response, policy) {
  if (!policy.calendarFilter || policy.calendarFilter.mode === "all") {
    return { data: response, filtered: false };
  }
  const { calendarIds } = policy.calendarFilter;
  if (!calendarIds?.length) {
    return { data: response, filtered: false };
  }
  if (action === "calendar.list_calendars") {
    if (response && typeof response === "object" && "calendars" in response) {
      const listResponse = response;
      const calendars = listResponse.calendars || [];
      const originalCount = calendars.length;
      const filtered = calendars.filter((cal) => {
        const calId = cal.id.toLowerCase();
        return calendarIds.some(
          (id) => id.toLowerCase() === calId || id === "primary" && cal.primary
        );
      });
      const removedCount = originalCount - filtered.length;
      return {
        data: { ...listResponse, calendars: filtered },
        filtered: removedCount > 0,
        removedCount
      };
    }
  }
  return { data: response, filtered: false };
}
function filterMessagingResponse(action, response, policy) {
  if (!response || typeof response !== "object") {
    return { data: response, filtered: false };
  }
  const cleaned = JSON.parse(JSON.stringify(response));
  let didFilter = false;
  let discordArrayResult = null;
  if (action.includes("list_channels") && policy.channelFilter?.mode === "allowlist") {
    const { channelIds, channelNames } = policy.channelFilter;
    const hasAllowlist = channelIds?.length || channelNames?.length;
    if (!hasAllowlist) {
      if ("channels" in cleaned && Array.isArray(cleaned.channels)) {
        cleaned.channels = [];
        didFilter = true;
      } else if (Array.isArray(cleaned)) {
        discordArrayResult = [];
        didFilter = true;
      }
    } else {
      const normalizedNames = channelNames?.map((n) => n.replace(/^#/, "").toLowerCase()) || [];
      const filterChannel = /* @__PURE__ */ __name((ch) => {
        const chId = ch.id;
        const chName = ch.name?.replace(/^#/, "").toLowerCase();
        const idMatch = chId && channelIds?.includes(chId);
        const nameMatch = chName && normalizedNames.includes(chName);
        return !!(idMatch || nameMatch);
      }, "filterChannel");
      if ("channels" in cleaned && Array.isArray(cleaned.channels)) {
        const before = cleaned.channels.length;
        cleaned.channels = cleaned.channels.filter(filterChannel);
        didFilter = cleaned.channels.length < before;
      } else if (Array.isArray(cleaned)) {
        discordArrayResult = cleaned.filter(filterChannel);
        didFilter = true;
      }
    }
  }
  if (action.includes("user_info") || action.includes("get_user")) {
    didFilter = stripUserPII(cleaned);
  }
  if (discordArrayResult) {
    for (const item of discordArrayResult) {
      if (item && typeof item === "object") {
        didFilter = stripUserPII(item) || didFilter;
      }
    }
    return { data: discordArrayResult, filtered: didFilter };
  }
  if (Array.isArray(cleaned)) {
    for (const item of cleaned) {
      if (item && typeof item === "object") {
        didFilter = stripUserPII(item) || didFilter;
      }
    }
  }
  if ("messages" in cleaned && Array.isArray(cleaned.messages)) {
    for (const msg of cleaned.messages) {
      if (msg && typeof msg === "object") {
        if (msg.user_profile && typeof msg.user_profile === "object") {
          didFilter = stripUserPII(msg.user_profile) || didFilter;
        }
      }
    }
  }
  if ("user" in cleaned && cleaned.user && typeof cleaned.user === "object") {
    didFilter = stripUserPII(cleaned.user) || didFilter;
  }
  return { data: cleaned, filtered: didFilter };
}
function stripUserPII(obj) {
  let stripped = false;
  const PII_FIELDS = ["email", "phone", "skype", "image_original", "image_512", "image_192", "image_72"];
  for (const field of PII_FIELDS) {
    if (field in obj) {
      delete obj[field];
      stripped = true;
    }
  }
  if (obj.profile && typeof obj.profile === "object") {
    const profile = obj.profile;
    for (const field of PII_FIELDS) {
      if (field in profile) {
        delete profile[field];
        stripped = true;
      }
    }
  }
  return stripped;
}
var init_response_filter = __esm({
  "src/integration-policies/response-filter.ts"() {
    "use strict";
    init_handler3();
    console.log(`[response-filter] REVISION: response-filter-v7-empty-allowlist-pii loaded at ${(/* @__PURE__ */ new Date()).toISOString()}`);
    __name(filterResponse, "filterResponse");
    __name(extractEmailDomain, "extractEmailDomain");
    __name(extractEmailAddress, "extractEmailAddress");
    __name(filterGmailResponse, "filterGmailResponse");
    __name(filterGmailMessages, "filterGmailMessages");
    __name(filterGitHubResponse, "filterGitHubResponse");
    __name(isRepoAllowed, "isRepoAllowed");
    __name(filterGitHubRepos, "filterGitHubRepos");
    __name(filterDriveResponse, "filterDriveResponse");
    __name(filterDriveFiles, "filterDriveFiles");
    __name(filterCalendarResponse, "filterCalendarResponse");
    __name(filterMessagingResponse, "filterMessagingResponse");
    __name(stripUserPII, "stripUserPII");
  }
});

// src/integration-policies/api-clients/gmail.ts
async function executeGmailAction(action, args, accessToken) {
  switch (action) {
    case "gmail.search":
    case "gmail.list":
      return searchMessages(args, accessToken);
    case "gmail.get":
      return getMessage(args, accessToken);
    case "gmail.send":
      return sendMessage(args, accessToken);
    case "gmail.archive":
      return archiveMessage(args, accessToken);
    case "gmail.trash":
      return trashMessage(args, accessToken);
    case "gmail.mark_read":
      return markRead(args, accessToken);
    case "gmail.mark_unread":
      return markUnread(args, accessToken);
    case "gmail.add_label":
      return addLabel(args, accessToken);
    case "gmail.remove_label":
      return removeLabel(args, accessToken);
    default:
      throw new Error(`Unknown Gmail action: ${action}`);
  }
}
async function searchMessages(args, accessToken) {
  const query = args.query || "";
  const maxResults = Math.min(args.maxResults || 10, 100);
  const pageToken = args.pageToken || void 0;
  const params = new URLSearchParams({
    q: query,
    maxResults: maxResults.toString()
  });
  if (pageToken) {
    params.set("pageToken", pageToken);
  }
  const response = await fetch(`${GMAIL_API_BASE}/messages?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gmail API error: ${response.status} - ${error}`);
  }
  const searchResult = await response.json();
  if (!searchResult.messages?.length) {
    return [];
  }
  const messages = await Promise.all(
    searchResult.messages.slice(0, maxResults).map(async (msg) => {
      return getMessage({ messageId: msg.id }, accessToken);
    })
  );
  return messages;
}
async function getMessage(args, accessToken) {
  const messageId = args.messageId;
  if (!messageId) {
    throw new Error("messageId is required");
  }
  const response = await fetch(`${GMAIL_API_BASE}/messages/${messageId}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gmail API error: ${response.status} - ${error}`);
  }
  return response.json();
}
async function sendMessage(args, accessToken) {
  const to = args.to || [];
  const cc = args.cc || [];
  const bcc = args.bcc || [];
  const subject = args.subject || "";
  const body = args.body || "";
  const threadId = args.threadId || void 0;
  const headers = [
    `To: ${to.join(", ")}`,
    cc.length ? `Cc: ${cc.join(", ")}` : null,
    bcc.length ? `Bcc: ${bcc.join(", ")}` : null,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8"
  ].filter(Boolean).join("\r\n");
  const email = `${headers}\r
\r
${body}`;
  const encodedEmail = btoa(unescape(encodeURIComponent(email))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const requestBody = { raw: encodedEmail };
  if (threadId) {
    requestBody.threadId = threadId;
  }
  const response = await fetch(`${GMAIL_API_BASE}/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gmail API error: ${response.status} - ${error}`);
  }
  return response.json();
}
async function archiveMessage(args, accessToken) {
  const messageId = args.messageId;
  if (!messageId) {
    throw new Error("messageId is required");
  }
  return modifyLabels(messageId, [], ["INBOX"], accessToken);
}
async function trashMessage(args, accessToken) {
  const messageId = args.messageId;
  if (!messageId) {
    throw new Error("messageId is required");
  }
  const response = await fetch(`${GMAIL_API_BASE}/messages/${messageId}/trash`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gmail API error: ${response.status} - ${error}`);
  }
  return response.json();
}
async function markRead(args, accessToken) {
  const messageId = args.messageId;
  if (!messageId) {
    throw new Error("messageId is required");
  }
  return modifyLabels(messageId, [], ["UNREAD"], accessToken);
}
async function markUnread(args, accessToken) {
  const messageId = args.messageId;
  if (!messageId) {
    throw new Error("messageId is required");
  }
  return modifyLabels(messageId, ["UNREAD"], [], accessToken);
}
async function addLabel(args, accessToken) {
  const messageId = args.messageId;
  const labelId = args.labelId;
  if (!messageId || !labelId) {
    throw new Error("messageId and labelId are required");
  }
  return modifyLabels(messageId, [labelId], [], accessToken);
}
async function removeLabel(args, accessToken) {
  const messageId = args.messageId;
  const labelId = args.labelId;
  if (!messageId || !labelId) {
    throw new Error("messageId and labelId are required");
  }
  return modifyLabels(messageId, [], [labelId], accessToken);
}
async function modifyLabels(messageId, addLabelIds, removeLabelIds, accessToken) {
  const response = await fetch(`${GMAIL_API_BASE}/messages/${messageId}/modify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      addLabelIds,
      removeLabelIds
    })
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gmail API error: ${response.status} - ${error}`);
  }
  return response.json();
}
var GMAIL_API_BASE;
var init_gmail = __esm({
  "src/integration-policies/api-clients/gmail.ts"() {
    "use strict";
    console.log(`[gmail-client] REVISION: gmail-client-v1 loaded at ${(/* @__PURE__ */ new Date()).toISOString()}`);
    GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
    __name(executeGmailAction, "executeGmailAction");
    __name(searchMessages, "searchMessages");
    __name(getMessage, "getMessage");
    __name(sendMessage, "sendMessage");
    __name(archiveMessage, "archiveMessage");
    __name(trashMessage, "trashMessage");
    __name(markRead, "markRead");
    __name(markUnread, "markUnread");
    __name(addLabel, "addLabel");
    __name(removeLabel, "removeLabel");
    __name(modifyLabels, "modifyLabels");
  }
});

// src/integration-policies/api-clients/github.ts
async function executeGitHubAction(action, args, accessToken) {
  switch (action) {
    case "github.list_repos":
      return listRepos(args, accessToken);
    case "github.get_repo":
      return getRepo(args, accessToken);
    case "github.list_issues":
      return listIssues(args, accessToken);
    case "github.create_issue":
      return createIssue(args, accessToken);
    case "github.list_prs":
      return listPRs(args, accessToken);
    case "github.create_pr":
      return createPR(args, accessToken);
    case "github.get_file":
      return getFileContent(args, accessToken);
    case "github.list_files":
      return listFiles(args, accessToken);
    case "github.search_code":
      return searchCode(args, accessToken);
    default:
      throw new Error(`Unknown GitHub action: ${action}`);
  }
}
async function githubFetch(path, accessToken, options) {
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...options?.headers
    }
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API error: ${response.status} - ${error}`);
  }
  return response;
}
async function listRepos(args, accessToken) {
  const type = args.type || "all";
  const sort = args.sort || "updated";
  const perPage = Math.min(args.perPage || 30, 100);
  const params = new URLSearchParams({
    type,
    sort,
    per_page: perPage.toString()
  });
  const response = await githubFetch(`/user/repos?${params}`, accessToken);
  return response.json();
}
async function getRepo(args, accessToken) {
  const owner = args.owner;
  const repo = args.repo;
  if (!owner || !repo) {
    throw new Error("owner and repo are required");
  }
  const response = await githubFetch(`/repos/${owner}/${repo}`, accessToken);
  return response.json();
}
async function listIssues(args, accessToken) {
  const owner = args.owner;
  const repo = args.repo;
  if (!owner || !repo) {
    throw new Error("owner and repo are required");
  }
  const state = args.state || "open";
  const perPage = Math.min(args.perPage || 30, 100);
  const params = new URLSearchParams({
    state,
    per_page: perPage.toString()
  });
  const response = await githubFetch(`/repos/${owner}/${repo}/issues?${params}`, accessToken);
  return response.json();
}
async function createIssue(args, accessToken) {
  const owner = args.owner;
  const repo = args.repo;
  const title = args.title;
  if (!owner || !repo || !title) {
    throw new Error("owner, repo, and title are required");
  }
  const body = args.body || "";
  const labels = args.labels || [];
  const response = await githubFetch(`/repos/${owner}/${repo}/issues`, accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, body, labels })
  });
  return response.json();
}
async function listPRs(args, accessToken) {
  const owner = args.owner;
  const repo = args.repo;
  if (!owner || !repo) {
    throw new Error("owner and repo are required");
  }
  const state = args.state || "open";
  const perPage = Math.min(args.perPage || 30, 100);
  const params = new URLSearchParams({
    state,
    per_page: perPage.toString()
  });
  const response = await githubFetch(`/repos/${owner}/${repo}/pulls?${params}`, accessToken);
  return response.json();
}
async function createPR(args, accessToken) {
  const owner = args.owner;
  const repo = args.repo;
  const title = args.title;
  const head = args.head;
  const base = args.base || "main";
  if (!owner || !repo || !title || !head) {
    throw new Error("owner, repo, title, and head are required");
  }
  const body = args.body || "";
  const draft = args.draft || false;
  const response = await githubFetch(`/repos/${owner}/${repo}/pulls`, accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, body, head, base, draft })
  });
  return response.json();
}
async function getFileContent(args, accessToken) {
  const owner = args.owner;
  const repo = args.repo;
  const path = args.path;
  if (!owner || !repo || !path) {
    throw new Error("owner, repo, and path are required");
  }
  const ref = args.ref || void 0;
  const params = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const response = await githubFetch(
    `/repos/${owner}/${repo}/contents/${path}${params}`,
    accessToken
  );
  return response.json();
}
async function listFiles(args, accessToken) {
  const owner = args.owner;
  const repo = args.repo;
  const path = args.path || "";
  if (!owner || !repo) {
    throw new Error("owner and repo are required");
  }
  const ref = args.ref || void 0;
  const params = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const response = await githubFetch(
    `/repos/${owner}/${repo}/contents/${path}${params}`,
    accessToken
  );
  return response.json();
}
async function searchCode(args, accessToken) {
  const query = args.query;
  if (!query) {
    throw new Error("query is required");
  }
  const owner = args.owner || void 0;
  const repo = args.repo || void 0;
  const perPage = Math.min(args.perPage || 30, 100);
  let q = query;
  if (owner && repo) {
    q += ` repo:${owner}/${repo}`;
  } else if (owner) {
    q += ` user:${owner}`;
  }
  const params = new URLSearchParams({
    q,
    per_page: perPage.toString()
  });
  const response = await githubFetch(`/search/code?${params}`, accessToken);
  return response.json();
}
var GITHUB_API_BASE;
var init_github = __esm({
  "src/integration-policies/api-clients/github.ts"() {
    "use strict";
    console.log(`[github-client] REVISION: github-client-v1 loaded at ${(/* @__PURE__ */ new Date()).toISOString()}`);
    GITHUB_API_BASE = "https://api.github.com";
    __name(executeGitHubAction, "executeGitHubAction");
    __name(githubFetch, "githubFetch");
    __name(listRepos, "listRepos");
    __name(getRepo, "getRepo");
    __name(listIssues, "listIssues");
    __name(createIssue, "createIssue");
    __name(listPRs, "listPRs");
    __name(createPR, "createPR");
    __name(getFileContent, "getFileContent");
    __name(listFiles, "listFiles");
    __name(searchCode, "searchCode");
  }
});

// src/integration-policies/api-clients/drive.ts
async function executeDriveAction(action, args, accessToken) {
  switch (action) {
    case "drive.list":
    case "drive.search":
      return listFiles2(args, accessToken);
    case "drive.get":
      return getFile(args, accessToken);
    case "drive.download":
      return downloadFile(args, accessToken);
    case "drive.create":
      return createFile(args, accessToken);
    case "drive.update":
      return updateFile(args, accessToken);
    case "drive.delete":
      return deleteFile(args, accessToken);
    case "drive.share":
      return shareFile(args, accessToken);
    case "drive.sync_list":
      return syncListFiles(args, accessToken);
    case "drive.changes_start_token":
      return getChangesStartToken(accessToken);
    case "drive.changes_list":
      return listChanges(args, accessToken);
    default:
      throw new Error(`Unknown Drive action: ${action}`);
  }
}
async function driveFetch(path, accessToken, options) {
  const response = await fetch(`${DRIVE_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...options?.headers
    }
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Drive API error: ${response.status} - ${error}`);
  }
  return response;
}
async function listFiles2(args, accessToken) {
  const query = args.query || void 0;
  const folderId = args.folderId || void 0;
  const pageSize = Math.min(args.pageSize || 100, 1e3);
  const pageToken = args.pageToken || void 0;
  const params = new URLSearchParams({
    pageSize: pageSize.toString(),
    fields: "files(id,name,mimeType,parents,webViewLink,webContentLink,size,modifiedTime,createdTime,owners),nextPageToken"
  });
  const queryParts = [];
  if (query) {
    queryParts.push(query);
  }
  if (folderId) {
    queryParts.push(`'${folderId}' in parents`);
  }
  queryParts.push("trashed = false");
  if (queryParts.length) {
    params.set("q", queryParts.join(" and "));
  }
  if (pageToken) {
    params.set("pageToken", pageToken);
  }
  const response = await driveFetch(`/files?${params}`, accessToken);
  return response.json();
}
async function getFile(args, accessToken) {
  const fileId = args.fileId;
  if (!fileId) {
    throw new Error("fileId is required");
  }
  const params = new URLSearchParams({
    fields: "id,name,mimeType,parents,webViewLink,webContentLink,size,modifiedTime,createdTime,owners"
  });
  const response = await driveFetch(`/files/${fileId}?${params}`, accessToken);
  return response.json();
}
function isTextMimeType(mimeType) {
  const textTypes = [
    "text/",
    "application/json",
    "application/xml",
    "application/javascript",
    "application/typescript",
    "application/x-yaml",
    "application/toml",
    "application/csv",
    "application/sql",
    "application/graphql",
    "application/ld+json",
    "application/xhtml+xml",
    "application/svg+xml",
    "application/x-sh"
  ];
  const lower = mimeType.toLowerCase();
  return textTypes.some((t) => lower.startsWith(t)) || lower.endsWith("+xml") || lower.endsWith("+json");
}
async function downloadFile(args, accessToken) {
  const fileId = args.fileId;
  if (!fileId) {
    throw new Error("fileId is required");
  }
  const file = await getFile({ fileId }, accessToken);
  if (file.mimeType.startsWith("application/vnd.google-apps")) {
    const exportMimeType = getExportMimeType(file.mimeType);
    const response2 = await driveFetch(`/files/${fileId}/export?mimeType=${encodeURIComponent(exportMimeType)}`, accessToken);
    const content2 = await response2.text();
    return { content: content2, mimeType: exportMimeType };
  }
  const response = await driveFetch(`/files/${fileId}?alt=media`, accessToken);
  if (isTextMimeType(file.mimeType)) {
    const content2 = await response.text();
    return { content: content2, mimeType: file.mimeType };
  }
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const content = btoa(binary);
  return { content, mimeType: file.mimeType, encoding: "base64" };
}
function getExportMimeType(googleMimeType) {
  const exportTypes = {
    "application/vnd.google-apps.document": "text/plain",
    "application/vnd.google-apps.spreadsheet": "text/csv",
    "application/vnd.google-apps.presentation": "text/plain",
    "application/vnd.google-apps.drawing": "image/png"
  };
  return exportTypes[googleMimeType] || "text/plain";
}
function buildMultipartBody(boundary, metadata, mimeType, content, encoding) {
  const encoder = new TextEncoder();
  const metadataSection = encoder.encode(
    `--${boundary}\r
Content-Type: application/json; charset=UTF-8\r
\r
${JSON.stringify(metadata)}\r
--${boundary}\r
Content-Type: ${mimeType}\r
\r
`
  );
  let contentBytes;
  if (encoding === "base64") {
    const binaryString = atob(content);
    contentBytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      contentBytes[i] = binaryString.charCodeAt(i);
    }
  } else {
    contentBytes = encoder.encode(content);
  }
  const closingBoundary = encoder.encode(`\r
--${boundary}--`);
  const body = new Uint8Array(metadataSection.length + contentBytes.length + closingBoundary.length);
  body.set(metadataSection, 0);
  body.set(contentBytes, metadataSection.length);
  body.set(closingBoundary, metadataSection.length + contentBytes.length);
  return body;
}
async function createFile(args, accessToken) {
  const name = args.name;
  const content = args.content || "";
  const mimeType = args.mimeType || "text/plain";
  const folderId = args.folderId || void 0;
  const encoding = args.encoding || void 0;
  if (!name) {
    throw new Error("name is required");
  }
  const metadata = { name, mimeType };
  if (folderId) {
    metadata.parents = [folderId];
  }
  const boundary = "orcabot_boundary_" + crypto.randomUUID();
  const body = buildMultipartBody(boundary, metadata, mimeType, content, encoding);
  const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`
    },
    body
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Drive API error: ${response.status} - ${error}`);
  }
  return response.json();
}
async function updateFile(args, accessToken) {
  const fileId = args.fileId;
  const content = args.content || "";
  const encoding = args.encoding || void 0;
  if (!fileId) {
    throw new Error("fileId is required");
  }
  const name = args.name || void 0;
  const mimeType = args.mimeType || "text/plain";
  const boundary = "orcabot_boundary_" + crypto.randomUUID();
  const metadata = {};
  if (name)
    metadata.name = name;
  const body = buildMultipartBody(boundary, metadata, mimeType, content, encoding);
  const response = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id,name,mimeType,webViewLink`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`
    },
    body
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Drive API error: ${response.status} - ${error}`);
  }
  return response.json();
}
async function deleteFile(args, accessToken) {
  const fileId = args.fileId;
  if (!fileId) {
    throw new Error("fileId is required");
  }
  const response = await driveFetch(`/files/${fileId}`, accessToken, {
    method: "DELETE"
  });
  return { success: true };
}
async function shareFile(args, accessToken) {
  const fileId = args.fileId;
  const email = args.email;
  const role = args.role || "reader";
  if (!fileId || !email) {
    throw new Error("fileId and email are required");
  }
  const response = await driveFetch(`/files/${fileId}/permissions`, accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "user",
      role,
      emailAddress: email
    })
  });
  return response.json();
}
async function syncListFiles(args, accessToken) {
  const folderId = args.folderId || void 0;
  if (folderId) {
    return syncListFilesRecursive(folderId, accessToken);
  }
  const allFiles = [];
  let pageToken;
  let totalSize = 0;
  do {
    const params = new URLSearchParams({
      pageSize: "1000",
      fields: "files(id,name,mimeType,parents,size,modifiedTime,md5Checksum,createdTime),nextPageToken",
      q: "trashed = false"
    });
    if (pageToken) {
      params.set("pageToken", pageToken);
    }
    const response = await driveFetch(`/files?${params}`, accessToken);
    const data = await response.json();
    for (const file of data.files) {
      allFiles.push(file);
      if (file.size) {
        totalSize += parseInt(file.size, 10);
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return { files: allFiles, totalSize };
}
async function syncListFilesRecursive(rootFolderId, accessToken) {
  const allFiles = [];
  let totalSize = 0;
  const foldersToProcess = [rootFolderId];
  while (foldersToProcess.length > 0) {
    const currentFolderId = foldersToProcess.shift();
    let pageToken;
    do {
      const params = new URLSearchParams({
        pageSize: "1000",
        fields: "files(id,name,mimeType,parents,size,modifiedTime,md5Checksum,createdTime),nextPageToken",
        q: `'${currentFolderId}' in parents and trashed = false`
      });
      if (pageToken) {
        params.set("pageToken", pageToken);
      }
      const response = await driveFetch(`/files?${params}`, accessToken);
      const data = await response.json();
      for (const file of data.files) {
        allFiles.push(file);
        if (file.size) {
          totalSize += parseInt(file.size, 10);
        }
        if (file.mimeType === "application/vnd.google-apps.folder") {
          foldersToProcess.push(file.id);
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }
  return { files: allFiles, totalSize };
}
async function getChangesStartToken(accessToken) {
  const response = await driveFetch("/changes/startPageToken", accessToken);
  return response.json();
}
async function listChanges(args, accessToken) {
  const initialPageToken = args.pageToken;
  if (!initialPageToken) {
    throw new Error("pageToken is required");
  }
  const allChanges = [];
  let pageToken = initialPageToken;
  let newStartPageToken = "";
  do {
    const params = new URLSearchParams({
      pageToken,
      pageSize: "1000",
      fields: "changes(fileId,removed,file(id,name,mimeType,parents,size,modifiedTime,md5Checksum,trashed)),newStartPageToken,nextPageToken",
      spaces: "drive",
      includeRemoved: "true"
    });
    const response = await driveFetch(`/changes?${params}`, accessToken);
    const data = await response.json();
    allChanges.push(...data.changes);
    if (data.newStartPageToken) {
      newStartPageToken = data.newStartPageToken;
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return { changes: allChanges, newStartPageToken };
}
var DRIVE_API_BASE;
var init_drive = __esm({
  "src/integration-policies/api-clients/drive.ts"() {
    "use strict";
    console.log(`[drive-client] REVISION: drive-client-v5-recursive-sync-list loaded at ${(/* @__PURE__ */ new Date()).toISOString()}`);
    DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
    __name(executeDriveAction, "executeDriveAction");
    __name(driveFetch, "driveFetch");
    __name(listFiles2, "listFiles");
    __name(getFile, "getFile");
    __name(isTextMimeType, "isTextMimeType");
    __name(downloadFile, "downloadFile");
    __name(getExportMimeType, "getExportMimeType");
    __name(buildMultipartBody, "buildMultipartBody");
    __name(createFile, "createFile");
    __name(updateFile, "updateFile");
    __name(deleteFile, "deleteFile");
    __name(shareFile, "shareFile");
    __name(syncListFiles, "syncListFiles");
    __name(syncListFilesRecursive, "syncListFilesRecursive");
    __name(getChangesStartToken, "getChangesStartToken");
    __name(listChanges, "listChanges");
  }
});

// src/integration-policies/api-clients/calendar.ts
async function executeCalendarAction(action, args, accessToken) {
  switch (action) {
    case "calendar.list_calendars":
      return listCalendars(args, accessToken);
    case "calendar.list_events":
      return listEvents(args, accessToken);
    case "calendar.get_event":
      return getEvent(args, accessToken);
    case "calendar.create_event":
      return createEvent(args, accessToken);
    case "calendar.update_event":
      return updateEvent(args, accessToken);
    case "calendar.delete_event":
      return deleteEvent(args, accessToken);
    case "calendar.search_events":
      return searchEvents(args, accessToken);
    default:
      throw new Error(`Unknown Calendar action: ${action}`);
  }
}
async function calendarFetch(path, accessToken, options) {
  const response = await fetch(`${CALENDAR_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...options?.headers
    }
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Calendar API error: ${response.status} - ${error}`);
  }
  return response;
}
async function listCalendars(args, accessToken) {
  const response = await calendarFetch("/users/me/calendarList", accessToken);
  const result = await response.json();
  return { calendars: result.items || [] };
}
async function listEvents(args, accessToken) {
  const calendarId = args.calendarId || "primary";
  const timeMin = args.timeMin || (/* @__PURE__ */ new Date()).toISOString();
  const timeMax = args.timeMax || void 0;
  const maxResults = Math.min(args.maxResults || 100, 2500);
  const pageToken = args.pageToken || void 0;
  const params = new URLSearchParams({
    maxResults: maxResults.toString(),
    timeMin,
    singleEvents: "true",
    orderBy: "startTime"
  });
  if (timeMax) {
    params.set("timeMax", timeMax);
  }
  if (pageToken) {
    params.set("pageToken", pageToken);
  }
  const response = await calendarFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    accessToken
  );
  return response.json();
}
async function getEvent(args, accessToken) {
  const calendarId = args.calendarId || "primary";
  const eventId = args.eventId;
  if (!eventId) {
    throw new Error("eventId is required");
  }
  const response = await calendarFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
    accessToken
  );
  return response.json();
}
async function createEvent(args, accessToken) {
  const calendarId = args.calendarId || "primary";
  const summary = args.summary;
  if (!summary) {
    throw new Error("summary is required");
  }
  const start = args.start;
  const end = args.end;
  if (!start || !end) {
    throw new Error("start and end are required");
  }
  const event = {
    summary,
    start,
    end,
    description: args.description || void 0,
    location: args.location || void 0,
    attendees: args.attendees || void 0
  };
  const sendUpdates = args.sendUpdates || "none";
  const response = await calendarFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=${sendUpdates}`,
    accessToken,
    {
      method: "POST",
      body: JSON.stringify(event)
    }
  );
  return response.json();
}
async function updateEvent(args, accessToken) {
  const calendarId = args.calendarId || "primary";
  const eventId = args.eventId;
  if (!eventId) {
    throw new Error("eventId is required");
  }
  const existing = await getEvent({ calendarId, eventId }, accessToken);
  const event = {
    ...existing,
    summary: args.summary || existing.summary,
    description: args.description !== void 0 ? args.description : existing.description,
    location: args.location !== void 0 ? args.location : existing.location,
    start: args.start || existing.start,
    end: args.end || existing.end,
    attendees: args.attendees || existing.attendees
  };
  const sendUpdates = args.sendUpdates || "none";
  const response = await calendarFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}?sendUpdates=${sendUpdates}`,
    accessToken,
    {
      method: "PUT",
      body: JSON.stringify(event)
    }
  );
  return response.json();
}
async function deleteEvent(args, accessToken) {
  const calendarId = args.calendarId || "primary";
  const eventId = args.eventId;
  if (!eventId) {
    throw new Error("eventId is required");
  }
  const sendUpdates = args.sendUpdates || "none";
  await calendarFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}?sendUpdates=${sendUpdates}`,
    accessToken,
    {
      method: "DELETE"
    }
  );
  return { success: true };
}
async function searchEvents(args, accessToken) {
  const calendarId = args.calendarId || "primary";
  const query = args.query;
  const timeMin = args.timeMin || (/* @__PURE__ */ new Date()).toISOString();
  const timeMax = args.timeMax || void 0;
  const maxResults = Math.min(args.maxResults || 100, 2500);
  const params = new URLSearchParams({
    maxResults: maxResults.toString(),
    timeMin,
    singleEvents: "true",
    orderBy: "startTime"
  });
  if (query) {
    params.set("q", query);
  }
  if (timeMax) {
    params.set("timeMax", timeMax);
  }
  const response = await calendarFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    accessToken
  );
  return response.json();
}
var CALENDAR_API_BASE;
var init_calendar = __esm({
  "src/integration-policies/api-clients/calendar.ts"() {
    "use strict";
    console.log(`[calendar-client] REVISION: calendar-client-v1 loaded at ${(/* @__PURE__ */ new Date()).toISOString()}`);
    CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
    __name(executeCalendarAction, "executeCalendarAction");
    __name(calendarFetch, "calendarFetch");
    __name(listCalendars, "listCalendars");
    __name(listEvents, "listEvents");
    __name(getEvent, "getEvent");
    __name(createEvent, "createEvent");
    __name(updateEvent, "updateEvent");
    __name(deleteEvent, "deleteEvent");
    __name(searchEvents, "searchEvents");
  }
});

// src/integration-policies/api-clients/slack.ts
async function slackFetch(method, accessToken, body) {
  const response = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: body ? JSON.stringify(body) : void 0
  });
  if (!response.ok) {
    throw new Error(`Slack API error: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error || "unknown"}`);
  }
  return data;
}
async function executeSlackAction(action, args, accessToken) {
  switch (action) {
    case "slack.list_channels":
      return listChannels(args, accessToken);
    case "slack.read_messages":
      return readMessages(args, accessToken);
    case "slack.send_message":
      return sendMessage2(args, accessToken);
    case "slack.reply_thread":
      return replyThread(args, accessToken);
    case "slack.react":
      return addReaction(args, accessToken);
    case "slack.search":
      return searchMessages2(args, accessToken);
    case "slack.get_user_info":
      return getUserInfo(args, accessToken);
    case "slack.edit_message":
      return editMessage(args, accessToken);
    case "slack.delete_message":
      return deleteMessage(args, accessToken);
    default:
      throw new Error(`Unknown Slack action: ${action}`);
  }
}
async function listChannels(args, accessToken) {
  const limit = Math.min(args.limit || 100, 1e3);
  const types = args.types || "public_channel,private_channel";
  const data = await slackFetch("conversations.list", accessToken, {
    types,
    limit,
    exclude_archived: true,
    ...args.cursor ? { cursor: args.cursor } : {}
  });
  return {
    channels: data.channels || [],
    // Slack returns empty string for next_cursor when no more pages
    next_cursor: data.response_metadata?.next_cursor || void 0
  };
}
async function readMessages(args, accessToken) {
  const channel = args.channel;
  if (!channel)
    throw new Error("channel is required");
  const limit = Math.min(args.limit || 20, 100);
  const data = await slackFetch("conversations.history", accessToken, {
    channel,
    limit,
    ...args.oldest ? { oldest: args.oldest } : {},
    ...args.latest ? { latest: args.latest } : {}
  });
  return data.messages || [];
}
async function sendMessage2(args, accessToken) {
  const channel = args.channel;
  const text = args.text;
  if (!channel)
    throw new Error("channel is required");
  if (!text)
    throw new Error("text is required");
  const data = await slackFetch("chat.postMessage", accessToken, {
    channel,
    text,
    ...args.blocks ? { blocks: args.blocks } : {}
  });
  return { ts: data.ts, channel: data.channel };
}
async function replyThread(args, accessToken) {
  const channel = args.channel;
  const thread_ts = args.thread_ts;
  const text = args.text;
  if (!channel)
    throw new Error("channel is required");
  if (!thread_ts)
    throw new Error("thread_ts is required");
  if (!text)
    throw new Error("text is required");
  const data = await slackFetch("chat.postMessage", accessToken, {
    channel,
    text,
    thread_ts,
    ...args.reply_broadcast ? { reply_broadcast: true } : {}
  });
  return { ts: data.ts, channel: data.channel };
}
async function addReaction(args, accessToken) {
  const channel = args.channel;
  const timestamp = args.timestamp;
  const name = args.name;
  if (!channel)
    throw new Error("channel is required");
  if (!timestamp)
    throw new Error("timestamp is required");
  if (!name)
    throw new Error("name (emoji name) is required");
  await slackFetch("reactions.add", accessToken, {
    channel,
    timestamp,
    name
  });
  return { ok: true };
}
async function searchMessages2(args, accessToken) {
  const query = args.query;
  if (!query)
    throw new Error("query is required");
  const count = Math.min(args.count || 20, 100);
  const data = await slackFetch("search.messages", accessToken, {
    query,
    count,
    sort: "timestamp",
    sort_dir: "desc"
  });
  return {
    messages: data.messages?.matches || [],
    total: data.messages?.total || 0
  };
}
async function getUserInfo(args, accessToken) {
  const user = args.user;
  if (!user)
    throw new Error("user ID is required");
  const data = await slackFetch("users.info", accessToken, {
    user
  });
  return data.user;
}
async function editMessage(args, accessToken) {
  const channel = args.channel;
  const ts = args.ts;
  const text = args.text;
  if (!channel)
    throw new Error("channel is required");
  if (!ts)
    throw new Error("ts (message timestamp) is required");
  if (!text)
    throw new Error("text is required");
  const data = await slackFetch("chat.update", accessToken, {
    channel,
    ts,
    text
  });
  return { ts: data.ts, channel: data.channel };
}
async function deleteMessage(args, accessToken) {
  const channel = args.channel;
  const ts = args.ts;
  if (!channel)
    throw new Error("channel is required");
  if (!ts)
    throw new Error("ts (message timestamp) is required");
  await slackFetch("chat.delete", accessToken, {
    channel,
    ts
  });
  return { ok: true };
}
var MODULE_REVISION5, SLACK_API_BASE;
var init_slack = __esm({
  "src/integration-policies/api-clients/slack.ts"() {
    "use strict";
    MODULE_REVISION5 = "slack-client-v3-list-channels-cursor";
    console.log(`[slack-client] REVISION: ${MODULE_REVISION5} loaded at ${(/* @__PURE__ */ new Date()).toISOString()}`);
    SLACK_API_BASE = "https://slack.com/api";
    __name(slackFetch, "slackFetch");
    __name(executeSlackAction, "executeSlackAction");
    __name(listChannels, "listChannels");
    __name(readMessages, "readMessages");
    __name(sendMessage2, "sendMessage");
    __name(replyThread, "replyThread");
    __name(addReaction, "addReaction");
    __name(searchMessages2, "searchMessages");
    __name(getUserInfo, "getUserInfo");
    __name(editMessage, "editMessage");
    __name(deleteMessage, "deleteMessage");
  }
});

// src/integration-policies/api-clients/discord.ts
async function discordFetch(endpoint, accessToken, options = {}) {
  const { method = "GET", body } = options;
  const headers = {
    "Authorization": `Bot ${accessToken}`
  };
  if (body) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${DISCORD_API_BASE}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : void 0
  });
  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    let errorCode = `${response.status}`;
    try {
      const errJson = JSON.parse(errBody);
      if (errJson.message)
        errorCode = errJson.message;
    } catch {
    }
    throw new Error(`Discord API error: ${errorCode}`);
  }
  if (response.status === 204) {
    return { ok: true };
  }
  return response.json();
}
async function executeDiscordAction(action, args, accessToken) {
  switch (action) {
    case "discord.list_channels":
      return listChannels2(args, accessToken);
    case "discord.read_messages":
      return readMessages2(args, accessToken);
    case "discord.send_message":
      return sendMessage3(args, accessToken);
    case "discord.reply_thread":
      return replyThread2(args, accessToken);
    case "discord.react":
      return addReaction2(args, accessToken);
    case "discord.get_user_info":
      return getUserInfo2(args, accessToken);
    case "discord.edit_message":
      return editMessage2(args, accessToken);
    case "discord.delete_message":
      return deleteMessage2(args, accessToken);
    default:
      throw new Error(`Unknown Discord action: ${action}`);
  }
}
async function listChannels2(args, accessToken) {
  const guildId = args.guild_id;
  if (!guildId)
    throw new Error("guild_id is required");
  const data = await discordFetch(
    `/guilds/${guildId}/channels`,
    accessToken
  );
  const textChannels = data.filter((ch) => ch.type === 0 || ch.type === 5);
  return { channels: textChannels };
}
async function readMessages2(args, accessToken) {
  const channel = args.channel;
  if (!channel)
    throw new Error("channel is required");
  const limit = Math.min(args.limit || 20, 100);
  const params = new URLSearchParams({ limit: limit.toString() });
  if (args.before)
    params.set("before", args.before);
  if (args.after)
    params.set("after", args.after);
  const data = await discordFetch(
    `/channels/${channel}/messages?${params}`,
    accessToken
  );
  return data;
}
async function sendMessage3(args, accessToken) {
  const channel = args.channel;
  const content = args.text || args.content;
  if (!channel)
    throw new Error("channel is required");
  if (!content)
    throw new Error("text is required");
  const data = await discordFetch(
    `/channels/${channel}/messages`,
    accessToken,
    { method: "POST", body: { content } }
  );
  return { id: data.id, channel_id: data.channel_id };
}
async function replyThread2(args, accessToken) {
  const channel = args.channel;
  const messageId = args.message_id;
  const content = args.text || args.content;
  if (!channel)
    throw new Error("channel is required");
  if (!messageId)
    throw new Error("message_id is required");
  if (!content)
    throw new Error("text is required");
  const data = await discordFetch(
    `/channels/${channel}/messages`,
    accessToken,
    {
      method: "POST",
      body: {
        content,
        message_reference: { message_id: messageId }
      }
    }
  );
  return { id: data.id, channel_id: data.channel_id };
}
async function addReaction2(args, accessToken) {
  const channel = args.channel;
  const messageId = args.message_id;
  const emoji = args.emoji;
  if (!channel)
    throw new Error("channel is required");
  if (!messageId)
    throw new Error("message_id is required");
  if (!emoji)
    throw new Error("emoji is required");
  const encodedEmoji = encodeURIComponent(emoji);
  await discordFetch(
    `/channels/${channel}/messages/${messageId}/reactions/${encodedEmoji}/@me`,
    accessToken,
    { method: "PUT" }
  );
  return { ok: true };
}
async function getUserInfo2(args, accessToken) {
  const userId = args.user || args.user_id;
  if (!userId)
    throw new Error("user ID is required");
  const data = await discordFetch(
    `/users/${userId}`,
    accessToken
  );
  return data;
}
async function editMessage2(args, accessToken) {
  const channel = args.channel;
  const messageId = args.message_id;
  const content = args.text || args.content;
  if (!channel)
    throw new Error("channel is required");
  if (!messageId)
    throw new Error("message_id is required");
  if (!content)
    throw new Error("text is required");
  const data = await discordFetch(
    `/channels/${channel}/messages/${messageId}`,
    accessToken,
    { method: "PATCH", body: { content } }
  );
  return { id: data.id, channel_id: data.channel_id };
}
async function deleteMessage2(args, accessToken) {
  const channel = args.channel;
  const messageId = args.message_id;
  if (!channel)
    throw new Error("channel is required");
  if (!messageId)
    throw new Error("message_id is required");
  await discordFetch(
    `/channels/${channel}/messages/${messageId}`,
    accessToken,
    { method: "DELETE" }
  );
  return { ok: true };
}
var MODULE_REVISION6, DISCORD_API_BASE;
var init_discord = __esm({
  "src/integration-policies/api-clients/discord.ts"() {
    "use strict";
    MODULE_REVISION6 = "discord-client-v1-initial";
    console.log(`[discord-client] REVISION: ${MODULE_REVISION6} loaded at ${(/* @__PURE__ */ new Date()).toISOString()}`);
    DISCORD_API_BASE = "https://discord.com/api/v10";
    __name(discordFetch, "discordFetch");
    __name(executeDiscordAction, "executeDiscordAction");
    __name(listChannels2, "listChannels");
    __name(readMessages2, "readMessages");
    __name(sendMessage3, "sendMessage");
    __name(replyThread2, "replyThread");
    __name(addReaction2, "addReaction");
    __name(getUserInfo2, "getUserInfo");
    __name(editMessage2, "editMessage");
    __name(deleteMessage2, "deleteMessage");
  }
});

// src/integration-policies/gateway.ts
var gateway_exports = {};
__export(gateway_exports, {
  deriveEnforcementContext: () => deriveEnforcementContext,
  handleGatewayExecute: () => handleGatewayExecute,
  handleListTerminalIntegrations: () => handleListTerminalIntegrations
});
function extractEmailDomain2(email) {
  const match = email.match(/<([^>]+)>/) || email.match(/([^\s<>]+@[^\s<>]+)/);
  const addr = match ? match[1] : email;
  const parts = addr.split("@");
  return parts.length === 2 ? parts[1].toLowerCase() : void 0;
}
function extractEmailAddress2(email) {
  const match = email.match(/<([^>]+)>/) || email.match(/([^\s<>]+@[^\s<>]+)/);
  return match ? match[1].toLowerCase() : email.toLowerCase();
}
function deriveEnforcementContext(action, args) {
  const ctx = {};
  if (typeof args.url === "string") {
    ctx.url = args.url;
  }
  const rawRecipients = [];
  for (const field of ["to", "cc", "bcc"]) {
    const val = args[field];
    if (Array.isArray(val)) {
      for (const entry of val) {
        if (typeof entry === "string") {
          rawRecipients.push(entry);
        }
      }
    } else if (typeof val === "string") {
      rawRecipients.push(val);
    }
  }
  if (rawRecipients.length > 0) {
    const pairs = rawRecipients.map((r) => ({
      address: extractEmailAddress2(r),
      domain: extractEmailDomain2(r)
    })).filter((p) => p.address);
    ctx.recipients = pairs.map((p) => p.address);
    ctx.recipientDomains = pairs.map((p) => p.domain || "");
    ctx.recipient = ctx.recipients[0];
    ctx.recipientDomain = ctx.recipientDomains[0];
  }
  if (typeof args.fileId === "string")
    ctx.resourceId = args.fileId;
  else if (typeof args.messageId === "string")
    ctx.resourceId = args.messageId;
  else if (typeof args.eventId === "string")
    ctx.resourceId = args.eventId;
  else if (typeof args.ts === "string")
    ctx.resourceId = args.ts;
  else if (typeof args.timestamp === "string")
    ctx.resourceId = args.timestamp;
  if (typeof args.owner === "string")
    ctx.repoOwner = args.owner;
  if (typeof args.repo === "string")
    ctx.repoName = args.repo;
  if (typeof args.calendarId === "string") {
    ctx.calendarId = args.calendarId;
  }
  if (typeof args.folderId === "string")
    ctx.folderId = args.folderId;
  if (typeof args.name === "string")
    ctx.fileName = args.name;
  if (typeof args.mimeType === "string")
    ctx.mimeType = args.mimeType;
  if (typeof args.channel === "string") {
    ctx.channelId = args.channel;
  } else if (typeof args.chat_id === "string") {
    ctx.channelId = args.chat_id;
  }
  if (typeof args.channel_name === "string") {
    ctx.channelName = args.channel_name;
  }
  if (typeof args.text === "string") {
    ctx.messageText = args.text;
  }
  if (typeof args.thread_ts === "string") {
    ctx.threadTs = args.thread_ts;
  } else if (typeof args.reply_to_message_id === "string") {
    ctx.threadTs = args.reply_to_message_id;
  }
  if (typeof args.user === "string") {
    ctx.recipientUserId = args.user;
  } else if (typeof args.user_id === "string") {
    ctx.recipientUserId = args.user_id;
  }
  return ctx;
}
async function resolveOutboundChannelName(provider, channelId, accessToken) {
  try {
    if (provider === "slack") {
      const res = await fetch("https://slack.com/api/conversations.info", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({ channel: channelId })
      });
      if (!res.ok)
        return null;
      const data = await res.json();
      return data.ok && data.channel?.name ? data.channel.name : null;
    }
    if (provider === "discord") {
      return null;
    }
    return null;
  } catch (err) {
    console.warn(`[gateway] Failed to resolve channel name for ${provider}/${channelId}:`, err);
    return null;
  }
}
function getActionCategory2(action) {
  if (action.includes("download") || action.includes("clone"))
    return "downloads";
  if (action.includes("upload"))
    return "uploads";
  if (action.includes("send") || action.includes("push") || action.includes("create_pr") || action.includes("reply") || action.includes("draft"))
    return "sends";
  if (action.includes("delete") || action.includes("trash") || action.includes("remove"))
    return "deletes";
  if (action.includes("create") || action.includes("update") || action.includes("write") || action.includes("archive") || action.includes("label") || action.includes("move") || action.includes("share") || action.includes("edit") || action.includes("react"))
    return "writes";
  return "reads";
}
async function checkRateLimit2(env, terminalIntegrationId, provider, action, policy) {
  const rateLimits = policy.rateLimits;
  const msgSendMaxPerHour = policy.sendPolicy?.maxPerHour;
  if (!rateLimits && !msgSendMaxPerHour) {
    return { allowed: true };
  }
  const category = getActionCategory2(action);
  const MESSAGING_PROVIDERS = /* @__PURE__ */ new Set(["slack", "discord", "telegram", "whatsapp", "teams", "matrix", "google_chat"]);
  let limit;
  let window;
  switch (category) {
    case "reads":
      if (MESSAGING_PROVIDERS.has(provider) && rateLimits?.messagesPerMinute != null) {
        limit = rateLimits.messagesPerMinute;
      } else {
        limit = rateLimits?.readsPerMinute;
      }
      window = "minute";
      break;
    case "writes":
      limit = rateLimits?.writesPerHour;
      window = "hour";
      break;
    case "deletes":
      limit = rateLimits?.deletesPerHour ?? rateLimits?.writesPerHour;
      window = "hour";
      break;
    case "sends":
      if (rateLimits?.sendsPerDay) {
        limit = rateLimits.sendsPerDay;
        window = "day";
      } else if (MESSAGING_PROVIDERS.has(provider) && rateLimits?.messagesPerHour != null) {
        limit = rateLimits.messagesPerHour;
        window = "hour";
      } else {
        limit = msgSendMaxPerHour ?? rateLimits?.sendsPerHour ?? rateLimits?.writesPerHour;
        window = "hour";
      }
      break;
    case "downloads":
      limit = rateLimits?.downloadsPerHour ?? rateLimits?.readsPerMinute;
      window = rateLimits?.downloadsPerHour ? "hour" : "minute";
      break;
    case "uploads":
      limit = rateLimits?.uploadsPerHour ?? rateLimits?.writesPerHour;
      window = "hour";
      break;
  }
  if (limit == null) {
    return { allowed: true };
  }
  if (limit === 0) {
    return {
      allowed: false,
      reason: `Rate limit is 0 for ${category} (all ${category} blocked)`
    };
  }
  const counterKey = `${terminalIntegrationId}:${provider}:${category}`;
  const counterId = env.RATE_LIMIT_COUNTER.idFromName(counterKey);
  const counter = env.RATE_LIMIT_COUNTER.get(counterId);
  try {
    const res = await counter.fetch(new Request("http://counter/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit, window })
    }));
    if (!res.ok) {
      console.error(`[gateway] Rate limit check failed (failing closed): ${res.status}`);
      return { allowed: false, reason: "Rate limiter unavailable - request denied for safety" };
    }
    const result = await res.json();
    if (!result.allowed) {
      return {
        allowed: false,
        reason: `Rate limit exceeded for ${category} (${limit}/${window})`
      };
    }
  } catch (err) {
    console.error(`[gateway] Rate limit check error (failing closed):`, err);
    return { allowed: false, reason: "Rate limiter unavailable - request denied for safety" };
  }
  return { allowed: true };
}
async function logAuditEntry2(env, data) {
  const id = `aud_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await env.DB.prepare(`
    INSERT INTO integration_audit_log
    (id, terminal_integration_id, terminal_id, dashboard_id, user_id, provider, action, resource_id, policy_id, policy_version, policy_decision, denial_reason, request_summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(
    id,
    data.terminalIntegrationId,
    data.terminalId,
    data.dashboardId,
    data.userId,
    data.provider,
    data.action,
    data.resourceId ?? null,
    data.policyId,
    data.policyVersion,
    data.decision,
    data.denialReason ?? null,
    data.requestSummary ?? null
  ).run();
}
async function getAccessToken(env, userIntegrationId, provider) {
  const userInt = await env.DB.prepare(`
    SELECT access_token, refresh_token, expires_at
    FROM user_integrations WHERE id = ?
  `).bind(userIntegrationId).first();
  if (!userInt) {
    return null;
  }
  if (userInt.expires_at) {
    const expiresAt = new Date(userInt.expires_at);
    const now = /* @__PURE__ */ new Date();
    const bufferMs = 5 * 60 * 1e3;
    if (expiresAt.getTime() - bufferMs < now.getTime()) {
      if (userInt.refresh_token) {
        const newToken = await refreshOAuthToken(env, userIntegrationId, provider, userInt.refresh_token);
        if (newToken) {
          return newToken;
        }
      }
      return null;
    }
  }
  return userInt.access_token;
}
async function refreshOAuthToken(env, userIntegrationId, provider, refreshToken) {
  let tokenUrl;
  let body;
  if (provider === "gmail" || provider === "google_drive" || provider === "google_calendar") {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      console.error("[gateway] Google OAuth not configured for token refresh");
      return null;
    }
    tokenUrl = "https://oauth2.googleapis.com/token";
    body = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    });
  } else if (provider === "github") {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      console.error("[gateway] GitHub OAuth not configured for token refresh");
      return null;
    }
    tokenUrl = "https://github.com/login/oauth/access_token";
    body = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    });
  } else {
    console.warn(`[gateway] OAuth refresh not supported for provider: ${provider}`);
    return null;
  }
  try {
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json"
      },
      body
    });
    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      console.error(`[gateway] OAuth refresh failed for ${provider}:`, response.status, errBody);
      const isInvalidGrant = errBody.includes("invalid_grant") || errBody.includes("bad_refresh_token") || errBody.includes("The refresh token is invalid");
      if (isInvalidGrant) {
        console.warn(`[gateway] Refresh token invalid for ${provider}, user needs to reconnect`);
      }
      return null;
    }
    const tokenData = await response.json();
    if (!tokenData.access_token) {
      console.error(`[gateway] OAuth refresh returned no access_token for ${provider}`);
      return null;
    }
    const expiresIn = tokenData.expires_in || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1e3).toISOString();
    if (tokenData.refresh_token) {
      await env.DB.prepare(`
        UPDATE user_integrations
        SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(tokenData.access_token, tokenData.refresh_token, expiresAt, userIntegrationId).run();
    } else {
      await env.DB.prepare(`
        UPDATE user_integrations
        SET access_token = ?, expires_at = ?, updated_at = datetime('now')
        WHERE id = ?
      `).bind(tokenData.access_token, expiresAt, userIntegrationId).run();
    }
    console.log(`[gateway] OAuth token refreshed successfully for ${provider}`);
    return tokenData.access_token;
  } catch (err) {
    console.error(`[gateway] OAuth refresh error for ${provider}:`, err);
    return null;
  }
}
async function executeProviderAPI(provider, action, args, accessToken) {
  switch (provider) {
    case "gmail":
      return executeGmailAction(action, args, accessToken);
    case "github":
      return executeGitHubAction(action, args, accessToken);
    case "google_drive":
      return executeDriveAction(action, args, accessToken);
    case "google_calendar":
      return executeCalendarAction(action, args, accessToken);
    case "slack":
      return executeSlackAction(action, args, accessToken);
    case "discord":
      return executeDiscordAction(action, args, accessToken);
    case "browser":
      throw new Error("Browser actions should not reach the gateway");
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}
async function handleGatewayExecute(request, env, provider) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return Response.json(
      { error: "AUTH_DENIED", reason: "Missing Authorization header" },
      { status: 401 }
    );
  }
  const ptyToken = authHeader.slice(7);
  const claims = await verifyPtyToken(ptyToken, env.INTERNAL_API_TOKEN);
  if (!claims) {
    return Response.json(
      { error: "AUTH_DENIED", reason: "Invalid or expired PTY token" },
      { status: 401 }
    );
  }
  const { terminal_id: terminalId, dashboard_id: dashboardId, user_id: userId } = claims;
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "INVALID_REQUEST", reason: "Invalid JSON body" },
      { status: 400 }
    );
  }
  if (!body.action) {
    return Response.json(
      { error: "INVALID_REQUEST", reason: "Missing action" },
      { status: 400 }
    );
  }
  const ti = await env.DB.prepare(`
    SELECT ti.*, ip.policy, ip.security_level, ip.id as policy_id, ip.version as policy_version
    FROM terminal_integrations ti
    LEFT JOIN integration_policies ip ON ti.active_policy_id = ip.id AND ip.terminal_integration_id = ti.id
    WHERE ti.terminal_id = ? AND ti.provider = ? AND ti.deleted_at IS NULL
  `).bind(terminalId, provider).first();
  if (!ti) {
    return Response.json(
      { error: "NOT_ATTACHED", reason: `${provider} not attached to this terminal` },
      { status: 403 }
    );
  }
  if (ti.dashboard_id !== dashboardId || ti.user_id !== userId) {
    return Response.json(
      { error: "AUTH_DENIED", reason: "Dashboard mismatch" },
      { status: 403 }
    );
  }
  if (!ti.active_policy_id || !ti.policy) {
    return Response.json(
      { error: "POLICY_DENIED", reason: "No policy configured" },
      { status: 403 }
    );
  }
  const policy = JSON.parse(ti.policy);
  const policyId = ti.policy_id;
  const policyVersion = ti.policy_version;
  const rateLimitResult = await checkRateLimit2(env, ti.id, provider, body.action, policy);
  if (!rateLimitResult.allowed) {
    await logAuditEntry2(env, {
      terminalIntegrationId: ti.id,
      terminalId,
      dashboardId,
      userId,
      provider,
      action: body.action,
      policyId,
      policyVersion,
      decision: "denied",
      denialReason: rateLimitResult.reason
    });
    return Response.json(
      {
        allowed: false,
        decision: "denied",
        reason: rateLimitResult.reason,
        policyId,
        policyVersion
      },
      { status: 429 }
    );
  }
  const derivedContext = deriveEnforcementContext(body.action, body.args);
  const MESSAGING_PROVIDERS = /* @__PURE__ */ new Set(["slack", "discord", "telegram", "whatsapp", "teams", "matrix", "google_chat"]);
  let prefetchedAccessToken = null;
  if (MESSAGING_PROVIDERS.has(provider) && derivedContext.channelId && !derivedContext.channelName) {
    if (ti.user_integration_id) {
      prefetchedAccessToken = await getAccessToken(env, ti.user_integration_id, provider);
      if (prefetchedAccessToken) {
        const resolvedName = await resolveOutboundChannelName(provider, derivedContext.channelId, prefetchedAccessToken);
        if (resolvedName) {
          derivedContext.channelName = resolvedName;
        }
      }
    }
  }
  const enforcement = await enforcePolicy(env, provider, body.action, policy, ti.id, derivedContext);
  if (!enforcement.allowed) {
    await logAuditEntry2(env, {
      terminalIntegrationId: ti.id,
      terminalId,
      dashboardId,
      userId,
      provider,
      action: body.action,
      policyId,
      policyVersion,
      decision: enforcement.decision,
      denialReason: enforcement.reason
    });
    return Response.json(
      {
        allowed: false,
        decision: enforcement.decision,
        reason: enforcement.reason,
        policyId,
        policyVersion
      },
      { status: 403 }
    );
  }
  if (provider === "browser") {
    await logAuditEntry2(env, {
      terminalIntegrationId: ti.id,
      terminalId,
      dashboardId,
      userId,
      provider,
      action: body.action,
      policyId,
      policyVersion,
      decision: "allowed"
    });
    return Response.json({
      allowed: true,
      decision: "allowed",
      filteredResponse: null,
      policyId,
      policyVersion
    });
  }
  if (provider === "google_drive" && body.action === "drive.sync_config") {
    const mirror = await env.DB.prepare(`
      SELECT folder_id, folder_name FROM drive_mirrors WHERE dashboard_id = ?
    `).bind(dashboardId).first();
    await logAuditEntry2(env, {
      terminalIntegrationId: ti.id,
      terminalId,
      dashboardId,
      userId,
      provider,
      action: body.action,
      policyId,
      policyVersion,
      decision: "allowed"
    });
    return Response.json({
      allowed: true,
      decision: "allowed",
      filteredResponse: {
        folderId: mirror?.folder_id || "",
        folderName: mirror?.folder_name || ""
      },
      policyId,
      policyVersion
    });
  }
  if (!ti.user_integration_id) {
    return Response.json(
      { error: "AUTH_DENIED", reason: "OAuth connection not found" },
      { status: 403 }
    );
  }
  const accessToken = prefetchedAccessToken ?? await getAccessToken(env, ti.user_integration_id, provider);
  if (!accessToken) {
    return Response.json(
      { error: "AUTH_DENIED", reason: "OAuth token expired. Reconnect required." },
      { status: 403 }
    );
  }
  const DRIVE_ACTIONS_NEEDING_PRECHECK = /* @__PURE__ */ new Set([
    "drive.download",
    "drive.update",
    "drive.share",
    "drive.delete"
  ]);
  if (provider === "google_drive" && DRIVE_ACTIONS_NEEDING_PRECHECK.has(body.action)) {
    const fileId = body.args.fileId;
    if (fileId) {
      let metadata;
      try {
        metadata = await executeDriveAction("drive.get", { fileId }, accessToken);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Unknown error";
        await logAuditEntry2(env, {
          terminalIntegrationId: ti.id,
          terminalId,
          dashboardId,
          userId,
          provider,
          action: body.action,
          resourceId: fileId,
          policyId,
          policyVersion,
          decision: "denied",
          denialReason: `Action denied: metadata fetch failed (${errorMessage})`
        });
        return Response.json({
          allowed: false,
          decision: "denied",
          reason: `Action denied: unable to verify file against policy`,
          policyId,
          policyVersion
        }, { status: 403 });
      }
      const metadataFilter = filterResponse("google_drive", "drive.get", metadata, policy);
      if (metadataFilter.filtered && metadataFilter.data === null) {
        await logAuditEntry2(env, {
          terminalIntegrationId: ti.id,
          terminalId,
          dashboardId,
          userId,
          provider,
          action: body.action,
          resourceId: fileId,
          policyId,
          policyVersion,
          decision: "denied",
          denialReason: "File filtered by policy (folder/filetype restriction)"
        });
        return Response.json({
          allowed: false,
          decision: "denied",
          reason: "File filtered by policy (folder/filetype restriction)",
          policyId,
          policyVersion
        }, { status: 403 });
      }
    }
  }
  if (provider === "discord") {
    const discordMeta = await env.DB.prepare(`
      SELECT metadata FROM user_integrations WHERE id = ?
    `).bind(ti.user_integration_id).first();
    if (discordMeta?.metadata) {
      try {
        const meta = JSON.parse(discordMeta.metadata);
        if (meta.guild_id && !body.args.guild_id) {
          body.args.guild_id = meta.guild_id;
        }
      } catch {
      }
    }
  }
  let apiResponse;
  try {
    apiResponse = await executeProviderAPI(provider, body.action, body.args, accessToken);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    console.error(`[gateway] API error for ${provider}/${body.action}:`, errorMessage);
    await logAuditEntry2(env, {
      terminalIntegrationId: ti.id,
      terminalId,
      dashboardId,
      userId,
      provider,
      action: body.action,
      policyId,
      policyVersion,
      decision: "denied",
      denialReason: `API error: ${errorMessage}`
    });
    return Response.json(
      { error: "API_ERROR", reason: errorMessage },
      { status: 502 }
    );
  }
  const filterResult = filterResponse(provider, body.action, apiResponse, policy);
  const formattedData = formatResponseForLLM(provider, body.action, filterResult.data);
  await logAuditEntry2(env, {
    terminalIntegrationId: ti.id,
    terminalId,
    dashboardId,
    userId,
    provider,
    action: body.action,
    policyId,
    policyVersion,
    decision: filterResult.filtered ? "filtered" : "allowed"
  });
  return Response.json({
    allowed: true,
    decision: filterResult.filtered ? "filtered" : "allowed",
    filteredResponse: formattedData,
    policyId,
    policyVersion
  });
}
async function handleListTerminalIntegrations(request, env, ptyId) {
  console.log(`[gateway] ListTerminalIntegrations: ptyId=${ptyId}`);
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    console.log(`[gateway] ListTerminalIntegrations: missing Authorization header`);
    return Response.json(
      { error: "AUTH_DENIED", reason: "Missing Authorization header" },
      { status: 401 }
    );
  }
  const ptyToken = authHeader.slice(7);
  const claims = await verifyPtyToken(ptyToken, env.INTERNAL_API_TOKEN);
  if (!claims) {
    console.log(`[gateway] ListTerminalIntegrations: invalid/expired PTY token (len=${ptyToken.length})`);
    return Response.json(
      { error: "AUTH_DENIED", reason: "Invalid or expired PTY token" },
      { status: 401 }
    );
  }
  console.log(`[gateway] ListTerminalIntegrations: claims.terminal_id=${claims.terminal_id} dashboard_id=${claims.dashboard_id}`);
  if (claims.terminal_id !== ptyId) {
    console.log(`[gateway] ListTerminalIntegrations: PTY ID mismatch token.terminal_id=${claims.terminal_id} url.ptyId=${ptyId}`);
    return Response.json(
      { error: "AUTH_DENIED", reason: "PTY ID mismatch" },
      { status: 403 }
    );
  }
  const integrations = await env.DB.prepare(`
    SELECT provider, active_policy_id, account_email
    FROM terminal_integrations
    WHERE terminal_id = ? AND deleted_at IS NULL
  `).bind(ptyId).all();
  console.log(`[gateway] ListTerminalIntegrations: found ${integrations.results.length} integrations for ptyId=${ptyId}`);
  for (const row of integrations.results) {
    console.log(`[gateway] ListTerminalIntegrations: provider=${row.provider} active_policy_id=${row.active_policy_id ?? "NULL"}`);
  }
  return Response.json({
    integrations: integrations.results.map((row) => ({
      provider: row.provider,
      activePolicyId: row.active_policy_id,
      accountEmail: row.account_email
    }))
  });
}
function formatResponseForLLM(provider, action, data) {
  if (provider === "gmail") {
    return formatGmailForLLM(action, data);
  }
  return data;
}
function formatGmailForLLM(action, data) {
  if (!action.includes("search") && !action.includes("list") && action !== "gmail.get") {
    return data;
  }
  if (Array.isArray(data)) {
    return data.map((msg) => formatSingleGmailMessage(msg));
  }
  if (data && typeof data === "object" && "id" in data) {
    return formatSingleGmailMessage(data);
  }
  return data;
}
function formatSingleGmailMessage(msg) {
  const headers = msg.payload?.headers || [];
  const getHeader = /* @__PURE__ */ __name((name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value, "getHeader");
  let bodyText = extractMessageBody(msg.payload);
  const MAX_BODY_LENGTH = 4096;
  if (bodyText.length > MAX_BODY_LENGTH) {
    bodyText = bodyText.slice(0, MAX_BODY_LENGTH) + "\n[... truncated]";
  }
  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds,
    from: getHeader("from"),
    to: getHeader("to"),
    cc: getHeader("cc"),
    subject: getHeader("subject"),
    date: getHeader("date"),
    snippet: msg.snippet,
    body: bodyText
  };
}
function cleanBodyUrls(text) {
  return text.replace(/^\s*https?:\/\/\S+\s*$/gm, "").replace(/https?:\/\/\S{80,}/g, "").replace(/\n{3,}/g, "\n\n").trim();
}
function extractMessageBody(payload) {
  if (!payload)
    return "";
  const plainText = findBodyByMimeType(payload, "text/plain");
  if (plainText)
    return cleanBodyUrls(plainText);
  const htmlText = findBodyByMimeType(payload, "text/html");
  if (htmlText)
    return cleanBodyUrls(stripHtml(htmlText));
  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data);
    if (payload.mimeType === "text/html")
      return cleanBodyUrls(stripHtml(decoded));
    return cleanBodyUrls(decoded);
  }
  return "";
}
function findBodyByMimeType(payload, targetMime) {
  if (payload.mimeType === targetMime && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const result = findBodyByMimeType(part, targetMime);
      if (result)
        return result;
    }
  }
  return void 0;
}
function decodeBase64Url(data) {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return atob(base64);
  } catch {
    return data;
  }
}
function stripHtml(html) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<img[^>]*(?:width\s*=\s*["']1["']|height\s*=\s*["']1["'])[^>]*>/gi, "").replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, " ").replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec))).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
var init_gateway = __esm({
  "src/integration-policies/gateway.ts"() {
    "use strict";
    init_pty_token();
    init_handler3();
    init_response_filter();
    init_gmail();
    init_github();
    init_drive();
    init_calendar();
    init_slack();
    init_discord();
    console.log(`[integration-gateway] REVISION: gateway-v21-discord-inject-guild-id loaded at ${(/* @__PURE__ */ new Date()).toISOString()}`);
    __name(extractEmailDomain2, "extractEmailDomain");
    __name(extractEmailAddress2, "extractEmailAddress");
    __name(deriveEnforcementContext, "deriveEnforcementContext");
    __name(resolveOutboundChannelName, "resolveOutboundChannelName");
    __name(getActionCategory2, "getActionCategory");
    __name(checkRateLimit2, "checkRateLimit");
    __name(logAuditEntry2, "logAuditEntry");
    __name(getAccessToken, "getAccessToken");
    __name(refreshOAuthToken, "refreshOAuthToken");
    __name(executeProviderAPI, "executeProviderAPI");
    __name(handleGatewayExecute, "handleGatewayExecute");
    __name(handleListTerminalIntegrations, "handleListTerminalIntegrations");
    __name(formatResponseForLLM, "formatResponseForLLM");
    __name(formatGmailForLLM, "formatGmailForLLM");
    __name(formatSingleGmailMessage, "formatSingleGmailMessage");
    __name(cleanBodyUrls, "cleanBodyUrls");
    __name(extractMessageBody, "extractMessageBody");
    __name(findBodyByMimeType, "findBodyByMimeType");
    __name(decodeBase64Url, "decodeBase64Url");
    __name(stripHtml, "stripHtml");
  }
});

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
init_dashboard_token();
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
async function validateMcpAuth(request, env) {
  const internalToken = request.headers.get("X-Internal-Token");
  if (internalToken) {
    if (!env.INTERNAL_API_TOKEN) {
      return {
        isValid: false,
        isFullAccess: false,
        error: Response.json(
          { error: "E79402: Internal API not configured" },
          { status: 503 }
        )
      };
    }
    if (internalToken === env.INTERNAL_API_TOKEN) {
      return { isValid: true, isFullAccess: true };
    }
  }
  const dashboardToken = request.headers.get("X-Dashboard-Token");
  if (dashboardToken) {
    if (!env.INTERNAL_API_TOKEN) {
      return {
        isValid: false,
        isFullAccess: false,
        error: Response.json(
          { error: "E79402: Internal API not configured" },
          { status: 503 }
        )
      };
    }
    const claims = await verifyDashboardToken(dashboardToken, env.INTERNAL_API_TOKEN);
    if (claims) {
      return {
        isValid: true,
        isFullAccess: false,
        dashboardId: claims.dashboard_id,
        sessionId: claims.session_id
      };
    }
  }
  return {
    isValid: false,
    isFullAccess: false,
    error: Response.json(
      { error: "E79403: Invalid or missing MCP token" },
      { status: 401 }
    )
  };
}
__name(validateMcpAuth, "validateMcpAuth");

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
  if (env.DEV_AUTH_ENABLED === "true") {
    return { allowed: true };
  }
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
  if (env.DEV_AUTH_ENABLED === "true") {
    return { allowed: true };
  }
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
async function checkRat\u0435LimitByKey(key, env) {
  if (env.DEV_AUTH_ENABLED === "true") {
    return { allowed: true };
  }
  if (!env.RATE_LIMITER) {
    return { allowed: true };
  }
  return applyRateLimit(
    env.RATE_LIMITER,
    key,
    "Rate limit exceeded for this operation."
  );
}
__name(checkRat\u0435LimitByKey, "checkRat\u0435LimitByKey");

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
  type TEXT NOT NULL CHECK (type IN ('note', 'todo', 'terminal', 'link', 'browser', 'workspace', 'prompt', 'schedule', 'gmail', 'calendar', 'contacts', 'sheets', 'forms', 'slack', 'discord', 'telegram', 'whatsapp', 'teams', 'matrix', 'google_chat')),
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
-- type='secret' \u2192 brokered (for API keys, credentials)
-- type='env_var' \u2192 set directly (for regular config)
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
  CHECK (provider = 'browser' OR user_integration_id IS NOT NULL)
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
-- Unique per block + provider + channel (allows multi-channel per block).
-- Telegram uses chat_id instead of channel_id, but COALESCE ensures the
-- uniqueness column is never NULL (SQLite ignores NULL in unique indexes).
CREATE UNIQUE INDEX IF NOT EXISTS idx_messaging_subs_active_channel
  ON messaging_subscriptions(dashboard_id, item_id, provider, COALESCE(channel_id, chat_id))
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
`;
var SCHEMA_REVISION = "messaging-v3-fix-init-order";
async function initializeDatabase(db) {
  console.log(`[schema] REVISION: ${SCHEMA_REVISION} loaded at ${(/* @__PURE__ */ new Date()).toISOString()}`);
  const statements = SCHEMA.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
  const isCreateTable = /* @__PURE__ */ __name((s) => /CREATE\s+TABLE/i.test(s), "isCreateTable");
  const tableStatements = statements.filter(isCreateTable);
  const indexStatements = statements.filter((s) => !isCreateTable(s));
  for (const statement of tableStatements) {
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
  try {
    await db.prepare(`
      ALTER TABLE user_secrets ADD COLUMN encrypted_at TEXT
    `).run();
  } catch {
  }
  try {
    await db.prepare(`
      ALTER TABLE user_secrets ADD COLUMN broker_protected INTEGER NOT NULL DEFAULT 1
    `).run();
  } catch {
  }
  try {
    await db.prepare(`
      ALTER TABLE user_secrets ADD COLUMN type TEXT NOT NULL DEFAULT 'secret'
    `).run();
  } catch {
  }
  try {
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_user_secrets_type ON user_secrets(type)
    `).run();
  } catch {
  }
  try {
    await db.prepare(`
      ALTER TABLE dashboard_sandboxes ADD COLUMN applied_secret_names TEXT NOT NULL DEFAULT '[]'
    `).run();
  } catch {
  }
  try {
    await db.prepare(`
      ALTER TABLE dashboard_items ADD COLUMN metadata TEXT
    `).run();
  } catch {
  }
  await migrateDashboardItemTypes(db);
  await migrateUserIntegrationProviders(db);
  await migrateTerminalIntegrationProviders(db);
  try {
    await db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_terminal_integrations_unique_active
        ON terminal_integrations(terminal_id, provider)
        WHERE deleted_at IS NULL
    `).run();
  } catch {
  }
  try {
    await db.prepare(`
      ALTER TABLE dashboard_templates ADD COLUMN viewport_json TEXT
    `).run();
  } catch {
  }
  try {
    await db.prepare(`
      ALTER TABLE dashboard_templates ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'
    `).run();
  } catch {
  }
  try {
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_templates_status ON dashboard_templates(status)
    `).run();
  } catch {
  }
  try {
    await db.prepare(`
      ALTER TABLE terminal_integrations ADD COLUMN item_id TEXT
    `).run();
  } catch {
  }
  try {
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_terminal_integrations_item ON terminal_integrations(item_id)
    `).run();
  } catch {
  }
  try {
    await db.prepare(`
      UPDATE terminal_integrations SET item_id = (
        SELECT s.item_id FROM sessions s WHERE s.pty_id = terminal_integrations.terminal_id
        ORDER BY s.created_at DESC LIMIT 1
      ) WHERE item_id IS NULL
    `).run();
  } catch {
  }
  await migrateSchedulesTable(db);
  for (const statement of indexStatements) {
    await db.prepare(statement).run();
  }
}
__name(initializeDatabase, "initializeDatabase");
var INTEGRATION_PROVIDERS = ["google_drive", "github", "gmail", "google_calendar", "google_contacts", "google_sheets", "google_forms", "box", "onedrive", "slack", "discord", "telegram", "whatsapp", "teams", "matrix", "google_chat"];
var TERMINAL_INTEGRATION_PROVIDERS = [...INTEGRATION_PROVIDERS, "browser"];
async function migrateUserIntegrationProviders(db) {
  const tableInfo = await db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_integrations'
  `).first();
  if (!tableInfo?.sql) {
    return;
  }
  const allProvidersPresent = INTEGRATION_PROVIDERS.every((provider) => tableInfo.sql.includes(`'${provider}'`));
  const hasRequiredColumns = tableInfo.sql.includes("scope TEXT");
  if (allProvidersPresent && hasRequiredColumns) {
    return;
  }
  const providerList = INTEGRATION_PROVIDERS.map((p) => `'${p}'`).join(", ");
  await db.prepare(`PRAGMA foreign_keys=OFF`).run();
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
  const oldColumns = await db.prepare(`PRAGMA table_info(user_integrations)`).all();
  const oldColumnNames = new Set((oldColumns.results || []).map((c) => c.name));
  const allNewColumns = ["id", "user_id", "provider", "access_token", "refresh_token", "scope", "token_type", "expires_at", "metadata", "created_at", "updated_at"];
  const columnsToCopy = allNewColumns.filter((c) => oldColumnNames.has(c));
  const columnList = columnsToCopy.join(", ");
  await db.prepare(`
    INSERT INTO user_integrations_new (${columnList})
    SELECT ${columnList} FROM user_integrations
  `).run();
  await db.prepare(`DROP TABLE user_integrations`).run();
  await db.prepare(`ALTER TABLE user_integrations_new RENAME TO user_integrations`).run();
  await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_integrations_user_provider ON user_integrations(user_id, provider)`).run();
  await db.prepare(`PRAGMA foreign_keys=ON`).run();
}
__name(migrateUserIntegrationProviders, "migrateUserIntegrationProviders");
async function migrateSchedulesTable(db) {
  const tableInfo = await db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schedules'
  `).first();
  if (!tableInfo?.sql) {
    return;
  }
  if (tableInfo.sql.includes("dashboard_item_id")) {
    return;
  }
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
__name(migrateSchedulesTable, "migrateSchedulesTable");
var DASHBOARD_ITEM_TYPES = ["note", "todo", "terminal", "link", "browser", "workspace", "prompt", "schedule", "gmail", "calendar", "contacts", "sheets", "forms", "slack", "discord", "telegram", "whatsapp", "teams", "matrix", "google_chat"];
async function migrateDashboardItemTypes(db) {
  const tableInfo = await db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dashboard_items'
  `).first();
  if (!tableInfo?.sql) {
    return;
  }
  const allTypesPresent = DASHBOARD_ITEM_TYPES.every((type) => tableInfo.sql.includes(`'${type}'`));
  if (allTypesPresent) {
    return;
  }
  const typeList = DASHBOARD_ITEM_TYPES.map((t) => `'${t}'`).join(", ");
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
__name(migrateDashboardItemTypes, "migrateDashboardItemTypes");
async function migrateTerminalIntegrationProviders(db) {
  const tableInfo = await db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'terminal_integrations'
  `).first();
  if (!tableInfo?.sql) {
    return;
  }
  const allProvidersPresent = TERMINAL_INTEGRATION_PROVIDERS.every((provider) => tableInfo.sql.includes(`'${provider}'`));
  if (allProvidersPresent) {
    return;
  }
  const providerList = TERMINAL_INTEGRATION_PROVIDERS.map((p) => `'${p}'`).join(", ");
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
      CHECK (provider = 'browser' OR user_integration_id IS NOT NULL)
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
__name(migrateTerminalIntegrationProviders, "migrateTerminalIntegrationProviders");

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

// src/index.ts
init_drive_cache();

// src/templates/scrubber.ts
function safeParseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
__name(safeParseJson, "safeParseJson");
function scrubItemContent(type, content) {
  try {
    switch (type) {
      case "note": {
        return "";
      }
      case "todo": {
        const parsed = safeParseJson(content);
        if (parsed && typeof parsed === "object") {
          const items = Array.isArray(parsed.items) ? parsed.items : [];
          const scrubbedItems = items.map(
            (item, i) => ({
              id: `todo_${i}`,
              text: "",
              // Clear the text
              completed: item?.completed || false
            })
          );
          return JSON.stringify({
            title: "",
            // Clear the title
            items: scrubbedItems
          });
        }
        return JSON.stringify({ title: "", items: [] });
      }
      case "terminal": {
        const parsed = safeParseJson(content);
        if (parsed && typeof parsed === "object") {
          return JSON.stringify({
            name: parsed.name || "Terminal",
            agentic: parsed.agentic ?? false,
            bootCommand: parsed.bootCommand || "",
            // Clear user-specific attachments - will be empty on import
            subagentIds: [],
            skillIds: [],
            mcpToolIds: []
          });
        }
        return JSON.stringify({ name: "Terminal", agentic: false, bootCommand: "" });
      }
      case "recipe": {
        const parsed = safeParseJson(content);
        if (parsed && typeof parsed === "object") {
          const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
          const scrubbedSteps = steps.map(
            (step, i) => ({
              id: `step_${i}`,
              type: step?.type || "run_agent",
              name: step?.name || `Step ${i + 1}`,
              config: {},
              // Clear config which may contain secrets
              nextStepId: null,
              onError: "fail"
            })
          );
          return JSON.stringify({
            title: parsed.title || "Recipe",
            description: "",
            // Clear description
            steps: scrubbedSteps
          });
        }
        return JSON.stringify({ title: "Recipe", description: "", steps: [] });
      }
      case "link": {
        const parsed = safeParseJson(content);
        if (parsed && typeof parsed === "object") {
          return JSON.stringify({
            url: parsed.url || "",
            title: parsed.title || "",
            description: "",
            // Clear private description
            favicon: parsed.favicon || ""
          });
        }
        return content;
      }
      case "browser": {
        return content;
      }
      case "workspace": {
        return content;
      }
      case "prompt": {
        return content;
      }
      case "schedule": {
        const parsed = safeParseJson(content);
        if (parsed && typeof parsed === "object") {
          return JSON.stringify({
            name: "",
            // Clear name
            cron: parsed.cron || "",
            // Keep cron pattern (not sensitive)
            eventTrigger: "",
            // Clear event trigger
            enabled: parsed.enabled ?? true
          });
        }
        return JSON.stringify({ name: "", cron: "", eventTrigger: "", enabled: true });
      }
      default:
        return "";
    }
  } catch {
    return "";
  }
}
__name(scrubItemContent, "scrubItemContent");

// src/templates/handler.ts
var migrated = false;
async function ensureTemplateColumns(env) {
  if (migrated)
    return;
  try {
    await env.DB.prepare(
      `ALTER TABLE dashboard_templates ADD COLUMN viewport_json TEXT`
    ).run();
  } catch {
  }
  try {
    await env.DB.prepare(
      `ALTER TABLE dashboard_templates ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'`
    ).run();
  } catch {
  }
  migrated = true;
}
__name(ensureTemplateColumns, "ensureTemplateColumns");
function generateId() {
  return crypto.randomUUID();
}
__name(generateId, "generateId");
function formatTemplate(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    previewImageUrl: row.preview_image_url || void 0,
    authorId: row.author_id,
    authorName: row.author_name,
    itemCount: row.item_count,
    isFeatured: row.is_featured === 1,
    useCount: row.use_count,
    status: row.status || "approved",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
__name(formatTemplate, "formatTemplate");
function formatTemplateWithData(row) {
  const base = formatTemplate(row);
  const viewport = row.viewport_json ? JSON.parse(row.viewport_json) : void 0;
  return {
    ...base,
    items: JSON.parse(row.items_json || "[]"),
    edges: JSON.parse(row.edges_json || "[]"),
    ...viewport && { viewport }
  };
}
__name(formatTemplateWithData, "formatTemplateWithData");
async function listTemplates(env, category, isAdmin = false) {
  await ensureTemplateColumns(env);
  let query = `SELECT * FROM dashboard_templates`;
  const conditions = [];
  const bindings = [];
  if (!isAdmin) {
    conditions.push("status = 'approved'");
  }
  if (category && category !== "all") {
    conditions.push("category = ?");
    bindings.push(category);
  }
  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }
  query += " ORDER BY is_featured DESC, use_count DESC, created_at DESC";
  const result = await env.DB.prepare(query).bind(...bindings).all();
  const templates = result.results.map(formatTemplate);
  return Response.json({ templates });
}
__name(listTemplates, "listTemplates");
async function getTemplate(env, templateId) {
  const row = await env.DB.prepare(
    `SELECT * FROM dashboard_templates WHERE id = ?`
  ).bind(templateId).first();
  if (!row) {
    return Response.json(
      { error: "E79801: Template not found" },
      { status: 404 }
    );
  }
  return Response.json({ template: formatTemplateWithData(row) });
}
__name(getTemplate, "getTemplate");
async function createTemplate(env, userId, data) {
  await ensureTemplateColumns(env);
  const access = await env.DB.prepare(
    `
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `
  ).bind(data.dashboardId, userId).first();
  if (!access) {
    return Response.json(
      { error: "E79802: Dashboard not found or no access" },
      { status: 404 }
    );
  }
  const itemRows = await env.DB.prepare(
    `SELECT * FROM dashboard_items WHERE dashboard_id = ?`
  ).bind(data.dashboardId).all();
  const edgeRows = await env.DB.prepare(
    `SELECT * FROM dashboard_edges WHERE dashboard_id = ?`
  ).bind(data.dashboardId).all();
  const idToPlaceholder = /* @__PURE__ */ new Map();
  const templateItems = [];
  itemRows.results.forEach((row, index) => {
    const placeholderId = `item_${index}`;
    idToPlaceholder.set(row.id, placeholderId);
    const rawMetadata = row.metadata ? typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata : void 0;
    const item = {
      placeholderId,
      type: row.type,
      content: scrubItemContent(
        row.type,
        row.content
      ),
      position: {
        x: row.position_x,
        y: row.position_y
      },
      size: {
        width: row.width,
        height: row.height
      }
    };
    if (rawMetadata) {
      item.metadata = rawMetadata;
    }
    templateItems.push(item);
  });
  const templateEdges = edgeRows.results.filter(
    (row) => idToPlaceholder.has(row.source_item_id) && idToPlaceholder.has(row.target_item_id)
  ).map((row) => ({
    sourcePlaceholderId: idToPlaceholder.get(row.source_item_id),
    targetPlaceholderId: idToPlaceholder.get(row.target_item_id),
    sourceHandle: row.source_handle || void 0,
    targetHandle: row.target_handle || void 0
  }));
  const user = await env.DB.prepare(`SELECT name FROM users WHERE id = ?`).bind(userId).first();
  const validCategories = ["coding", "automation", "documentation", "custom"];
  const category = validCategories.includes(data.category || "") ? data.category : "custom";
  const templateId = generateId();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare(
    `
    INSERT INTO dashboard_templates
    (id, name, description, category, author_id, author_name,
     items_json, edges_json, viewport_json, item_count, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).bind(
    templateId,
    data.name,
    data.description || "",
    category,
    userId,
    user?.name || "Unknown",
    JSON.stringify(templateItems),
    JSON.stringify(templateEdges),
    data.viewport ? JSON.stringify(data.viewport) : null,
    templateItems.length,
    "pending_review",
    now,
    now
  ).run();
  return Response.json(
    {
      template: {
        id: templateId,
        name: data.name,
        description: data.description || "",
        category,
        itemCount: templateItems.length,
        status: "pending_review"
      }
    },
    { status: 201 }
  );
}
__name(createTemplate, "createTemplate");
async function deleteTemplate(env, userId, templateId, isAdmin = false) {
  const template = await env.DB.prepare(
    `SELECT author_id FROM dashboard_templates WHERE id = ?`
  ).bind(templateId).first();
  if (!template) {
    return Response.json(
      { error: "E79803: Template not found" },
      { status: 404 }
    );
  }
  if (!isAdmin && template.author_id !== userId) {
    return Response.json(
      { error: "E79804: Not authorized to delete this template" },
      { status: 403 }
    );
  }
  await env.DB.prepare(`DELETE FROM dashboard_templates WHERE id = ?`).bind(templateId).run();
  return new Response(null, { status: 204 });
}
__name(deleteTemplate, "deleteTemplate");
async function approveTemplate(env, templateId, newStatus) {
  if (newStatus !== "approved" && newStatus !== "rejected") {
    return Response.json(
      { error: 'E79805: Invalid status. Must be "approved" or "rejected"' },
      { status: 400 }
    );
  }
  const template = await env.DB.prepare(
    `SELECT id, name FROM dashboard_templates WHERE id = ?`
  ).bind(templateId).first();
  if (!template) {
    return Response.json(
      { error: "E79806: Template not found" },
      { status: 404 }
    );
  }
  await env.DB.prepare(
    `UPDATE dashboard_templates SET status = ?, updated_at = ? WHERE id = ?`
  ).bind(newStatus, (/* @__PURE__ */ new Date()).toISOString(), templateId).run();
  return Response.json({ template: { id: templateId, status: newStatus } });
}
__name(approveTemplate, "approveTemplate");
async function populateFromTemplate(env, dashboardId, templateId) {
  const template = await env.DB.prepare(
    `SELECT items_json, edges_json, viewport_json FROM dashboard_templates WHERE id = ?`
  ).bind(templateId).first();
  if (!template)
    return;
  const items = JSON.parse(template.items_json);
  const edges = JSON.parse(template.edges_json);
  const placeholderToRealId = /* @__PURE__ */ new Map();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  for (const item of items) {
    const newId = generateId();
    placeholderToRealId.set(item.placeholderId, newId);
    await env.DB.prepare(
      `
      INSERT INTO dashboard_items
      (id, dashboard_id, type, content, position_x, position_y, width, height, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).bind(
      newId,
      dashboardId,
      item.type,
      item.content,
      item.position.x,
      item.position.y,
      item.size.width,
      item.size.height,
      item.metadata ? JSON.stringify(item.metadata) : null,
      now,
      now
    ).run();
  }
  for (const edge of edges) {
    const sourceId = placeholderToRealId.get(edge.sourcePlaceholderId);
    const targetId = placeholderToRealId.get(edge.targetPlaceholderId);
    if (sourceId && targetId) {
      await env.DB.prepare(
        `
        INSERT INTO dashboard_edges
        (id, dashboard_id, source_item_id, target_item_id, source_handle, target_handle, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).bind(
        generateId(),
        dashboardId,
        sourceId,
        targetId,
        edge.sourceHandle || null,
        edge.targetHandle || null,
        now,
        now
      ).run();
    }
  }
  await env.DB.prepare(
    `UPDATE dashboard_templates SET use_count = use_count + 1 WHERE id = ?`
  ).bind(templateId).run();
  const viewport = template.viewport_json ? JSON.parse(template.viewport_json) : void 0;
  return { viewport };
}
__name(populateFromTemplate, "populateFromTemplate");

// src/dashboards/handler.ts
function generateId3() {
  return crypto.randomUUID();
}
__name(generateId3, "generateId");
function f\u043ErmatDashb\u043Eard(row) {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    secretsCount: row.secrets_count !== void 0 ? Number(row.secrets_count) : void 0
  };
}
__name(f\u043ErmatDashb\u043Eard, "f\u043ErmatDashb\u043Eard");
function formatItem(row) {
  let metadata;
  if (row.metadata && typeof row.metadata === "string") {
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      metadata = void 0;
    }
  }
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
    metadata,
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
    SELECT d.*,
      (SELECT COUNT(*) FROM user_secrets us WHERE us.dashboard_id = d.id AND us.user_id = ?) as secrets_count
    FROM dashboards d
    JOIN dashboard_members dm ON d.id = dm.dashboard_id
    WHERE dm.user_id = ?
    ORDER BY d.updated_at DESC
  `).bind(userId, userId).all();
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
  const id = generateId3();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare(`
    INSERT INTO dashboards (id, name, owner_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(id, data.name, userId, now, now).run();
  await env.DB.prepare(`
    INSERT INTO dashboard_members (dashboard_id, user_id, role, added_at)
    VALUES (?, ?, 'owner', ?)
  `).bind(id, userId, now).run();
  let templateViewport;
  if (data.templateId) {
    const result = await populateFromTemplate(env, id, data.templateId);
    templateViewport = result?.viewport;
  }
  const dashboard = {
    id,
    name: data.name,
    ownerId: userId,
    createdAt: now,
    updatedAt: now
  };
  return Response.json({
    dashboard,
    ...templateViewport && { viewport: templateViewport }
  }, { status: 201 });
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
  const terminalIntegrations = await env.DB.prepare(`
    SELECT id FROM terminal_integrations WHERE dashboard_id = ?
  `).bind(dashboardId).all();
  if (terminalIntegrations.results.length > 0) {
    const tiIds = terminalIntegrations.results.map((ti) => ti.id);
    const placeholders = tiIds.map(() => "?").join(",");
    await env.DB.prepare(`
      DELETE FROM high_risk_confirmations WHERE terminal_integration_id IN (${placeholders})
    `).bind(...tiIds).run();
    await env.DB.prepare(`
      DELETE FROM integration_audit_log WHERE terminal_integration_id IN (${placeholders})
    `).bind(...tiIds).run();
    await env.DB.prepare(`
      DELETE FROM integration_policies WHERE terminal_integration_id IN (${placeholders})
    `).bind(...tiIds).run();
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
  const id = item.id || generateId3();
  const existing = await env.DB.prepare(`
    SELECT id FROM dashboard_items WHERE id = ? AND dashboard_id = ?
  `).bind(id, dashboardId).first();
  const metadataJson = item.metadata !== void 0 ? JSON.stringify(item.metadata) : null;
  if (existing) {
    await env.DB.prepare(`
      UPDATE dashboard_items SET
        content = COALESCE(?, content),
        position_x = COALESCE(?, position_x),
        position_y = COALESCE(?, position_y),
        width = COALESCE(?, width),
        height = COALESCE(?, height),
        metadata = COALESCE(?, metadata),
        updated_at = ?
      WHERE id = ?
    `).bind(
      item.content !== void 0 ? item.content : null,
      item.position?.x ?? null,
      item.position?.y ?? null,
      item.size?.width ?? null,
      item.size?.height ?? null,
      metadataJson,
      now,
      id
    ).run();
  } else {
    await env.DB.prepare(`
      INSERT INTO dashboard_items (id, dashboard_id, type, content, position_x, position_y, width, height, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      dashboardId,
      item.type || "note",
      item.content || "",
      item.position?.x ?? 0,
      item.position?.y ?? 0,
      item.size?.width ?? 200,
      item.size?.height ?? 150,
      metadataJson,
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
  try {
    const activeSessions = await env.DB.prepare(`
      SELECT id FROM sessions
      WHERE item_id = ? AND dashboard_id = ? AND status IN ('creating', 'active')
    `).bind(itemId, dashboardId).all();
    if (activeSessions.results.length > 0) {
      const { st\u043EpSessi\u043En: st\u043EpSessi\u043En2 } = await Promise.resolve().then(() => (init_handler2(), handler_exports2));
      for (const session of activeSessions.results) {
        await st\u043EpSessi\u043En2(env, session.id, userId);
      }
    }
  } catch {
  }
  const edgeRows = await env.DB.prepare(`
    SELECT id FROM dashboard_edges
    WHERE dashboard_id = ? AND (source_item_id = ? OR target_item_id = ?)
  `).bind(dashboardId, itemId, itemId).all();
  if (edgeRows.results.length > 0) {
    await env.DB.prepare(`
      DELETE FROM dashboard_edges
      WHERE dashboard_id = ? AND (source_item_id = ? OR target_item_id = ?)
    `).bind(dashboardId, itemId, itemId).run();
  }
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
  const id = generateId3();
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
async function sendUICommandResult(env, dashboardId, userId, result) {
  const membership = await env.DB.prepare(`
    SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first();
  const isOwner = await env.DB.prepare(`
    SELECT 1 FROM dashboards WHERE id = ? AND owner_id = ?
  `).bind(dashboardId, userId).first();
  if (!membership && !isOwner) {
    return Response.json({ error: "E79806: Not a member of this dashboard" }, { status: 403 });
  }
  const doId = env.DASHBOARD.idFromName(dashboardId);
  const stub = env.DASHBOARD.get(doId);
  await stub.fetch(new Request("http://do/ui-command-result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(result)
  }));
  return Response.json({ success: true });
}
__name(sendUICommandResult, "sendUICommandResult");

// src/index.ts
init_handler2();

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
  if (schedule.dashboard_id && !schedule.recipe_id) {
    const { hasAccess } = await checkDashb\u043EardAccess(env, schedule.dashboard_id, userId, requiredRole);
    return { hasAccess, schedule: hasAccess ? schedule : void 0 };
  }
  if (schedule.recipe_id) {
    const { hasAccess } = await checkRecip\u0435Access(env, schedule.recipe_id, userId, requiredRole);
    return { hasAccess, schedule: hasAccess ? schedule : void 0 };
  }
  return { hasAccess: false };
}
__name(checkSchedul\u0435Access, "checkSchedul\u0435Access");

// src/recipes/handler.ts
function generateId4() {
  return crypto.randomUUID();
}
__name(generateId4, "generateId");
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
  const id = generateId4();
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
  const id = generateId4();
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
  const id = generateId4();
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
var MODULE_REVISION2 = "server-side-cron-v1-edge-based-schedules";
console.log(`[schedules] REVISION: ${MODULE_REVISION2} loaded at ${(/* @__PURE__ */ new Date()).toISOString()}`);
function generateId6() {
  return crypto.randomUUID();
}
__name(generateId6, "generateId");
function formatSchedule(s) {
  return {
    id: s.id,
    recipeId: s.recipe_id || null,
    dashboardId: s.dashboard_id || null,
    dashboardItemId: s.dashboard_item_id || null,
    command: s.command || null,
    name: s.name,
    cron: s.cron || null,
    eventTrigger: s.event_trigger || null,
    enabled: Boolean(s.enabled),
    lastRunAt: s.last_run_at || null,
    nextRunAt: s.next_run_at || null,
    createdAt: s.created_at
  };
}
__name(formatSchedule, "formatSchedule");
function formatExecution(row) {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    status: row.status,
    triggeredBy: row.triggered_by,
    terminals: JSON.parse(row.terminals_json || "[]"),
    startedAt: row.started_at,
    completedAt: row.completed_at || null,
    error: row.error || null
  };
}
__name(formatExecution, "formatExecution");
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
async function listSchedules(env, userId, opts) {
  if (opts?.dashboardItemId) {
    const result2 = await env.DB.prepare(`
      SELECT * FROM schedules WHERE dashboard_item_id = ? ORDER BY created_at DESC
    `).bind(opts.dashboardItemId).all();
    const accessible = [];
    for (const s of result2.results) {
      if (!s.dashboard_id) {
        continue;
      }
      const { hasAccess } = await checkDashb\u043EardAccess(env, s.dashboard_id, userId, "viewer");
      if (!hasAccess) {
        return Response.json({ error: "E79725: No access" }, { status: 404 });
      }
      accessible.push(s);
    }
    return Response.json({ schedules: accessible.map(formatSchedule) });
  }
  if (opts?.recipeId) {
    const { hasAccess } = await checkRecip\u0435Access(env, opts.recipeId, userId, "viewer");
    if (!hasAccess) {
      return Response.json({ error: "E79725: Recipe not found or no access" }, { status: 404 });
    }
    const result2 = await env.DB.prepare(`
      SELECT * FROM schedules WHERE recipe_id = ? ORDER BY created_at DESC
    `).bind(opts.recipeId).all();
    return Response.json({ schedules: result2.results.map(formatSchedule) });
  }
  if (opts?.dashboardId) {
    const { hasAccess } = await checkDashb\u043EardAccess(env, opts.dashboardId, userId, "viewer");
    if (!hasAccess) {
      return Response.json({ error: "E79725: Dashboard not found or no access" }, { status: 404 });
    }
    const result2 = await env.DB.prepare(`
      SELECT * FROM schedules
      WHERE dashboard_id = ?
         OR recipe_id IN (SELECT id FROM recipes WHERE dashboard_id = ?)
      ORDER BY created_at DESC
    `).bind(opts.dashboardId, opts.dashboardId).all();
    return Response.json({ schedules: result2.results.map(formatSchedule) });
  }
  const result = await env.DB.prepare(`
    SELECT s.* FROM schedules s
    LEFT JOIN recipes r ON s.recipe_id = r.id
    INNER JOIN dashboard_members dm ON COALESCE(s.dashboard_id, r.dashboard_id) = dm.dashboard_id
    WHERE dm.user_id = ?
    ORDER BY s.created_at DESC
  `).bind(userId).all();
  return Response.json({ schedules: result.results.map(formatSchedule) });
}
__name(listSchedules, "listSchedules");
async function getSchedule(env, scheduleId, userId) {
  const { hasAccess, schedule } = await checkSchedul\u0435Access(env, scheduleId, userId, "viewer");
  if (!hasAccess || !schedule) {
    return Response.json({ error: "E79726: Schedule not found or no access" }, { status: 404 });
  }
  return Response.json({ schedule: formatSchedule(schedule) });
}
__name(getSchedule, "getSchedule");
async function createSchedule(env, userId, data) {
  if (!data.recipeId && !data.dashboardItemId) {
    return Response.json({ error: "E79740: Either recipeId or dashboardItemId required" }, { status: 400 });
  }
  if (data.recipeId && data.dashboardItemId) {
    return Response.json({ error: "E79745: Cannot set both recipeId and dashboardItemId \u2014 use one execution path" }, { status: 400 });
  }
  if (data.dashboardItemId && !data.dashboardId) {
    return Response.json({ error: "E79743: dashboardId is required when dashboardItemId is set" }, { status: 400 });
  }
  if (!data.cron && !data.eventTrigger) {
    return Response.json({ error: "E79727: Either cron or eventTrigger required" }, { status: 400 });
  }
  if (data.recipeId) {
    const { hasAccess } = await checkRecip\u0435Access(env, data.recipeId, userId, "editor");
    if (!hasAccess) {
      return Response.json({ error: "E79725: Recipe not found or no access" }, { status: 404 });
    }
    if (data.dashboardId) {
      const recipe = await env.DB.prepare(`
        SELECT id FROM recipes WHERE id = ? AND dashboard_id = ?
      `).bind(data.recipeId, data.dashboardId).first();
      if (!recipe) {
        return Response.json({ error: "E79747: Recipe does not belong to this dashboard" }, { status: 400 });
      }
    }
  }
  if (data.dashboardId) {
    const { hasAccess } = await checkDashb\u043EardAccess(env, data.dashboardId, userId, "editor");
    if (!hasAccess) {
      return Response.json({ error: "E79725: Dashboard not found or no access" }, { status: 404 });
    }
  }
  if (data.dashboardItemId && data.dashboardId) {
    const item = await env.DB.prepare(`
      SELECT id FROM dashboard_items WHERE id = ? AND dashboard_id = ?
    `).bind(data.dashboardItemId, data.dashboardId).first();
    if (!item) {
      return Response.json({ error: "E79744: Dashboard item not found in this dashboard" }, { status: 404 });
    }
  }
  if (data.cron) {
    const testNext = c\u043EmputeNextRun(data.cron);
    if (!testNext) {
      return Response.json({ error: "E79746: Invalid cron expression" }, { status: 400 });
    }
  }
  const id = generateId6();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const enabled = data.enabled !== false;
  let nextRunAt = null;
  if (data.cron && enabled) {
    const next = c\u043EmputeNextRun(data.cron);
    nextRunAt = next ? next.toISOString() : null;
  }
  await env.DB.prepare(`
    INSERT INTO schedules (id, recipe_id, dashboard_id, dashboard_item_id, command, name, cron, event_trigger, enabled, next_run_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    data.recipeId || null,
    data.dashboardId || null,
    data.dashboardItemId || null,
    data.command || null,
    data.name,
    data.cron || null,
    data.eventTrigger || null,
    enabled ? 1 : 0,
    nextRunAt,
    now
  ).run();
  const schedule = {
    id,
    recipeId: data.recipeId || null,
    dashboardId: data.dashboardId || null,
    dashboardItemId: data.dashboardItemId || null,
    command: data.command || null,
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
  if (data.cron !== void 0 && data.cron) {
    const testNext = c\u043EmputeNextRun(data.cron);
    if (!testNext) {
      return Response.json({ error: "E79746: Invalid cron expression" }, { status: 400 });
    }
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
      command = COALESCE(?, command),
      cron = ?,
      event_trigger = ?,
      enabled = ?,
      next_run_at = ?
    WHERE id = ?
  `).bind(
    data.name || null,
    data.command !== void 0 ? data.command : null,
    data.cron !== void 0 ? data.cron : existing.cron,
    data.eventTrigger !== void 0 ? data.eventTrigger : existing.event_trigger,
    enabled ? 1 : 0,
    nextRunAt,
    scheduleId
  ).run();
  const updated = await env.DB.prepare(`
    SELECT * FROM schedules WHERE id = ?
  `).bind(scheduleId).first();
  return Response.json({ schedule: formatSchedule(updated) });
}
__name(updateSchedule, "updateSchedule");
async function d\u0435leteSchedule(env, scheduleId, userId) {
  const result = await env.DB.prepare(`
    DELETE FROM schedules
    WHERE id = ?
    AND (
      -- Recipe-based: check via recipe -> dashboard -> members
      recipe_id IN (
        SELECT r.id FROM recipes r
        INNER JOIN dashboard_members dm ON r.dashboard_id = dm.dashboard_id
        WHERE dm.user_id = ? AND dm.role = 'owner'
      )
      OR
      -- Edge-based: check via dashboard -> members
      dashboard_id IN (
        SELECT dm.dashboard_id FROM dashboard_members dm
        WHERE dm.user_id = ? AND dm.role = 'owner'
      )
    )
  `).bind(scheduleId, userId, userId).run();
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
  const now = (/* @__PURE__ */ new Date()).toISOString();
  let executionData = null;
  if (schedule.dashboard_item_id && !schedule.recipe_id) {
    const { executeScheduleByEdges: executeScheduleByEdges2 } = await Promise.resolve().then(() => (init_executor(), executor_exports));
    const execution = await executeScheduleByEdges2(env, formatSchedule(schedule), "manual", userId);
    executionData = execution;
  } else if (schedule.recipe_id) {
    const executionResponse = await startExecuti\u043En(
      env,
      schedule.recipe_id,
      userId,
      { triggeredBy: "manual", scheduleId, actorUserId: userId }
    );
    const parsed = await executionResponse.json();
    executionData = parsed.execution;
  }
  let nextRunAt = null;
  if (schedule.cron && schedule.enabled) {
    const next = c\u043EmputeNextRun(schedule.cron);
    nextRunAt = next ? next.toISOString() : null;
  }
  await env.DB.prepare(`
    UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?
  `).bind(now, nextRunAt, scheduleId).run();
  return Response.json({
    schedule: formatSchedule({ ...schedule, last_run_at: now, next_run_at: nextRunAt }),
    execution: executionData
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
      if (schedule.dashboard_item_id && !schedule.recipe_id) {
        const { executeScheduleByEdges: executeScheduleByEdges2 } = await Promise.resolve().then(() => (init_executor(), executor_exports));
        await executeScheduleByEdges2(env, formatSchedule(schedule), "cron");
      } else if (schedule.recipe_id) {
        await startExecuti\u043EnInternal(
          env,
          schedule.recipe_id,
          { triggeredBy: "cron", scheduleId: schedule.id }
        );
      }
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
      if (schedule.dashboard_item_id && !schedule.recipe_id) {
        const { executeScheduleByEdges: executeScheduleByEdges2 } = await Promise.resolve().then(() => (init_executor(), executor_exports));
        const execution = await executeScheduleByEdges2(env, formatSchedule(schedule), "event");
        executions.push(execution);
      } else if (schedule.recipe_id) {
        const executionResponse = await startExecuti\u043EnInternal(
          env,
          schedule.recipe_id,
          { triggeredBy: "event", eventName, payload, scheduleId: schedule.id }
        );
        const executionData = await executionResponse.json();
        executions.push(executionData.execution);
      } else {
        console.warn(`[schedules] Schedule ${schedule.id} has neither recipe_id nor dashboard_item_id \u2014 skipping`);
        continue;
      }
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
async function listScheduleExecutions(env, scheduleId, userId, limit = 20) {
  const { hasAccess } = await checkSchedul\u0435Access(env, scheduleId, userId, "viewer");
  if (!hasAccess) {
    return Response.json({ error: "E79728: Schedule not found or no access" }, { status: 404 });
  }
  const result = await env.DB.prepare(`
    SELECT * FROM schedule_executions
    WHERE schedule_id = ?
    ORDER BY started_at DESC
    LIMIT ?
  `).bind(scheduleId, limit).all();
  return Response.json({ executions: result.results.map(formatExecution) });
}
__name(listScheduleExecutions, "listScheduleExecutions");
async function handlePtyCompleted(env, executionId, data) {
  const execution = await env.DB.prepare(`
    SELECT * FROM schedule_executions WHERE id = ?
  `).bind(executionId).first();
  if (!execution) {
    return Response.json({ error: "E79741: Execution not found" }, { status: 404 });
  }
  const execStatus = execution.status;
  if (execStatus === "completed" || execStatus === "failed" || execStatus === "timed_out") {
    console.warn(`[schedules] Ignoring callback for already-finished execution ${executionId} (status: ${execStatus})`);
    return Response.json({ status: execStatus });
  }
  const terminals = JSON.parse(execution.terminals_json || "[]");
  let found = false;
  for (const t of terminals) {
    if (t.ptyId === data.ptyId) {
      if (t.status === "completed" || t.status === "failed" || t.status === "timed_out") {
        console.warn(`[schedules] Duplicate callback for PTY ${data.ptyId} in execution ${executionId} \u2014 ignoring`);
        return Response.json({ status: execution.status });
      }
      t.status = data.status;
      t.lastMessage = data.lastMessage || null;
      t.error = data.error || null;
      found = true;
      break;
    }
  }
  if (!found) {
    console.warn(`[schedules] PTY ${data.ptyId} not found in execution ${executionId}`);
    return Response.json({ error: "E79742: PTY not found in execution" }, { status: 404 });
  }
  const terminalDone = /* @__PURE__ */ __name((s) => s === "completed" || s === "failed" || s === "timed_out", "terminalDone");
  const allDone = terminals.every((t) => terminalDone(t.status));
  const anyFailed = terminals.some((t) => t.status === "failed");
  const anyTimedOut = terminals.some((t) => t.status === "timed_out");
  const newStatus = allDone ? anyFailed ? "failed" : anyTimedOut ? "timed_out" : "completed" : "running";
  const completedAt = allDone ? (/* @__PURE__ */ new Date()).toISOString() : null;
  await env.DB.prepare(`
    UPDATE schedule_executions SET
      terminals_json = ?,
      status = ?,
      completed_at = COALESCE(?, completed_at),
      error = ?
    WHERE id = ?
  `).bind(
    JSON.stringify(terminals),
    newStatus,
    completedAt,
    anyFailed ? "One or more terminals failed" : anyTimedOut ? "One or more terminals timed out" : null,
    executionId
  ).run();
  console.log(`[schedules] Execution ${executionId} PTY ${data.ptyId} \u2192 ${data.status} (overall: ${newStatus})`);
  return Response.json({ status: newStatus });
}
__name(handlePtyCompleted, "handlePtyCompleted");
async function cleanupStaleExecutions(env) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1e3).toISOString();
  const stale = await env.DB.prepare(`
    SELECT id, terminals_json FROM schedule_executions
    WHERE status = 'running' AND started_at < ?
  `).bind(oneHourAgo).all();
  if (stale.results.length === 0)
    return;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  let timedOutCount = 0;
  for (const row of stale.results) {
    const terminals = JSON.parse(row.terminals_json || "[]");
    for (const t of terminals) {
      if (t.status === "pending" || t.status === "running") {
        t.status = "timed_out";
        t.error = "Execution timed out after 1 hour";
      }
    }
    const result = await env.DB.prepare(`
      UPDATE schedule_executions
      SET status = 'timed_out', completed_at = ?, error = 'Execution timed out after 1 hour', terminals_json = ?
      WHERE id = ? AND status = 'running' AND started_at < ?
    `).bind(now, JSON.stringify(terminals), row.id, oneHourAgo).run();
    if (result.meta.changes > 0) {
      timedOutCount++;
    }
  }
  if (timedOutCount > 0) {
    console.log(`[schedules] Timed out ${timedOutCount} stale executions`);
  }
}
__name(cleanupStaleExecutions, "cleanupStaleExecutions");

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

// src/index.ts
init_handler();

// src/agent-skills/handler.ts
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
function formatAgentSkill(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description || "",
    command: row.command || "",
    args: safeParseJson2(row.args, []),
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
function safeParseJson3(value, fallback) {
  if (typeof value !== "string")
    return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
__name(safeParseJson3, "safeParseJson");
function f\u043ErmatMcpT\u043E\u043El(row) {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    description: row.description || "",
    serverUrl: row.server_url || "",
    transport: row.transport || "stdio",
    config: safeParseJson3(row.config, {}),
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
async function getMcpToolsForDashboard(env, dashboardId) {
  const dashboard = await env.DB.prepare(
    `SELECT dm.user_id FROM dashboard_members dm WHERE dm.dashboard_id = ? AND dm.role = 'owner'`
  ).bind(dashboardId).first();
  if (!dashboard) {
    return Response.json({ error: "E79103: Dashboard not found" }, { status: 404 });
  }
  const rows = await env.DB.prepare(
    `SELECT * FROM user_mcp_tools WHERE user_id = ? ORDER BY updated_at DESC`
  ).bind(dashboard.user_id).all();
  return Response.json({
    tools: rows.results.map((row) => f\u043ErmatMcpT\u043E\u043El(row))
  });
}
__name(getMcpToolsForDashboard, "getMcpToolsForDashboard");

// src/attachments/handler.ts
init_drive_cache();
init_fetch();
var CACHE_PREFIX = "attachments-cache";
var CACHE_TTL_MS = 24 * 60 * 60 * 1e3;
var FETCH_TIMEOUT_MS = 1e4;
var MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
var MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024;
var TERMINAL_PATHS = {
  claude: { skills: "/.claude/skills", agents: "/.claude/agents" },
  gemini: { skills: "/.gemini/skills", agents: null },
  codex: { skills: "/.codex/skills", agents: null },
  opencode: { skills: "/.config/opencode/skills", agents: "/.config/opencode/agents" },
  droid: { skills: "/.factory/skills", agents: "/.factory/droids" },
  openclaw: { skills: "/.openclaw/skills", agents: null },
  moltbot: { skills: "/.openclaw/skills", agents: null }
};
var AttachmentError = class extends Error {
  status;
  constructor(message, status = 400) {
    super(message);
    this.name = "AttachmentError";
    this.status = status;
  }
};
__name(AttachmentError, "AttachmentError");
async function attachSessionResources(env, userId, sessionId, data) {
  try {
    if (!data || !data.terminalType) {
      return Response.json({ error: "E79801: terminalType required" }, { status: 400 });
    }
    const session = await env.DB.prepare(`
      SELECT s.* FROM sessions s
      JOIN dashboard_members dm ON s.dashboard_id = dm.dashboard_id
      WHERE s.id = ? AND dm.user_id = ?
    `).bind(sessionId, userId).first();
    if (!session) {
      return Response.json({ error: "E79802: Session not found or no access" }, { status: 404 });
    }
    if (session.owner_user_id !== userId) {
      return Response.json({ error: "E79803: Only the owner can attach resources" }, { status: 403 });
    }
    const paths = TERMINAL_PATHS[data.terminalType];
    if (!paths) {
      return Response.json({ error: "E79804: Unsupported terminal type" }, { status: 400 });
    }
    const sandboxSessionId = session.sandbox_session_id;
    const machineId = session.sandbox_machine_id;
    if (data.detach?.agents && data.detach.agents.length > 0) {
      if (!paths.agents) {
        return Response.json({ error: "E79805: Agents not supported for this terminal" }, { status: 400 });
      }
      for (const name of data.detach.agents) {
        await deleteSandboxPath(env, sandboxSessionId, machineId, `${paths.agents}/${name}.md`);
      }
    }
    if (data.detach?.skills && data.detach.skills.length > 0) {
      if (!paths.skills) {
        return Response.json({ error: "E79806: Skills not supported for this terminal" }, { status: 400 });
      }
      for (const name of data.detach.skills) {
        await deleteSandboxPath(env, sandboxSessionId, machineId, `${paths.skills}/${name}`);
      }
    }
    if (data.attach?.agents && data.attach.agents.length > 0) {
      if (!paths.agents) {
        return Response.json({ error: "E79807: Agents not supported for this terminal" }, { status: 400 });
      }
      for (const agent of data.attach.agents) {
        const files = await resolveAttachmentFiles(env, agent);
        if (files.length === 0)
          continue;
        if (files.length === 1) {
          const ext = extensionForPath(files[0].path);
          const targetPath = `${paths.agents}/${agent.name}${ext}`;
          await putSandboxFile(env, sandboxSessionId, machineId, targetPath, files[0]);
          continue;
        }
        for (const file of files) {
          const targetPath = `${paths.agents}/${agent.name}/${file.path}`;
          await putSandboxFile(env, sandboxSessionId, machineId, targetPath, file);
        }
      }
    }
    if (data.attach?.skills && data.attach.skills.length > 0) {
      if (!paths.skills) {
        return Response.json({ error: "E79808: Skills not supported for this terminal" }, { status: 400 });
      }
      for (const skill of data.attach.skills) {
        const files = await resolveAttachmentFiles(env, skill);
        if (files.length === 0)
          continue;
        if (files.length === 1 && skill.content) {
          const targetPath = `${paths.skills}/${skill.name}/SKILL.md`;
          await putSandboxFile(env, sandboxSessionId, machineId, targetPath, files[0]);
          continue;
        }
        for (const file of files) {
          const targetPath = `${paths.skills}/${skill.name}/${file.path}`;
          await putSandboxFile(env, sandboxSessionId, machineId, targetPath, file);
        }
      }
    }
    if (data.mcpTools) {
      await writeMcpSettings(env, sandboxSessionId, machineId, data.terminalType, data.mcpTools);
    }
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof AttachmentError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
__name(attachSessionResources, "attachSessionResources");
function buildMcpServerConfigs(tools) {
  const servers = {};
  for (const tool of tools) {
    if (!tool.name)
      continue;
    if (tool.serverUrl === "builtin://mcp-bridge") {
      servers.orcabot = { command: "mcp-bridge", env: {} };
      continue;
    }
    const config = {};
    const toolConfig = tool.config || {};
    if (tool.transport === "stdio") {
      const command = tool.serverUrl || (typeof toolConfig.command === "string" ? toolConfig.command : void 0);
      if (!command)
        continue;
      config.command = command;
      const args = [];
      if (typeof toolConfig.command === "string" && tool.serverUrl) {
        args.push(toolConfig.command);
      }
      if (Array.isArray(toolConfig.args)) {
        args.push(...toolConfig.args.filter((a) => typeof a === "string"));
      }
      if (args.length > 0)
        config.args = args;
      if (toolConfig.env && typeof toolConfig.env === "object") {
        config.env = {};
        for (const [k, v] of Object.entries(toolConfig.env)) {
          if (typeof v === "string")
            config.env[k] = v;
        }
      }
    } else if (tool.transport === "sse" || tool.transport === "streamable-http") {
      const url = tool.serverUrl || (typeof toolConfig.url === "string" ? toolConfig.url : void 0);
      if (!url)
        continue;
      config.type = tool.transport;
      config.url = url;
    } else {
      continue;
    }
    servers[tool.name] = config;
  }
  return servers;
}
__name(buildMcpServerConfigs, "buildMcpServerConfigs");
function generateClaudeSettingsJson(servers) {
  return JSON.stringify({ mcpServers: servers }, null, 2);
}
__name(generateClaudeSettingsJson, "generateClaudeSettingsJson");
function generateOpenCodeSettingsJson(servers) {
  const mcp = {};
  for (const [name, server] of Object.entries(servers)) {
    mcp[name] = { ...server, enabled: true };
  }
  return JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp }, null, 2);
}
__name(generateOpenCodeSettingsJson, "generateOpenCodeSettingsJson");
function generateGeminiSettingsJson(servers) {
  const mcpServers = {};
  for (const [name, server] of Object.entries(servers)) {
    const s = {};
    if (server.command)
      s.command = server.command;
    if (server.args)
      s.args = server.args;
    if (server.url)
      s.url = server.url;
    if (server.type)
      s.type = server.type;
    mcpServers[name] = s;
  }
  return JSON.stringify({ mcpServers }, null, 2);
}
__name(generateGeminiSettingsJson, "generateGeminiSettingsJson");
function generateCodexConfigToml(servers) {
  const lines = ["# Codex MCP configuration (auto-generated by OrcaBot)", ""];
  for (const [name, server] of Object.entries(servers)) {
    if (!server.command)
      continue;
    lines.push(`[mcp_servers."${name}"]`);
    lines.push(`command = "${server.command}"`);
    if (server.args && server.args.length > 0) {
      const argsStr = server.args.map((a) => `"${a}"`).join(", ");
      lines.push(`args = [${argsStr}]`);
    }
    if (server.env && Object.keys(server.env).length > 0) {
      const envPairs = Object.entries(server.env).map(([k, v]) => `"${k}" = "${v}"`).join(", ");
      lines.push(`env = { ${envPairs} }`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
__name(generateCodexConfigToml, "generateCodexConfigToml");
function generateDroidSettingsJson(servers) {
  const mcpServers = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.url) {
      mcpServers[name] = {
        type: server.type === "sse" ? "sse" : "http",
        url: server.url,
        disabled: false
      };
    } else {
      mcpServers[name] = {
        type: "stdio",
        command: server.command || "",
        args: server.args || [],
        disabled: false
      };
    }
  }
  return JSON.stringify({ mcpServers }, null, 2);
}
__name(generateDroidSettingsJson, "generateDroidSettingsJson");
var MCP_SETTINGS_BY_TERMINAL = {
  claude: (servers) => ({ path: "/.claude/settings.json", content: generateClaudeSettingsJson(servers), contentType: "application/json" }),
  opencode: (servers) => ({ path: "/.config/opencode/opencode.json", content: generateOpenCodeSettingsJson(servers), contentType: "application/json" }),
  gemini: (servers) => ({ path: "/.gemini/settings.json", content: generateGeminiSettingsJson(servers), contentType: "application/json" }),
  codex: (servers) => ({ path: "/.codex/config.toml", content: generateCodexConfigToml(servers), contentType: "application/toml" }),
  droid: (servers) => ({ path: "/.factory/mcp.json", content: generateDroidSettingsJson(servers), contentType: "application/json" })
};
async function writeMcpSettings(env, sandboxSessionId, machineId, terminalType, tools) {
  const settingsGenerator = MCP_SETTINGS_BY_TERMINAL[terminalType];
  if (!settingsGenerator) {
    return;
  }
  const servers = buildMcpServerConfigs(tools);
  const encoder = new TextEncoder();
  const { path, content, contentType } = settingsGenerator(servers);
  await putSandboxFile(env, sandboxSessionId, machineId, path, {
    path: path.split("/").pop() || "settings.json",
    data: encoder.encode(content).buffer,
    contentType
  });
}
__name(writeMcpSettings, "writeMcpSettings");
async function resolveAttachmentFiles(env, attachment) {
  if (attachment.sourceUrl) {
    validateAttachmentUrl(attachment.sourceUrl);
    return getCachedFiles(env, attachment.sourceUrl);
  }
  if (attachment.content) {
    const encoder = new TextEncoder();
    return [{
      path: "SKILL.md",
      data: encoder.encode(attachment.content).buffer,
      contentType: "text/markdown"
    }];
  }
  return [];
}
__name(resolveAttachmentFiles, "resolveAttachmentFiles");
async function getCachedFiles(env, sourceUrl) {
  if (!env.DRIVE_CACHE) {
    return fetchSourceFiles(sourceUrl);
  }
  const hash = await sha256(sourceUrl);
  const manifestKey = `${CACHE_PREFIX}/${hash}/manifest.json`;
  const now = Date.now();
  let cachedManifest = null;
  try {
    cachedManifest = await env.DRIVE_CACHE.get(manifestKey);
  } catch (error) {
    if (isDesktopFeatureDisabledError(error)) {
      return fetchSourceFiles(sourceUrl);
    }
    throw error;
  }
  if (cachedManifest) {
    const manifest = await cachedManifest.json();
    const fetchedAt = Date.parse(manifest.fetchedAt);
    if (!Number.isNaN(fetchedAt) && now - fetchedAt < CACHE_TTL_MS) {
      const cachedFiles = [];
      let totalBytes = 0;
      for (const entry of manifest.files) {
        let object = null;
        try {
          object = await env.DRIVE_CACHE.get(entry.key);
        } catch (error) {
          if (isDesktopFeatureDisabledError(error)) {
            return fetchSourceFiles(sourceUrl);
          }
          throw error;
        }
        if (!object)
          continue;
        if (typeof object.size === "number" && object.size > MAX_ATTACHMENT_BYTES) {
          throw new AttachmentError("E79811: Attachment file too large");
        }
        cachedFiles.push({
          path: entry.path,
          data: await object.arrayBuffer(),
          contentType: entry.contentType ?? null
        });
      }
      for (const file of cachedFiles) {
        totalBytes += file.data.byteLength;
        if (file.data.byteLength > MAX_ATTACHMENT_BYTES || totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
          throw new AttachmentError("E79811: Attachment file too large");
        }
      }
      if (cachedFiles.length > 0) {
        return cachedFiles;
      }
    }
  }
  const fetchedFiles = await fetchSourceFiles(sourceUrl);
  const manifestFiles = [];
  if (env.DRIVE_CACHE) {
    for (const file of fetchedFiles) {
      const fileKey = `${CACHE_PREFIX}/${hash}/files/${file.path}`;
      try {
        await env.DRIVE_CACHE.put(fileKey, file.data, {
          httpMetadata: file.contentType ? { contentType: file.contentType } : void 0
        });
      } catch (error) {
        if (isDesktopFeatureDisabledError(error)) {
          return fetchedFiles;
        }
        throw error;
      }
      manifestFiles.push({ path: file.path, key: fileKey, contentType: file.contentType ?? null });
    }
    try {
      await env.DRIVE_CACHE.put(manifestKey, JSON.stringify({
        fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
        files: manifestFiles
      }));
    } catch (error) {
      if (isDesktopFeatureDisabledError(error)) {
        return fetchedFiles;
      }
      throw error;
    }
  }
  return fetchedFiles;
}
__name(getCachedFiles, "getCachedFiles");
async function fetchSourceFiles(sourceUrl) {
  const parsed = parseGitHubUrl(sourceUrl);
  if (parsed && parsed.type === "tree") {
    return fetchGitHubTreeFiles(parsed.owner, parsed.repo, parsed.ref, parsed.path);
  }
  if (parsed && (parsed.type === "raw" || parsed.type === "blob")) {
    const rawUrl = parsed.type === "raw" ? sourceUrl : `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${parsed.ref}/${parsed.path}`;
    return fetchSingleFile(rawUrl, basename(parsed.path));
  }
  throw new AttachmentError("E79809: Unsupported attachment source (only GitHub URLs are allowed)");
}
__name(fetchSourceFiles, "fetchSourceFiles");
async function fetchGitHubTreeFiles(owner, repo, ref, basePath) {
  const files = await listGitHubDirectory(owner, repo, ref, basePath);
  const result = [];
  let totalBytes = 0;
  for (const file of files) {
    const response = await fetchWithTimeout(file.downloadUrl, { headers: githubHeaders() });
    if (!response.ok)
      continue;
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError("E79811: Attachment file too large");
    }
    const data = await response.arrayBuffer();
    if (data.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError("E79811: Attachment file too large");
    }
    totalBytes += data.byteLength;
    if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
      throw new AttachmentError("E79812: Attachment exceeds total size limit");
    }
    result.push({
      path: file.relativePath,
      data,
      contentType: response.headers.get("content-type")
    });
  }
  return result;
}
__name(fetchGitHubTreeFiles, "fetchGitHubTreeFiles");
async function listGitHubDirectory(owner, repo, ref, basePath) {
  const results = [];
  const queue = [basePath];
  while (queue.length > 0) {
    const current = queue.shift() || "";
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${current}?ref=${ref}`;
    const response = await fetchWithTimeout(url, { headers: githubHeaders() });
    if (!response.ok) {
      continue;
    }
    const data = await response.json();
    for (const entry of data) {
      if (entry.type === "dir") {
        queue.push(entry.path);
        continue;
      }
      if (entry.type === "file" && entry.download_url) {
        const relativePath = trimPathPrefix(entry.path, basePath);
        results.push({ relativePath, downloadUrl: entry.download_url });
      }
    }
  }
  return results;
}
__name(listGitHubDirectory, "listGitHubDirectory");
function parseGitHubUrl(sourceUrl) {
  let url;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.hostname === "raw.githubusercontent.com") {
    if (parts.length < 4)
      return null;
    const [owner, repo, ref, ...pathParts] = parts;
    return { type: "raw", owner, repo, ref, path: pathParts.join("/") };
  }
  if (url.hostname === "github.com") {
    if (parts.length < 4)
      return null;
    const [owner, repo, kind, ref, ...pathParts] = parts;
    if (kind === "tree" || kind === "blob") {
      return { type: kind, owner, repo, ref, path: pathParts.join("/") };
    }
  }
  return null;
}
__name(parseGitHubUrl, "parseGitHubUrl");
async function fetchSingleFile(sourceUrl, fileName) {
  const response = await fetchWithTimeout(sourceUrl, { headers: githubHeaders() });
  if (!response.ok)
    return [];
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError("E79811: Attachment file too large");
  }
  const data = await response.arrayBuffer();
  if (data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError("E79811: Attachment file too large");
  }
  return [{
    path: fileName,
    data,
    contentType: response.headers.get("content-type")
  }];
}
__name(fetchSingleFile, "fetchSingleFile");
async function putSandboxFile(env, sandboxSessionId, machineId, path, file) {
  const url = sandboxUrl(env, `/sessions/${sandboxSessionId}/file`);
  url.searchParams.set("path", path);
  await sandboxFetch(env, url.toString(), {
    method: "PUT",
    headers: {
      "Content-Type": file.contentType || "application/octet-stream"
    },
    body: file.data,
    machineId
  });
}
__name(putSandboxFile, "putSandboxFile");
async function deleteSandboxPath(env, sandboxSessionId, machineId, path) {
  const url = sandboxUrl(env, `/sessions/${sandboxSessionId}/file`);
  url.searchParams.set("path", path);
  await sandboxFetch(env, url.toString(), { method: "DELETE", machineId });
}
__name(deleteSandboxPath, "deleteSandboxPath");
function githubHeaders() {
  return {
    "User-Agent": "Orcabot-ControlPlane",
    "Accept": "application/vnd.github+json"
  };
}
__name(githubHeaders, "githubHeaders");
function trimPathPrefix(path, prefix) {
  if (!prefix)
    return path;
  if (path.startsWith(prefix)) {
    return path.slice(prefix.length).replace(/^\/+/, "");
  }
  return path;
}
__name(trimPathPrefix, "trimPathPrefix");
function basename(path) {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || "file";
}
__name(basename, "basename");
function extensionForPath(path) {
  const index = path.lastIndexOf(".");
  if (index === -1)
    return ".md";
  return path.slice(index);
}
__name(extensionForPath, "extensionForPath");
function validateAttachmentUrl(sourceUrl) {
  let url;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new AttachmentError("E79809: Invalid attachment URL");
  }
  if (url.protocol !== "https:") {
    throw new AttachmentError("E79809: Attachment URLs must be https");
  }
  if (url.hostname !== "github.com" && url.hostname !== "raw.githubusercontent.com") {
    throw new AttachmentError("E79809: Unsupported attachment source (only GitHub URLs are allowed)");
  }
  if (!parseGitHubUrl(sourceUrl)) {
    throw new AttachmentError("E79809: Unsupported attachment URL format");
  }
}
__name(validateAttachmentUrl, "validateAttachmentUrl");
async function fetchWithTimeout(input, init) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new AttachmentError("E79810: Attachment fetch timed out", 408);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
__name(fetchWithTimeout, "fetchWithTimeout");
async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
__name(sha256, "sha256");

// src/integrations/handler.ts
init_fetch();
var integrationsRevision = "integrations-v6-discord-oauth";
console.log(`[integrations] REVISION: ${integrationsRevision} loaded at ${(/* @__PURE__ */ new Date()).toISOString()}`);
var GOOGLE_SCOPE = [
  "https://www.googleapis.com/auth/drive"
];
var GMAIL_SCOPE = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "openid",
  "email"
];
var CALENDAR_SCOPE = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "openid",
  "email"
];
var CONTACTS_SCOPE = [
  "https://www.googleapis.com/auth/contacts.readonly",
  "openid",
  "email"
];
var SHEETS_SCOPE = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.readonly",
  "openid",
  "email"
];
var FORMS_SCOPE = [
  "https://www.googleapis.com/auth/forms.body.readonly",
  "https://www.googleapis.com/auth/forms.responses.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "openid",
  "email"
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
var SLACK_SCOPE = [
  "channels:read",
  "channels:history",
  "groups:read",
  // Private channels: list
  "groups:history",
  // Private channels: read messages
  "im:read",
  // DMs: list
  "im:history",
  // DMs: read messages
  "mpim:read",
  // Group DMs: list
  "mpim:history",
  // Group DMs: read messages
  "chat:write",
  "users:read",
  // search:read removed — it's a user token scope (xoxp), not a bot token scope (xoxb).
  // The bot OAuth flow only yields a bot token, so requesting search:read would fail with
  // invalid_scope or grant a scope that can't be used. The slack_search MCP tool was
  // already removed in integration_tools.go for this reason.
  "reactions:write",
  "chat:write.customize"
];
var DRIVE_AUTO_SYNC_LIMIT_BYTES = 1024 * 1024 * 1024;
var DRIVE_MANIFEST_VERSION = 1;
var DRIVE_UPLOAD_BUFFER_LIMIT_BYTES = 25 * 1024 * 1024;
var DRIVE_UPLOAD_PART_BYTES = 8 * 1024 * 1024;
var MIRROR_TABLES2 = {
  github: "github_mirrors",
  box: "box_mirrors",
  onedrive: "onedrive_mirrors",
  drive: "drive_mirrors",
  google_drive: "drive_mirrors"
  // Alias for google_drive provider
};
function getMirrorTableName2(provider) {
  return MIRROR_TABLES2[provider] ?? null;
}
__name(getMirrorTableName2, "getMirrorTableName");
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
async function cleanupIntegration(env, provider, userId) {
  const mirrorTable = getMirrorTableName2(provider);
  if (!mirrorTable) {
    console.error(`[integrations] Invalid mirror provider: ${provider}`);
    return;
  }
  const mirrors = await env.DB.prepare(`
    SELECT dashboard_id FROM ${mirrorTable} WHERE user_id = ?
  `).bind(userId).all();
  for (const mirror of mirrors.results || []) {
    try {
      if (provider === "google_drive") {
        const manifestObject = await env.DRIVE_CACHE.get(driveManifestKey2(mirror.dashboard_id));
        if (manifestObject) {
          const manifest = await manifestObject.json();
          await env.DRIVE_CACHE.delete(driveManifestKey2(mirror.dashboard_id));
          for (const entry of manifest.entries) {
            await env.DRIVE_CACHE.delete(driveFileKey(mirror.dashboard_id, entry.id));
          }
        }
      } else {
        const manifestObject = await env.DRIVE_CACHE.get(mirrorManifestKey2(provider, mirror.dashboard_id));
        if (manifestObject) {
          const manifest = await manifestObject.json();
          await env.DRIVE_CACHE.delete(mirrorManifestKey2(provider, mirror.dashboard_id));
          for (const entry of manifest.entries) {
            await env.DRIVE_CACHE.delete(mirrorFileKey(provider, mirror.dashboard_id, entry.id));
          }
        }
      }
    } catch (cacheErr) {
      console.error(`Failed to clean up ${provider} cache for dashboard:`, mirror.dashboard_id, cacheErr);
    }
  }
  await env.DB.prepare(`DELETE FROM ${mirrorTable} WHERE user_id = ?`).bind(userId).run();
  const userIntegrations = await env.DB.prepare(`
    SELECT id FROM user_integrations WHERE user_id = ? AND provider = ?
  `).bind(userId, provider).all();
  for (const ui of userIntegrations.results || []) {
    await env.DB.prepare(`
      UPDATE terminal_integrations
      SET deleted_at = datetime('now'), updated_at = datetime('now')
      WHERE user_integration_id = ? AND deleted_at IS NULL
    `).bind(ui.id).run();
  }
  await env.DB.prepare(`DELETE FROM user_integrations WHERE user_id = ? AND provider = ?`).bind(userId, provider).run();
}
__name(cleanupIntegration, "cleanupIntegration");
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
    const errBody = await tokenResponse.text().catch(() => "");
    console.error("Google Drive token refresh failed:", tokenResponse.status, errBody);
    let isInvalidGrant = errBody.includes("invalid_grant");
    if (!isInvalidGrant) {
      try {
        const errJson = JSON.parse(errBody);
        isInvalidGrant = errJson.error === "invalid_grant";
      } catch {
      }
    }
    if (isInvalidGrant) {
      console.log("Auto-disconnecting Google Drive due to invalid_grant for user:", userId);
      await cleanupIntegration(env, "google_drive", userId);
      throw new Error("Google Drive session expired. Please reconnect.");
    }
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
    const errBody = await tokenResponse.text().catch(() => "");
    console.error("Box token refresh failed:", tokenResponse.status, errBody);
    let isInvalidGrant = errBody.includes("invalid_grant");
    if (!isInvalidGrant) {
      try {
        const errJson = JSON.parse(errBody);
        isInvalidGrant = errJson.error === "invalid_grant";
      } catch {
      }
    }
    if (isInvalidGrant) {
      console.log("Auto-disconnecting Box due to invalid_grant for user:", userId);
      await cleanupIntegration(env, "box", userId);
      throw new Error("Box session expired. Please reconnect.");
    }
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
    const errBody = await tokenResponse.text().catch(() => "");
    console.error("OneDrive token refresh failed:", tokenResponse.status, errBody);
    let isInvalidGrant = errBody.includes("invalid_grant");
    if (!isInvalidGrant) {
      try {
        const errJson = JSON.parse(errBody);
        isInvalidGrant = errJson.error === "invalid_grant";
      } catch {
      }
    }
    if (isInvalidGrant) {
      console.log("Auto-disconnecting OneDrive due to invalid_grant for user:", userId);
      await cleanupIntegration(env, "onedrive", userId);
      throw new Error("OneDrive session expired. Please reconnect.");
    }
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
function renderAuthExpiredPage(frontendUrl, payloadType, dashboardId, message) {
  const frontendOrigin = new URL(frontendUrl).origin;
  const payload = JSON.stringify({ type: payloadType, dashboardId });
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
    <script>
      try {
        const targetWindow = window.opener || (window.parent !== window ? window.parent : null);
        if (targetWindow) {
          targetWindow.postMessage(${payload}, ${JSON.stringify(frontendOrigin)});
        }
      } catch {}
      try {
        var bc = new BroadcastChannel('orcabot-oauth');
        bc.postMessage(${payload});
        bc.close();
      } catch {}
      if (window.opener) {
        setTimeout(() => window.close(), 300);
      }
    <\/script>
  </body>
</html>`,
    {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    }
  );
}
__name(renderAuthExpiredPage, "renderAuthExpiredPage");
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
      try {
        var bc = new BroadcastChannel('orcabot-oauth');
        bc.postMessage(${payload});
        bc.close();
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
      try {
        var bc = new BroadcastChannel('orcabot-oauth');
        bc.postMessage(${payload});
        bc.close();
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
  console.log("Google Drive token exchange redirect_uri:", redirectUri);
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!tokenResponse.ok) {
    const errBody = await tokenResponse.text().catch(() => "");
    console.error("Google Drive token exchange failed:", tokenResponse.status, errBody);
    return renderErrorPage(`Failed to exchange token. ${tokenResponse.status}: ${errBody}`);
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
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "github_auth_invalid") {
      try {
        await cleanupIntegration(env, "github", auth.user.id);
      } catch (cleanupErr) {
        console.error("Failed to auto-disconnect GitHub after auth failure:", cleanupErr);
      }
      return Response.json({ connected: false, repos: [], error: "GitHub session expired. Please reconnect." });
    }
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
async function disconnectGithub(_request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  await cleanupIntegration(env, "github", auth.user.id);
  return Response.json({ ok: true });
}
__name(disconnectGithub, "disconnectGithub");
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
async function disconnectBox(_request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  await cleanupIntegration(env, "box", auth.user.id);
  return Response.json({ ok: true });
}
__name(disconnectBox, "disconnectBox");
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
async function disconnectOnedrive(_request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  await cleanupIntegration(env, "onedrive", auth.user.id);
  return Response.json({ ok: true });
}
__name(disconnectOnedrive, "disconnectOnedrive");
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
  await env.DB.prepare(`
    UPDATE terminal_integrations
    SET deleted_at = datetime('now'), updated_at = datetime('now')
    WHERE dashboard_id = ? AND provider = 'google_drive' AND deleted_at IS NULL
  `).bind(dashboardId).run();
  return Response.json({ ok: true });
}
__name(unlinkG\u043E\u043EgleDriveF\u043Elder, "unlinkG\u043E\u043EgleDriveF\u043Elder");
async function disconnectGoogleDrive(_request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  await cleanupIntegration(env, "google_drive", auth.user.id);
  return Response.json({ ok: true });
}
__name(disconnectGoogleDrive, "disconnectGoogleDrive");
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
    const res = await sandboxFetch(env, `/sessions/${sandboxSessionId}/drive/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        dashboard_id: dashboardId,
        folder_name: folderName
      }),
      machineId: sandboxMachineId || void 0
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
  const tableName = getMirrorTableName2(provider);
  if (!tableName) {
    console.error(`[integrations] Invalid mirror provider: ${provider}`);
    return;
  }
  try {
    const res = await sandboxFetch(env, `/sessions/${sandboxSessionId}/mirror/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        provider,
        dashboard_id: dashboardId,
        folder_name: folderName
      }),
      machineId: sandboxMachineId || void 0
    });
    if (!res.ok) {
      throw new Error(`sandbox sync failed: ${res.status}`);
    }
  } catch {
    await env.DB.prepare(`
      UPDATE ${tableName}
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
    url.searchParams.set("visibility", "all");
    url.searchParams.set("affiliation", "owner,collaborator,organization_member");
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "OrcaBot",
        Accept: "application/vnd.github+json"
      }
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error("GitHub repo listing failed:", res.status, errBody);
      if (res.status === 401 || res.status === 403) {
        throw new Error("github_auth_invalid");
      }
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
  const table = getMirrorTableName2(data.provider);
  if (!table) {
    return Response.json({ error: "E79907: invalid provider" }, { status: 400 });
  }
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
  let accessToken;
  try {
    accessToken = await refreshGoogleAccessToken(env, auth.user.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to refresh Google access token.";
    if (message.includes("must be connected again") || message.includes("session expired")) {
      try {
        await cleanupIntegration(env, "google_drive", auth.user.id);
      } catch (cleanupErr) {
        console.error("Failed to auto-disconnect Google Drive after refresh failure:", cleanupErr);
      }
      const frontendUrl2 = env.FRONTEND_URL || "https://orcabot.com";
      const url2 = new URL(request.url);
      const dashboardId2 = url2.searchParams.get("dashboard_id");
      return renderAuthExpiredPage(
        frontendUrl2,
        "drive-auth-expired",
        dashboardId2,
        "Google Drive session expired. Please reconnect."
      );
    }
    return renderErrorPage(message);
  }
  const frontendUrl = env.FRONTEND_URL || "https://orcabot.com";
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  return renderDrivePickerPage(accessToken, env.GOOGLE_API_KEY, frontendUrl, dashboardId);
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
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
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
  console.log("Box token exchange redirect_uri:", redirectUri);
  const tokenResponse = await fetch("https://api.box.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!tokenResponse.ok) {
    const errBody = await tokenResponse.text().catch(() => "");
    console.error("Box token exchange failed:", tokenResponse.status, errBody);
    return renderErrorPage(`Failed to exchange token. ${tokenResponse.status}: ${errBody}`);
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
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
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
  console.log("OneDrive token exchange redirect_uri:", redirectUri);
  const tokenResponse = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!tokenResponse.ok) {
    const errBody = await tokenResponse.text().catch(() => "");
    console.error("OneDrive token exchange failed:", tokenResponse.status, errBody);
    return renderErrorPage(`Failed to exchange token. ${tokenResponse.status}: ${errBody}`);
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
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
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
async function refreshGmailAccessToken(env, userId) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth is not configured.");
  }
  const record = await env.DB.prepare(`
    SELECT access_token, refresh_token FROM user_integrations
    WHERE user_id = ? AND provider = 'gmail'
  `).bind(userId).first();
  if (!record?.refresh_token) {
    throw new Error("Gmail must be connected again.");
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
    if (tokenResponse.status === 400 || tokenResponse.status === 401) {
      throw new Error("TOKEN_REVOKED");
    }
    throw new Error("Failed to refresh Gmail access token.");
  }
  const tokenData = await tokenResponse.json();
  const now = /* @__PURE__ */ new Date();
  const expiresAt = tokenData.expires_in ? new Date(now.getTime() + tokenData.expires_in * 1e3).toISOString() : null;
  await env.DB.prepare(`
    UPDATE user_integrations
    SET access_token = ?, scope = ?, token_type = ?, expires_at = ?, updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'gmail'
  `).bind(
    tokenData.access_token,
    tokenData.scope || null,
    tokenData.token_type || null,
    expiresAt,
    userId
  ).run();
  return tokenData.access_token;
}
__name(refreshGmailAccessToken, "refreshGmailAccessToken");
async function getGmailAccessToken(env, userId) {
  const record = await env.DB.prepare(`
    SELECT access_token, expires_at FROM user_integrations
    WHERE user_id = ? AND provider = 'gmail'
  `).bind(userId).first();
  if (!record) {
    throw new Error("Gmail not connected.");
  }
  if (record.expires_at) {
    const expiresAt = new Date(record.expires_at).getTime();
    const now = Date.now();
    if (expiresAt - now < 5 * 60 * 1e3) {
      return refreshGmailAccessToken(env, userId);
    }
  }
  return record.access_token;
}
__name(getGmailAccessToken, "getGmailAccessToken");
async function getGmailProfile(accessToken) {
  const res = await fetch("https://www.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error("TOKEN_REVOKED");
    }
    throw new Error("Failed to fetch Gmail profile.");
  }
  return res.json();
}
__name(getGmailProfile, "getGmailProfile");
async function listGmailMessages(accessToken, labelIds = ["INBOX"], maxResults = 50, pageToken) {
  const url = new URL("https://www.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("maxResults", String(maxResults));
  if (labelIds.length > 0) {
    url.searchParams.set("labelIds", labelIds.join(","));
  }
  if (pageToken) {
    url.searchParams.set("pageToken", pageToken);
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    throw new Error("Failed to list Gmail messages.");
  }
  return res.json();
}
__name(listGmailMessages, "listGmailMessages");
async function getGmailMessage(accessToken, messageId, format = "metadata") {
  const url = new URL(`https://www.googleapis.com/gmail/v1/users/me/messages/${messageId}`);
  url.searchParams.set("format", format);
  if (format === "metadata") {
    url.searchParams.append("metadataHeaders", "From");
    url.searchParams.append("metadataHeaders", "To");
    url.searchParams.append("metadataHeaders", "Subject");
    url.searchParams.append("metadataHeaders", "Date");
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    throw new Error("Failed to fetch Gmail message.");
  }
  return res.json();
}
__name(getGmailMessage, "getGmailMessage");
async function modifyGmailMessage(accessToken, messageId, addLabelIds = [], removeLabelIds = []) {
  const res = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ addLabelIds, removeLabelIds })
    }
  );
  if (!res.ok) {
    throw new Error("Failed to modify Gmail message.");
  }
  return res.json();
}
__name(modifyGmailMessage, "modifyGmailMessage");
async function setupGmailWatch(accessToken, topicName, labelIds = ["INBOX"]) {
  const res = await fetch("https://www.googleapis.com/gmail/v1/users/me/watch", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      topicName,
      labelIds,
      labelFilterAction: "include"
    })
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to setup Gmail watch: ${errorText}`);
  }
  return res.json();
}
__name(setupGmailWatch, "setupGmailWatch");
async function stopGmailWatch(accessToken) {
  const res = await fetch("https://www.googleapis.com/gmail/v1/users/me/stop", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok && res.status !== 404) {
    throw new Error("Failed to stop Gmail watch.");
  }
}
__name(stopGmailWatch, "stopGmailWatch");
async function getGmailHistory(accessToken, startHistoryId, labelId, maxResults = 100) {
  const url = new URL("https://www.googleapis.com/gmail/v1/users/me/history");
  url.searchParams.set("startHistoryId", startHistoryId);
  url.searchParams.set("maxResults", String(maxResults));
  if (labelId) {
    url.searchParams.set("labelId", labelId);
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error("HISTORY_EXPIRED");
    }
    throw new Error("Failed to fetch Gmail history.");
  }
  return res.json();
}
__name(getGmailHistory, "getGmailHistory");
function extractHeader(message, headerName) {
  const headers = message.payload?.headers;
  if (!headers)
    return null;
  const header = headers.find((h) => h.name.toLowerCase() === headerName.toLowerCase());
  return header?.value || null;
}
__name(extractHeader, "extractHeader");
async function connectGmail(request, env, auth) {
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
  await createState(env, auth.user.id, "gmail", state, {
    dashboard_id: dashboardId,
    popup: mode === "popup"
  });
  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/gmail/callback`;
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GMAIL_SCOPE.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("state", state);
  return Response.redirect(authUrl.toString(), 302);
}
__name(connectGmail, "connectGmail");
async function callbackGmail(request, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return renderErrorPage("Google OAuth is not configured.");
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return renderErrorPage("Missing authorization code.");
  }
  const stateData = await consumeState(env, state, "gmail");
  if (!stateData) {
    return renderErrorPage("Invalid or expired state.");
  }
  const dashboardId = typeof stateData.metadata.dashboard_id === "string" ? stateData.metadata.dashboard_id : null;
  const popup = stateData.metadata.popup === true;
  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/gmail/callback`;
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
  let emailAddress = "";
  try {
    const profile = await getGmailProfile(tokenData.access_token);
    emailAddress = profile.emailAddress;
  } catch {
  }
  const metadata = JSON.stringify({
    scope: tokenData.scope,
    token_type: tokenData.token_type,
    email_address: emailAddress
  });
  await env.DB.prepare(`
    INSERT INTO user_integrations (
      id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata
    ) VALUES (?, ?, 'gmail', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
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
  const frontendUrl = env.FRONTEND_URL || "https://orcabot.com";
  if (popup) {
    return renderProviderAuthCompletePage(frontendUrl, "Gmail", "gmail-auth-complete", dashboardId);
  }
  return renderSuccessPage("Gmail");
}
__name(callbackGmail, "callbackGmail");
async function getGmailIntegration(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  const integration = await env.DB.prepare(`
    SELECT metadata FROM user_integrations WHERE user_id = ? AND provider = 'gmail'
  `).bind(auth.user.id).first();
  if (!integration) {
    return Response.json({ connected: false, linked: false, emailAddress: null });
  }
  let metadata = {};
  try {
    metadata = JSON.parse(integration.metadata || "{}");
  } catch {
    metadata = {};
  }
  if (!dashboardId) {
    return Response.json({
      connected: true,
      linked: false,
      emailAddress: metadata.email_address || null
    });
  }
  const mirror = await env.DB.prepare(`
    SELECT email_address, label_ids, status, last_synced_at, watch_expiration
    FROM gmail_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!mirror) {
    return Response.json({
      connected: true,
      linked: false,
      emailAddress: metadata.email_address || null
    });
  }
  let labelIds = [];
  try {
    labelIds = JSON.parse(mirror.label_ids);
  } catch {
    labelIds = ["INBOX"];
  }
  return Response.json({
    connected: true,
    linked: true,
    emailAddress: mirror.email_address,
    labelIds,
    status: mirror.status,
    lastSyncedAt: mirror.last_synced_at,
    watchExpiration: mirror.watch_expiration
  });
}
__name(getGmailIntegration, "getGmailIntegration");
async function setupGmailMirror(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId) {
    return Response.json({ error: "E79901: dashboardId is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79902: Not found or no access" }, { status: 404 });
  }
  let accessToken;
  try {
    accessToken = await getGmailAccessToken(env, auth.user.id);
  } catch (err) {
    if (err instanceof Error && err.message === "TOKEN_REVOKED") {
      return Response.json({
        error: "E79904: Gmail access was revoked. Please reconnect.",
        code: "TOKEN_REVOKED"
      }, { status: 401 });
    }
    return Response.json({ error: "E79903: Gmail not connected" }, { status: 404 });
  }
  let profile;
  try {
    profile = await getGmailProfile(accessToken);
  } catch (err) {
    if (err instanceof Error && err.message === "TOKEN_REVOKED") {
      return Response.json({
        error: "E79904: Gmail access was revoked. Please reconnect.",
        code: "TOKEN_REVOKED"
      }, { status: 401 });
    }
    throw err;
  }
  const labelIds = data.labelIds || ["INBOX"];
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await env.DB.prepare(`
    INSERT INTO gmail_mirrors (
      dashboard_id, user_id, email_address, label_ids, status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, 'idle', ?, ?)
    ON CONFLICT(dashboard_id) DO UPDATE SET
      user_id = excluded.user_id,
      email_address = excluded.email_address,
      label_ids = excluded.label_ids,
      status = 'idle',
      history_id = null,
      watch_expiration = null,
      last_synced_at = null,
      sync_error = null,
      updated_at = excluded.updated_at
  `).bind(
    data.dashboardId,
    auth.user.id,
    profile.emailAddress,
    JSON.stringify(labelIds),
    now,
    now
  ).run();
  try {
    await runGmailSync(env, auth.user.id, data.dashboardId, accessToken);
  } catch {
  }
  return Response.json({ ok: true, emailAddress: profile.emailAddress });
}
__name(setupGmailMirror, "setupGmailMirror");
async function unlinkGmailMirror(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "E79904: dashboard_id is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79905: Not found or no access" }, { status: 404 });
  }
  try {
    const accessToken = await getGmailAccessToken(env, auth.user.id);
    await stopGmailWatch(accessToken);
  } catch {
  }
  await env.DB.prepare(`DELETE FROM gmail_messages WHERE dashboard_id = ?`).bind(dashboardId).run();
  await env.DB.prepare(`DELETE FROM gmail_actions WHERE dashboard_id = ?`).bind(dashboardId).run();
  await env.DB.prepare(`DELETE FROM gmail_mirrors WHERE dashboard_id = ?`).bind(dashboardId).run();
  return Response.json({ ok: true });
}
__name(unlinkGmailMirror, "unlinkGmailMirror");
async function getGmailStatus(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "E79906: dashboard_id is required" }, { status: 400 });
  }
  const mirror = await env.DB.prepare(`
    SELECT email_address, label_ids, history_id, watch_expiration, status, last_synced_at, sync_error
    FROM gmail_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!mirror) {
    return Response.json({ connected: false });
  }
  const messageCount = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM gmail_messages WHERE dashboard_id = ?
  `).bind(dashboardId).first();
  let labelIds = [];
  try {
    labelIds = JSON.parse(mirror.label_ids);
  } catch {
    labelIds = ["INBOX"];
  }
  return Response.json({
    connected: true,
    emailAddress: mirror.email_address,
    labelIds,
    historyId: mirror.history_id,
    watchExpiration: mirror.watch_expiration,
    watchActive: mirror.watch_expiration ? new Date(mirror.watch_expiration).getTime() > Date.now() : false,
    status: mirror.status,
    lastSyncedAt: mirror.last_synced_at,
    syncError: mirror.sync_error,
    messageCount: messageCount?.count || 0
  });
}
__name(getGmailStatus, "getGmailStatus");
async function runGmailSync(env, userId, dashboardId, accessToken) {
  if (!accessToken) {
    accessToken = await getGmailAccessToken(env, userId);
  }
  await env.DB.prepare(`
    UPDATE gmail_mirrors SET status = 'syncing', sync_error = null, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(dashboardId).run();
  try {
    const mirror = await env.DB.prepare(`
      SELECT label_ids FROM gmail_mirrors WHERE dashboard_id = ?
    `).bind(dashboardId).first();
    let labelIds = ["INBOX"];
    try {
      labelIds = JSON.parse(mirror?.label_ids || '["INBOX"]');
    } catch {
      labelIds = ["INBOX"];
    }
    const listResult = await listGmailMessages(accessToken, labelIds, 20);
    const messages = listResult.messages || [];
    for (const msg of messages) {
      const fullMsg = await getGmailMessage(accessToken, msg.id, "metadata");
      const fromHeader = extractHeader(fullMsg, "From");
      const toHeader = extractHeader(fullMsg, "To");
      const subject = extractHeader(fullMsg, "Subject");
      await env.DB.prepare(`
        INSERT INTO gmail_messages (
          id, user_id, dashboard_id, message_id, thread_id, internal_date,
          from_header, to_header, subject, snippet, labels, size_estimate, body_state,
          updated_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'snippet', datetime('now'), datetime('now'))
        ON CONFLICT(dashboard_id, message_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          from_header = excluded.from_header,
          to_header = excluded.to_header,
          subject = excluded.subject,
          snippet = excluded.snippet,
          labels = excluded.labels,
          size_estimate = excluded.size_estimate,
          updated_at = datetime('now')
      `).bind(
        crypto.randomUUID(),
        userId,
        dashboardId,
        fullMsg.id,
        fullMsg.threadId,
        fullMsg.internalDate || (/* @__PURE__ */ new Date()).toISOString(),
        fromHeader,
        toHeader,
        subject,
        fullMsg.snippet || null,
        JSON.stringify(fullMsg.labelIds || []),
        fullMsg.sizeEstimate || 0
      ).run();
    }
    let historyId = null;
    if (messages.length > 0) {
      const latestMsg = await getGmailMessage(accessToken, messages[0].id, "minimal");
      const profile = await getGmailProfile(accessToken);
      historyId = profile.emailAddress ? null : null;
    }
    await env.DB.prepare(`
      UPDATE gmail_mirrors
      SET status = 'ready', last_synced_at = datetime('now'), updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(dashboardId).run();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown sync error";
    await env.DB.prepare(`
      UPDATE gmail_mirrors SET status = 'error', sync_error = ?, updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(errorMessage, dashboardId).run();
    throw error;
  }
}
__name(runGmailSync, "runGmailSync");
async function syncGmailMirror(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId) {
    return Response.json({ error: "E79907: dashboardId is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79908: Not found or no access" }, { status: 404 });
  }
  try {
    await runGmailSync(env, auth.user.id, data.dashboardId);
    return Response.json({ ok: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Sync failed";
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}
__name(syncGmailMirror, "syncGmailMirror");
async function getGmailMessages(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0");
  if (!dashboardId) {
    return Response.json({ error: "E79909: dashboard_id is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79910: Not found or no access" }, { status: 404 });
  }
  const messages = await env.DB.prepare(`
    SELECT message_id, thread_id, internal_date, from_header, to_header, subject, snippet, labels, size_estimate, body_state
    FROM gmail_messages
    WHERE dashboard_id = ?
    ORDER BY internal_date DESC
    LIMIT ? OFFSET ?
  `).bind(dashboardId, limit, offset).all();
  const totalCount = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM gmail_messages WHERE dashboard_id = ?
  `).bind(dashboardId).first();
  return Response.json({
    messages: (messages.results || []).map((m) => ({
      messageId: m.message_id,
      threadId: m.thread_id,
      internalDate: m.internal_date,
      from: m.from_header,
      to: m.to_header,
      subject: m.subject,
      snippet: m.snippet,
      labels: JSON.parse(m.labels || "[]"),
      sizeEstimate: m.size_estimate,
      bodyState: m.body_state
    })),
    total: totalCount?.count || 0,
    limit,
    offset
  });
}
__name(getGmailMessages, "getGmailMessages");
async function getGmailMessageDetail(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  const messageId = url.searchParams.get("message_id");
  const format = url.searchParams.get("format") || "metadata";
  if (!dashboardId || !messageId) {
    return Response.json({ error: "E79911: dashboard_id and message_id are required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79912: Not found or no access" }, { status: 404 });
  }
  try {
    const accessToken = await getGmailAccessToken(env, auth.user.id);
    const gmailFormat = format === "full" ? "full" : "metadata";
    const message = await getGmailMessage(accessToken, messageId, gmailFormat);
    return Response.json({
      messageId: message.id,
      threadId: message.threadId,
      labels: message.labelIds || [],
      snippet: message.snippet,
      payload: message.payload,
      internalDate: message.internalDate,
      sizeEstimate: message.sizeEstimate
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Failed to fetch message";
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}
__name(getGmailMessageDetail, "getGmailMessageDetail");
async function performGmailAction(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId || !data.messageId || !data.action) {
    return Response.json({ error: "E79913: dashboardId, messageId, and action are required" }, { status: 400 });
  }
  const validActions = ["archive", "trash", "mark_read", "mark_unread", "label_add", "label_remove"];
  if (!validActions.includes(data.action)) {
    return Response.json({ error: "E79914: Invalid action" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79915: Not found or no access" }, { status: 404 });
  }
  try {
    const accessToken = await getGmailAccessToken(env, auth.user.id);
    let addLabelIds = [];
    let removeLabelIds = [];
    switch (data.action) {
      case "archive":
        removeLabelIds = ["INBOX"];
        break;
      case "trash":
        addLabelIds = ["TRASH"];
        break;
      case "mark_read":
        removeLabelIds = ["UNREAD"];
        break;
      case "mark_unread":
        addLabelIds = ["UNREAD"];
        break;
      case "label_add":
        addLabelIds = data.labelIds || [];
        break;
      case "label_remove":
        removeLabelIds = data.labelIds || [];
        break;
    }
    const result = await modifyGmailMessage(accessToken, data.messageId, addLabelIds, removeLabelIds);
    await env.DB.prepare(`
      INSERT INTO gmail_actions (id, user_id, dashboard_id, message_id, action, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      crypto.randomUUID(),
      auth.user.id,
      data.dashboardId,
      data.messageId,
      data.action,
      JSON.stringify({ addLabelIds, removeLabelIds })
    ).run();
    await env.DB.prepare(`
      UPDATE gmail_messages SET labels = ?, updated_at = datetime('now')
      WHERE dashboard_id = ? AND message_id = ?
    `).bind(
      JSON.stringify(result.labelIds || []),
      data.dashboardId,
      data.messageId
    ).run();
    return Response.json({ ok: true, labels: result.labelIds });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Action failed";
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}
__name(performGmailAction, "performGmailAction");
async function startGmailWatch(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId) {
    return Response.json({ error: "E79916: dashboardId is required" }, { status: 400 });
  }
  if (!env.GMAIL_PUBSUB_TOPIC) {
    return Response.json({ error: "E79917: Gmail Pub/Sub is not configured" }, { status: 500 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79918: Not found or no access" }, { status: 404 });
  }
  try {
    const accessToken = await getGmailAccessToken(env, auth.user.id);
    const mirror = await env.DB.prepare(`
      SELECT label_ids FROM gmail_mirrors WHERE dashboard_id = ?
    `).bind(data.dashboardId).first();
    let labelIds = ["INBOX"];
    try {
      labelIds = JSON.parse(mirror?.label_ids || '["INBOX"]');
    } catch {
      labelIds = ["INBOX"];
    }
    const watchResult = await setupGmailWatch(accessToken, env.GMAIL_PUBSUB_TOPIC, labelIds);
    await env.DB.prepare(`
      UPDATE gmail_mirrors
      SET history_id = ?, watch_expiration = ?, status = 'watching', updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(
      watchResult.historyId,
      watchResult.expiration,
      data.dashboardId
    ).run();
    return Response.json({
      ok: true,
      historyId: watchResult.historyId,
      expiration: watchResult.expiration
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Failed to start watch";
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}
__name(startGmailWatch, "startGmailWatch");
async function stopGmailWatchEndpoint(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId) {
    return Response.json({ error: "E79919: dashboardId is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79920: Not found or no access" }, { status: 404 });
  }
  try {
    const accessToken = await getGmailAccessToken(env, auth.user.id);
    await stopGmailWatch(accessToken);
    await env.DB.prepare(`
      UPDATE gmail_mirrors
      SET watch_expiration = null, status = 'ready', updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(data.dashboardId).run();
    return Response.json({ ok: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Failed to stop watch";
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}
__name(stopGmailWatchEndpoint, "stopGmailWatchEndpoint");
async function handleGmailPush(request, env) {
  try {
    const body = await request.json();
    if (!body.message?.data) {
      return Response.json({ error: "Missing message data" }, { status: 400 });
    }
    const decoded = atob(body.message.data);
    const notification = JSON.parse(decoded);
    const mirrors = await env.DB.prepare(`
      SELECT dashboard_id, user_id, history_id, label_ids
      FROM gmail_mirrors
      WHERE email_address = ? AND status IN ('watching', 'ready')
    `).bind(notification.emailAddress).all();
    for (const mirror of mirrors.results || []) {
      if (!mirror.history_id) {
        continue;
      }
      try {
        const accessToken = await getGmailAccessToken(env, mirror.user_id);
        const history = await getGmailHistory(
          accessToken,
          mirror.history_id,
          void 0,
          100
        );
        if (history.history) {
          for (const record of history.history) {
            if (record.messagesAdded) {
              for (const added of record.messagesAdded) {
                const msg = added.message;
                const fullMsg = await getGmailMessage(accessToken, msg.id, "metadata");
                const fromHeader = extractHeader(fullMsg, "From");
                const toHeader = extractHeader(fullMsg, "To");
                const subject = extractHeader(fullMsg, "Subject");
                await env.DB.prepare(`
                  INSERT INTO gmail_messages (
                    id, user_id, dashboard_id, message_id, thread_id, internal_date,
                    from_header, to_header, subject, snippet, labels, size_estimate, body_state,
                    updated_at, created_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'snippet', datetime('now'), datetime('now'))
                  ON CONFLICT(dashboard_id, message_id) DO UPDATE SET
                    labels = excluded.labels,
                    updated_at = datetime('now')
                `).bind(
                  crypto.randomUUID(),
                  mirror.user_id,
                  mirror.dashboard_id,
                  fullMsg.id,
                  fullMsg.threadId,
                  fullMsg.internalDate || (/* @__PURE__ */ new Date()).toISOString(),
                  fromHeader,
                  toHeader,
                  subject,
                  fullMsg.snippet || null,
                  JSON.stringify(fullMsg.labelIds || []),
                  fullMsg.sizeEstimate || 0
                ).run();
              }
            }
            if (record.messagesDeleted) {
              for (const deleted of record.messagesDeleted) {
                await env.DB.prepare(`
                  DELETE FROM gmail_messages WHERE dashboard_id = ? AND message_id = ?
                `).bind(mirror.dashboard_id, deleted.message.id).run();
              }
            }
          }
        }
        await env.DB.prepare(`
          UPDATE gmail_mirrors SET history_id = ?, last_synced_at = datetime('now'), updated_at = datetime('now')
          WHERE dashboard_id = ?
        `).bind(history.historyId, mirror.dashboard_id).run();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Sync error";
        console.error(`Gmail push sync failed for ${mirror.dashboard_id}: ${errorMessage}`);
        if (errorMessage === "HISTORY_EXPIRED") {
          await env.DB.prepare(`
            UPDATE gmail_mirrors SET history_id = null, status = 'ready', sync_error = 'History expired, full resync needed'
            WHERE dashboard_id = ?
          `).bind(mirror.dashboard_id).run();
        }
      }
    }
    return Response.json({ ok: true });
  } catch (error) {
    console.error("Gmail push handler error:", error);
    return Response.json({ error: "Push processing failed" }, { status: 500 });
  }
}
__name(handleGmailPush, "handleGmailPush");
async function disconnectGmail(_request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  try {
    const accessToken = await getGmailAccessToken(env, auth.user.id);
    await stopGmailWatch(accessToken);
  } catch {
  }
  const mirrors = await env.DB.prepare(`
    SELECT dashboard_id FROM gmail_mirrors WHERE user_id = ?
  `).bind(auth.user.id).all();
  for (const mirror of mirrors.results || []) {
    await env.DB.prepare(`DELETE FROM gmail_messages WHERE dashboard_id = ?`).bind(mirror.dashboard_id).run();
    await env.DB.prepare(`DELETE FROM gmail_actions WHERE dashboard_id = ?`).bind(mirror.dashboard_id).run();
  }
  await env.DB.prepare(`DELETE FROM gmail_mirrors WHERE user_id = ?`).bind(auth.user.id).run();
  await env.DB.prepare(`DELETE FROM user_integrations WHERE user_id = ? AND provider = 'gmail'`).bind(auth.user.id).run();
  return Response.json({ ok: true });
}
__name(disconnectGmail, "disconnectGmail");
async function refreshCalendarAccessToken(env, userId) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth is not configured.");
  }
  const record = await env.DB.prepare(`
    SELECT access_token, refresh_token FROM user_integrations
    WHERE user_id = ? AND provider = 'google_calendar'
  `).bind(userId).first();
  if (!record?.refresh_token) {
    throw new Error("Calendar must be connected again.");
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
    if (tokenResponse.status === 400 || tokenResponse.status === 401) {
      throw new Error("TOKEN_REVOKED");
    }
    throw new Error("Failed to refresh Calendar access token.");
  }
  const tokenData = await tokenResponse.json();
  const now = /* @__PURE__ */ new Date();
  const expiresAt = tokenData.expires_in ? new Date(now.getTime() + tokenData.expires_in * 1e3).toISOString() : null;
  await env.DB.prepare(`
    UPDATE user_integrations
    SET access_token = ?, scope = ?, token_type = ?, expires_at = ?, updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'google_calendar'
  `).bind(
    tokenData.access_token,
    tokenData.scope || null,
    tokenData.token_type || null,
    expiresAt,
    userId
  ).run();
  return tokenData.access_token;
}
__name(refreshCalendarAccessToken, "refreshCalendarAccessToken");
async function getCalendarAccessToken(env, userId) {
  const record = await env.DB.prepare(`
    SELECT access_token, expires_at FROM user_integrations
    WHERE user_id = ? AND provider = 'google_calendar'
  `).bind(userId).first();
  if (!record) {
    throw new Error("Calendar not connected.");
  }
  if (record.expires_at) {
    const expiresAt = new Date(record.expires_at).getTime();
    const now = Date.now();
    if (expiresAt - now < 5 * 60 * 1e3) {
      return refreshCalendarAccessToken(env, userId);
    }
  }
  return record.access_token;
}
__name(getCalendarAccessToken, "getCalendarAccessToken");
async function getCalendarProfile(accessToken) {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error("TOKEN_REVOKED");
    }
    throw new Error("Failed to fetch calendar profile.");
  }
  const data = await res.json();
  return { email: data.email, name: data.name };
}
__name(getCalendarProfile, "getCalendarProfile");
async function listCalendarEvents(accessToken, calendarId = "primary", timeMin, timeMax, maxResults = 50, pageToken, syncToken) {
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("maxResults", String(maxResults));
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  if (syncToken) {
    url.searchParams.set("syncToken", syncToken);
  } else {
    if (timeMin) {
      url.searchParams.set("timeMin", timeMin);
    }
    if (timeMax) {
      url.searchParams.set("timeMax", timeMax);
    }
  }
  if (pageToken) {
    url.searchParams.set("pageToken", pageToken);
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    if (res.status === 410) {
      throw new Error("SYNC_TOKEN_EXPIRED");
    }
    throw new Error("Failed to list calendar events.");
  }
  return res.json();
}
__name(listCalendarEvents, "listCalendarEvents");
async function getCalendarEvent(accessToken, calendarId, eventId) {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    throw new Error("Failed to fetch calendar event.");
  }
  return res.json();
}
__name(getCalendarEvent, "getCalendarEvent");
async function connectCalendar(request, env, auth) {
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
  await createState(env, auth.user.id, "google_calendar", state, {
    dashboard_id: dashboardId,
    popup: mode === "popup"
  });
  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/calendar/callback`;
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", CALENDAR_SCOPE.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("state", state);
  return Response.redirect(authUrl.toString(), 302);
}
__name(connectCalendar, "connectCalendar");
async function callbackCalendar(request, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return renderErrorPage("Google OAuth is not configured.");
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return renderErrorPage("Missing authorization code.");
  }
  const stateData = await consumeState(env, state, "google_calendar");
  if (!stateData) {
    return renderErrorPage("Invalid or expired state.");
  }
  const dashboardId = typeof stateData.metadata.dashboard_id === "string" ? stateData.metadata.dashboard_id : null;
  const popup = stateData.metadata.popup === true;
  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/calendar/callback`;
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
  let emailAddress = "";
  try {
    const profile = await getCalendarProfile(tokenData.access_token);
    emailAddress = profile.email;
  } catch {
  }
  const metadata = JSON.stringify({
    scope: tokenData.scope,
    token_type: tokenData.token_type,
    email_address: emailAddress
  });
  await env.DB.prepare(`
    INSERT INTO user_integrations (
      id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata
    ) VALUES (?, ?, 'google_calendar', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
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
  const frontendUrl = env.FRONTEND_URL || "https://orcabot.com";
  if (popup) {
    return renderProviderAuthCompletePage(frontendUrl, "Calendar", "calendar-auth-complete", dashboardId);
  }
  return renderSuccessPage("Google Calendar");
}
__name(callbackCalendar, "callbackCalendar");
async function getCalendarIntegration(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  const integration = await env.DB.prepare(`
    SELECT metadata FROM user_integrations WHERE user_id = ? AND provider = 'google_calendar'
  `).bind(auth.user.id).first();
  if (!integration) {
    return Response.json({ connected: false, linked: false, emailAddress: null });
  }
  let metadata = {};
  try {
    metadata = JSON.parse(integration.metadata || "{}");
  } catch {
    metadata = {};
  }
  if (!dashboardId) {
    return Response.json({
      connected: true,
      linked: false,
      emailAddress: metadata.email_address || null
    });
  }
  const mirror = await env.DB.prepare(`
    SELECT email_address, calendar_id, status, last_synced_at
    FROM calendar_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!mirror) {
    return Response.json({
      connected: true,
      linked: false,
      emailAddress: metadata.email_address || null
    });
  }
  return Response.json({
    connected: true,
    linked: true,
    emailAddress: mirror.email_address,
    calendarId: mirror.calendar_id,
    status: mirror.status,
    lastSyncedAt: mirror.last_synced_at
  });
}
__name(getCalendarIntegration, "getCalendarIntegration");
async function setupCalendarMirror(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId) {
    return Response.json({ error: "E79930: dashboardId is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79931: Not found or no access" }, { status: 404 });
  }
  let accessToken;
  try {
    accessToken = await getCalendarAccessToken(env, auth.user.id);
  } catch (err) {
    if (err instanceof Error && err.message === "TOKEN_REVOKED") {
      return Response.json({
        error: "E79933: Calendar access was revoked. Please reconnect.",
        code: "TOKEN_REVOKED"
      }, { status: 401 });
    }
    return Response.json({ error: "E79932: Calendar not connected" }, { status: 404 });
  }
  let profile;
  try {
    profile = await getCalendarProfile(accessToken);
  } catch (err) {
    if (err instanceof Error && err.message === "TOKEN_REVOKED") {
      return Response.json({
        error: "E79933: Calendar access was revoked. Please reconnect.",
        code: "TOKEN_REVOKED"
      }, { status: 401 });
    }
    throw err;
  }
  const calendarId = data.calendarId || "primary";
  await env.DB.prepare(`
    INSERT INTO calendar_mirrors (
      dashboard_id, user_id, email_address, calendar_id, status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, 'idle', datetime('now'), datetime('now'))
    ON CONFLICT(dashboard_id) DO UPDATE SET
      email_address = excluded.email_address,
      calendar_id = excluded.calendar_id,
      status = 'idle',
      updated_at = datetime('now')
  `).bind(
    data.dashboardId,
    auth.user.id,
    profile.email,
    calendarId
  ).run();
  try {
    await runCalendarSync(env, auth.user.id, data.dashboardId, accessToken);
  } catch (error) {
    console.error("Initial calendar sync failed:", error);
  }
  return Response.json({ ok: true, emailAddress: profile.email });
}
__name(setupCalendarMirror, "setupCalendarMirror");
async function unlinkCalendarMirror(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "E79933: dashboard_id is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79934: Not found or no access" }, { status: 404 });
  }
  await env.DB.prepare(`DELETE FROM calendar_events WHERE dashboard_id = ?`).bind(dashboardId).run();
  await env.DB.prepare(`DELETE FROM calendar_mirrors WHERE dashboard_id = ?`).bind(dashboardId).run();
  return Response.json({ ok: true });
}
__name(unlinkCalendarMirror, "unlinkCalendarMirror");
async function getCalendarStatus(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "E79935: dashboard_id is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79936: Not found or no access" }, { status: 404 });
  }
  const mirror = await env.DB.prepare(`
    SELECT email_address, calendar_id, status, sync_token, last_synced_at, sync_error
    FROM calendar_mirrors
    WHERE dashboard_id = ?
  `).bind(dashboardId).first();
  if (!mirror) {
    return Response.json({ connected: false });
  }
  const countResult = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM calendar_events WHERE dashboard_id = ?
  `).bind(dashboardId).first();
  return Response.json({
    connected: true,
    emailAddress: mirror.email_address,
    calendarId: mirror.calendar_id,
    status: mirror.status,
    lastSyncedAt: mirror.last_synced_at,
    syncError: mirror.sync_error,
    eventCount: countResult?.count || 0
  });
}
__name(getCalendarStatus, "getCalendarStatus");
async function runCalendarSync(env, userId, dashboardId, accessToken) {
  if (!accessToken) {
    accessToken = await getCalendarAccessToken(env, userId);
  }
  await env.DB.prepare(`
    UPDATE calendar_mirrors SET status = 'syncing', sync_error = null, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(dashboardId).run();
  try {
    const mirror = await env.DB.prepare(`
      SELECT calendar_id, sync_token FROM calendar_mirrors WHERE dashboard_id = ?
    `).bind(dashboardId).first();
    const calendarId = mirror?.calendar_id || "primary";
    let syncToken = mirror?.sync_token;
    const now = /* @__PURE__ */ new Date();
    const timeMin = syncToken ? void 0 : now.toISOString();
    const timeMax = syncToken ? void 0 : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1e3).toISOString();
    let listResult;
    try {
      listResult = await listCalendarEvents(accessToken, calendarId, timeMin, timeMax, 50, void 0, syncToken || void 0);
    } catch (error) {
      if (error instanceof Error && error.message === "SYNC_TOKEN_EXPIRED") {
        syncToken = null;
        listResult = await listCalendarEvents(accessToken, calendarId, now.toISOString(), new Date(now.getTime() + 30 * 24 * 60 * 60 * 1e3).toISOString(), 50);
        await env.DB.prepare(`DELETE FROM calendar_events WHERE dashboard_id = ?`).bind(dashboardId).run();
      } else {
        throw error;
      }
    }
    const events = listResult.items || [];
    for (const event of events) {
      if (!event.id)
        continue;
      const startTime = event.start?.dateTime || event.start?.date || "";
      const endTime = event.end?.dateTime || event.end?.date || "";
      const allDay = !event.start?.dateTime && !!event.start?.date ? 1 : 0;
      await env.DB.prepare(`
        INSERT INTO calendar_events (
          id, user_id, dashboard_id, event_id, calendar_id,
          summary, description, location, start_time, end_time, all_day,
          status, html_link, organizer_email, attendees,
          updated_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(dashboard_id, event_id) DO UPDATE SET
          summary = excluded.summary,
          description = excluded.description,
          location = excluded.location,
          start_time = excluded.start_time,
          end_time = excluded.end_time,
          all_day = excluded.all_day,
          status = excluded.status,
          html_link = excluded.html_link,
          organizer_email = excluded.organizer_email,
          attendees = excluded.attendees,
          updated_at = datetime('now')
      `).bind(
        crypto.randomUUID(),
        userId,
        dashboardId,
        event.id,
        calendarId,
        event.summary || null,
        event.description || null,
        event.location || null,
        startTime,
        endTime,
        allDay,
        event.status || null,
        event.htmlLink || null,
        event.organizer?.email || null,
        JSON.stringify(event.attendees || [])
      ).run();
    }
    await env.DB.prepare(`
      UPDATE calendar_mirrors
      SET sync_token = ?, status = 'ready', last_synced_at = datetime('now'), updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(
      listResult.nextSyncToken || null,
      dashboardId
    ).run();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Sync failed";
    await env.DB.prepare(`
      UPDATE calendar_mirrors SET status = 'error', sync_error = ?, updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(errorMessage, dashboardId).run();
    throw error;
  }
}
__name(runCalendarSync, "runCalendarSync");
async function syncCalendarMirror(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId) {
    return Response.json({ error: "E79937: dashboardId is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79938: Not found or no access" }, { status: 404 });
  }
  try {
    await runCalendarSync(env, auth.user.id, data.dashboardId);
    return Response.json({ ok: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Sync failed";
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}
__name(syncCalendarMirror, "syncCalendarMirror");
async function getCalendarEvents(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);
  const timeMin = url.searchParams.get("time_min");
  const timeMax = url.searchParams.get("time_max");
  if (!dashboardId) {
    return Response.json({ error: "E79939: dashboard_id is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79940: Not found or no access" }, { status: 404 });
  }
  let query = `
    SELECT event_id, calendar_id, summary, description, location,
           start_time, end_time, all_day, status, html_link, organizer_email, attendees
    FROM calendar_events
    WHERE dashboard_id = ?
  `;
  const params = [dashboardId];
  if (timeMin) {
    query += ` AND start_time >= ?`;
    params.push(timeMin);
  }
  if (timeMax) {
    query += ` AND start_time <= ?`;
    params.push(timeMax);
  }
  query += ` ORDER BY start_time ASC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  const events = await env.DB.prepare(query).bind(...params).all();
  const countResult = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM calendar_events WHERE dashboard_id = ?
  `).bind(dashboardId).first();
  const formatted = (events.results || []).map((e) => ({
    eventId: e.event_id,
    calendarId: e.calendar_id,
    summary: e.summary,
    description: e.description,
    location: e.location,
    startTime: e.start_time,
    endTime: e.end_time,
    allDay: e.all_day === 1,
    status: e.status,
    htmlLink: e.html_link,
    organizerEmail: e.organizer_email,
    attendees: JSON.parse(e.attendees || "[]")
  }));
  return Response.json({
    events: formatted,
    total: countResult?.count || 0,
    limit,
    offset
  });
}
__name(getCalendarEvents, "getCalendarEvents");
async function getCalendarEventDetail(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  const eventId = url.searchParams.get("event_id");
  if (!dashboardId || !eventId) {
    return Response.json({ error: "E79941: dashboard_id and event_id are required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79942: Not found or no access" }, { status: 404 });
  }
  try {
    const accessToken = await getCalendarAccessToken(env, auth.user.id);
    const mirror = await env.DB.prepare(`
      SELECT calendar_id FROM calendar_mirrors WHERE dashboard_id = ?
    `).bind(dashboardId).first();
    const calendarId = mirror?.calendar_id || "primary";
    const event = await getCalendarEvent(accessToken, calendarId, eventId);
    return Response.json({
      eventId: event.id,
      calendarId,
      summary: event.summary,
      description: event.description,
      location: event.location,
      startTime: event.start?.dateTime || event.start?.date,
      endTime: event.end?.dateTime || event.end?.date,
      allDay: !event.start?.dateTime && !!event.start?.date,
      status: event.status,
      htmlLink: event.htmlLink,
      organizerEmail: event.organizer?.email,
      attendees: event.attendees || []
    });
  } catch {
    const cached = await env.DB.prepare(`
      SELECT event_id, calendar_id, summary, description, location,
             start_time, end_time, all_day, status, html_link, organizer_email, attendees
      FROM calendar_events
      WHERE dashboard_id = ? AND event_id = ?
    `).bind(dashboardId, eventId).first();
    if (!cached) {
      return Response.json({ error: "E79943: Event not found" }, { status: 404 });
    }
    return Response.json({
      eventId: cached.event_id,
      calendarId: cached.calendar_id,
      summary: cached.summary,
      description: cached.description,
      location: cached.location,
      startTime: cached.start_time,
      endTime: cached.end_time,
      allDay: cached.all_day === 1,
      status: cached.status,
      htmlLink: cached.html_link,
      organizerEmail: cached.organizer_email,
      attendees: JSON.parse(cached.attendees || "[]")
    });
  }
}
__name(getCalendarEventDetail, "getCalendarEventDetail");
async function disconnectCalendar(_request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const mirrors = await env.DB.prepare(`
    SELECT dashboard_id FROM calendar_mirrors WHERE user_id = ?
  `).bind(auth.user.id).all();
  for (const mirror of mirrors.results || []) {
    await env.DB.prepare(`DELETE FROM calendar_events WHERE dashboard_id = ?`).bind(mirror.dashboard_id).run();
  }
  await env.DB.prepare(`DELETE FROM calendar_mirrors WHERE user_id = ?`).bind(auth.user.id).run();
  await env.DB.prepare(`DELETE FROM user_integrations WHERE user_id = ? AND provider = 'google_calendar'`).bind(auth.user.id).run();
  return Response.json({ ok: true });
}
__name(disconnectCalendar, "disconnectCalendar");
async function refreshContactsAccessToken(env, userId) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth is not configured.");
  }
  const record = await env.DB.prepare(`
    SELECT access_token, refresh_token FROM user_integrations
    WHERE user_id = ? AND provider = 'google_contacts'
  `).bind(userId).first();
  if (!record?.refresh_token) {
    throw new Error("Contacts must be connected again.");
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
    if (tokenResponse.status === 400 || tokenResponse.status === 401) {
      throw new Error("TOKEN_REVOKED");
    }
    throw new Error("Failed to refresh Contacts access token.");
  }
  const tokenData = await tokenResponse.json();
  const now = /* @__PURE__ */ new Date();
  const expiresAt = tokenData.expires_in ? new Date(now.getTime() + tokenData.expires_in * 1e3).toISOString() : null;
  await env.DB.prepare(`
    UPDATE user_integrations
    SET access_token = ?, scope = ?, token_type = ?, expires_at = ?, updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'google_contacts'
  `).bind(
    tokenData.access_token,
    tokenData.scope || null,
    tokenData.token_type || null,
    expiresAt,
    userId
  ).run();
  return tokenData.access_token;
}
__name(refreshContactsAccessToken, "refreshContactsAccessToken");
async function getContactsAccessToken(env, userId) {
  const record = await env.DB.prepare(`
    SELECT access_token, expires_at FROM user_integrations
    WHERE user_id = ? AND provider = 'google_contacts'
  `).bind(userId).first();
  if (!record) {
    throw new Error("Contacts not connected.");
  }
  if (record.expires_at) {
    const expiresAt = new Date(record.expires_at).getTime();
    const now = Date.now();
    if (expiresAt - now < 5 * 60 * 1e3) {
      return refreshContactsAccessToken(env, userId);
    }
  }
  return record.access_token;
}
__name(getContactsAccessToken, "getContactsAccessToken");
async function getContactsProfile(accessToken) {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error("TOKEN_REVOKED");
    }
    throw new Error("Failed to fetch contacts profile.");
  }
  const data = await res.json();
  return { email: data.email, name: data.name };
}
__name(getContactsProfile, "getContactsProfile");
async function listGoogleContacts(accessToken, pageSize = 100, pageToken, syncToken) {
  const url = new URL("https://people.googleapis.com/v1/people/me/connections");
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("personFields", "names,emailAddresses,phoneNumbers,organizations,photos,biographies");
  if (syncToken) {
    url.searchParams.set("syncToken", syncToken);
  }
  if (pageToken) {
    url.searchParams.set("pageToken", pageToken);
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    if (res.status === 410) {
      throw new Error("SYNC_TOKEN_EXPIRED");
    }
    throw new Error("Failed to list contacts.");
  }
  return res.json();
}
__name(listGoogleContacts, "listGoogleContacts");
async function getGoogleContact(accessToken, resourceName) {
  const url = new URL(`https://people.googleapis.com/v1/${resourceName}`);
  url.searchParams.set("personFields", "names,emailAddresses,phoneNumbers,organizations,photos,biographies");
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    throw new Error("Failed to fetch contact.");
  }
  return res.json();
}
__name(getGoogleContact, "getGoogleContact");
async function searchGoogleContacts(accessToken, query, pageSize = 30) {
  const url = new URL("https://people.googleapis.com/v1/people:searchContacts");
  url.searchParams.set("query", query);
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("readMask", "names,emailAddresses,phoneNumbers,organizations,photos");
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    throw new Error("Failed to search contacts.");
  }
  const data = await res.json();
  return { results: (data.results || []).map((r) => r.person) };
}
__name(searchGoogleContacts, "searchGoogleContacts");
async function connectContacts(request, env, auth) {
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
  await createState(env, auth.user.id, "google_contacts", state, {
    dashboard_id: dashboardId,
    popup: mode === "popup"
  });
  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/contacts/callback`;
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", CONTACTS_SCOPE.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("state", state);
  return Response.redirect(authUrl.toString(), 302);
}
__name(connectContacts, "connectContacts");
async function callbackContacts(request, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return renderErrorPage("Google OAuth is not configured.");
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return renderErrorPage("Missing authorization code.");
  }
  const stateData = await consumeState(env, state, "google_contacts");
  if (!stateData) {
    return renderErrorPage("Invalid or expired state.");
  }
  const dashboardId = typeof stateData.metadata.dashboard_id === "string" ? stateData.metadata.dashboard_id : null;
  const popup = stateData.metadata.popup === true;
  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/contacts/callback`;
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
  let emailAddress = "";
  try {
    const profile = await getContactsProfile(tokenData.access_token);
    emailAddress = profile.email;
  } catch {
  }
  const metadata = JSON.stringify({
    scope: tokenData.scope,
    token_type: tokenData.token_type,
    email_address: emailAddress
  });
  await env.DB.prepare(`
    INSERT INTO user_integrations (
      id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata
    ) VALUES (?, ?, 'google_contacts', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
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
  const frontendUrl = env.FRONTEND_URL || "https://orcabot.com";
  if (popup) {
    return renderProviderAuthCompletePage(frontendUrl, "Contacts", "contacts-auth-complete", dashboardId);
  }
  return renderSuccessPage("Google Contacts");
}
__name(callbackContacts, "callbackContacts");
async function getContactsIntegration(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  const integration = await env.DB.prepare(`
    SELECT metadata FROM user_integrations WHERE user_id = ? AND provider = 'google_contacts'
  `).bind(auth.user.id).first();
  if (!integration) {
    return Response.json({ connected: false, linked: false, emailAddress: null });
  }
  let metadata = {};
  try {
    metadata = JSON.parse(integration.metadata || "{}");
  } catch {
    metadata = {};
  }
  if (!dashboardId) {
    return Response.json({
      connected: true,
      linked: false,
      emailAddress: metadata.email_address || null
    });
  }
  const mirror = await env.DB.prepare(`
    SELECT email_address, status, last_synced_at
    FROM contacts_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!mirror) {
    return Response.json({
      connected: true,
      linked: false,
      emailAddress: metadata.email_address || null
    });
  }
  return Response.json({
    connected: true,
    linked: true,
    emailAddress: mirror.email_address,
    status: mirror.status,
    lastSyncedAt: mirror.last_synced_at
  });
}
__name(getContactsIntegration, "getContactsIntegration");
async function setupContactsMirror(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId) {
    return Response.json({ error: "E79950: dashboardId is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79951: Not found or no access" }, { status: 404 });
  }
  let accessToken;
  try {
    accessToken = await getContactsAccessToken(env, auth.user.id);
  } catch (err) {
    if (err instanceof Error && err.message === "TOKEN_REVOKED") {
      return Response.json({
        error: "E79953: Contacts access was revoked. Please reconnect.",
        code: "TOKEN_REVOKED"
      }, { status: 401 });
    }
    return Response.json({ error: "E79952: Contacts not connected" }, { status: 404 });
  }
  let profile;
  try {
    profile = await getContactsProfile(accessToken);
  } catch (err) {
    if (err instanceof Error && err.message === "TOKEN_REVOKED") {
      return Response.json({
        error: "E79953: Contacts access was revoked. Please reconnect.",
        code: "TOKEN_REVOKED"
      }, { status: 401 });
    }
    throw err;
  }
  await env.DB.prepare(`
    INSERT INTO contacts_mirrors (
      dashboard_id, user_id, email_address, status, updated_at, created_at
    ) VALUES (?, ?, ?, 'idle', datetime('now'), datetime('now'))
    ON CONFLICT(dashboard_id) DO UPDATE SET
      email_address = excluded.email_address,
      status = 'idle',
      updated_at = datetime('now')
  `).bind(
    data.dashboardId,
    auth.user.id,
    profile.email
  ).run();
  try {
    await runContactsSync(env, auth.user.id, data.dashboardId, accessToken);
  } catch (error) {
    console.error("Initial contacts sync failed:", error);
  }
  return Response.json({ ok: true, emailAddress: profile.email });
}
__name(setupContactsMirror, "setupContactsMirror");
async function unlinkContactsMirror(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "E79953: dashboard_id is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79954: Not found or no access" }, { status: 404 });
  }
  await env.DB.prepare(`DELETE FROM contacts WHERE dashboard_id = ?`).bind(dashboardId).run();
  await env.DB.prepare(`DELETE FROM contacts_mirrors WHERE dashboard_id = ?`).bind(dashboardId).run();
  return Response.json({ ok: true });
}
__name(unlinkContactsMirror, "unlinkContactsMirror");
async function getContactsStatus(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "E79955: dashboard_id is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79956: Not found or no access" }, { status: 404 });
  }
  const mirror = await env.DB.prepare(`
    SELECT email_address, status, sync_token, last_synced_at, sync_error
    FROM contacts_mirrors
    WHERE dashboard_id = ?
  `).bind(dashboardId).first();
  if (!mirror) {
    return Response.json({ connected: false });
  }
  const countResult = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM contacts WHERE dashboard_id = ?
  `).bind(dashboardId).first();
  return Response.json({
    connected: true,
    emailAddress: mirror.email_address,
    status: mirror.status,
    lastSyncedAt: mirror.last_synced_at,
    syncError: mirror.sync_error,
    contactCount: countResult?.count || 0
  });
}
__name(getContactsStatus, "getContactsStatus");
async function runContactsSync(env, userId, dashboardId, accessToken) {
  if (!accessToken) {
    accessToken = await getContactsAccessToken(env, userId);
  }
  await env.DB.prepare(`
    UPDATE contacts_mirrors SET status = 'syncing', sync_error = null, updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(dashboardId).run();
  try {
    const mirror = await env.DB.prepare(`
      SELECT sync_token FROM contacts_mirrors WHERE dashboard_id = ?
    `).bind(dashboardId).first();
    let syncToken = mirror?.sync_token;
    let listResult;
    try {
      listResult = await listGoogleContacts(accessToken, 100, void 0, syncToken || void 0);
    } catch (error) {
      if (error instanceof Error && error.message === "SYNC_TOKEN_EXPIRED") {
        syncToken = null;
        listResult = await listGoogleContacts(accessToken, 100);
        await env.DB.prepare(`DELETE FROM contacts WHERE dashboard_id = ?`).bind(dashboardId).run();
      } else {
        throw error;
      }
    }
    const contacts = listResult.connections || [];
    for (const contact of contacts) {
      if (!contact.resourceName)
        continue;
      const displayName = contact.names?.[0]?.displayName || null;
      const givenName = contact.names?.[0]?.givenName || null;
      const familyName = contact.names?.[0]?.familyName || null;
      const photoUrl = contact.photos?.[0]?.url || null;
      const notes = contact.biographies?.[0]?.value || null;
      await env.DB.prepare(`
        INSERT INTO contacts (
          id, user_id, dashboard_id, resource_name,
          display_name, given_name, family_name,
          email_addresses, phone_numbers, organizations,
          photo_url, notes, updated_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(dashboard_id, resource_name) DO UPDATE SET
          display_name = excluded.display_name,
          given_name = excluded.given_name,
          family_name = excluded.family_name,
          email_addresses = excluded.email_addresses,
          phone_numbers = excluded.phone_numbers,
          organizations = excluded.organizations,
          photo_url = excluded.photo_url,
          notes = excluded.notes,
          updated_at = datetime('now')
      `).bind(
        crypto.randomUUID(),
        userId,
        dashboardId,
        contact.resourceName,
        displayName,
        givenName,
        familyName,
        JSON.stringify(contact.emailAddresses || []),
        JSON.stringify(contact.phoneNumbers || []),
        JSON.stringify(contact.organizations || []),
        photoUrl,
        notes
      ).run();
    }
    await env.DB.prepare(`
      UPDATE contacts_mirrors
      SET sync_token = ?, status = 'ready', last_synced_at = datetime('now'), updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(
      listResult.nextSyncToken || null,
      dashboardId
    ).run();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Sync failed";
    await env.DB.prepare(`
      UPDATE contacts_mirrors SET status = 'error', sync_error = ?, updated_at = datetime('now')
      WHERE dashboard_id = ?
    `).bind(errorMessage, dashboardId).run();
    throw error;
  }
}
__name(runContactsSync, "runContactsSync");
async function syncContactsMirror(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId) {
    return Response.json({ error: "E79957: dashboardId is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79958: Not found or no access" }, { status: 404 });
  }
  try {
    await runContactsSync(env, auth.user.id, data.dashboardId);
    return Response.json({ ok: true });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Sync failed";
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}
__name(syncContactsMirror, "syncContactsMirror");
async function getContacts(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0", 10);
  const search = url.searchParams.get("search");
  if (!dashboardId) {
    return Response.json({ error: "E79959: dashboard_id is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79960: Not found or no access" }, { status: 404 });
  }
  let query = `
    SELECT resource_name, display_name, given_name, family_name,
           email_addresses, phone_numbers, organizations, photo_url, notes
    FROM contacts
    WHERE dashboard_id = ?
  `;
  const params = [dashboardId];
  if (search) {
    query += ` AND (display_name LIKE ? OR email_addresses LIKE ?)`;
    const searchPattern = `%${search}%`;
    params.push(searchPattern, searchPattern);
  }
  query += ` ORDER BY display_name ASC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  const contacts = await env.DB.prepare(query).bind(...params).all();
  const countResult = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM contacts WHERE dashboard_id = ?
  `).bind(dashboardId).first();
  const formatted = (contacts.results || []).map((c) => ({
    resourceName: c.resource_name,
    displayName: c.display_name,
    givenName: c.given_name,
    familyName: c.family_name,
    emailAddresses: JSON.parse(c.email_addresses || "[]"),
    phoneNumbers: JSON.parse(c.phone_numbers || "[]"),
    organizations: JSON.parse(c.organizations || "[]"),
    photoUrl: c.photo_url,
    notes: c.notes
  }));
  return Response.json({
    contacts: formatted,
    total: countResult?.count || 0,
    limit,
    offset
  });
}
__name(getContacts, "getContacts");
async function getContactDetail(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  const resourceName = url.searchParams.get("resource_name");
  if (!dashboardId || !resourceName) {
    return Response.json({ error: "E79961: dashboard_id and resource_name are required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79962: Not found or no access" }, { status: 404 });
  }
  try {
    const accessToken = await getContactsAccessToken(env, auth.user.id);
    const contact = await getGoogleContact(accessToken, resourceName);
    return Response.json({
      resourceName: contact.resourceName,
      displayName: contact.names?.[0]?.displayName,
      givenName: contact.names?.[0]?.givenName,
      familyName: contact.names?.[0]?.familyName,
      emailAddresses: contact.emailAddresses || [],
      phoneNumbers: contact.phoneNumbers || [],
      organizations: contact.organizations || [],
      photoUrl: contact.photos?.[0]?.url,
      notes: contact.biographies?.[0]?.value
    });
  } catch {
    const cached = await env.DB.prepare(`
      SELECT resource_name, display_name, given_name, family_name,
             email_addresses, phone_numbers, organizations, photo_url, notes
      FROM contacts
      WHERE dashboard_id = ? AND resource_name = ?
    `).bind(dashboardId, resourceName).first();
    if (!cached) {
      return Response.json({ error: "E79963: Contact not found" }, { status: 404 });
    }
    return Response.json({
      resourceName: cached.resource_name,
      displayName: cached.display_name,
      givenName: cached.given_name,
      familyName: cached.family_name,
      emailAddresses: JSON.parse(cached.email_addresses || "[]"),
      phoneNumbers: JSON.parse(cached.phone_numbers || "[]"),
      organizations: JSON.parse(cached.organizations || "[]"),
      photoUrl: cached.photo_url,
      notes: cached.notes
    });
  }
}
__name(getContactDetail, "getContactDetail");
async function searchContactsEndpoint(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  const query = url.searchParams.get("q");
  if (!dashboardId || !query) {
    return Response.json({ error: "E79964: dashboard_id and q are required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79965: Not found or no access" }, { status: 404 });
  }
  try {
    const accessToken = await getContactsAccessToken(env, auth.user.id);
    const result = await searchGoogleContacts(accessToken, query, 30);
    const contacts = result.results.map((c) => ({
      resourceName: c.resourceName,
      displayName: c.names?.[0]?.displayName,
      givenName: c.names?.[0]?.givenName,
      familyName: c.names?.[0]?.familyName,
      emailAddresses: c.emailAddresses || [],
      phoneNumbers: c.phoneNumbers || [],
      organizations: c.organizations || [],
      photoUrl: c.photos?.[0]?.url
    }));
    return Response.json({ contacts });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Search failed";
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}
__name(searchContactsEndpoint, "searchContactsEndpoint");
async function disconnectContacts(_request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const mirrors = await env.DB.prepare(`
    SELECT dashboard_id FROM contacts_mirrors WHERE user_id = ?
  `).bind(auth.user.id).all();
  for (const mirror of mirrors.results || []) {
    await env.DB.prepare(`DELETE FROM contacts WHERE dashboard_id = ?`).bind(mirror.dashboard_id).run();
  }
  await env.DB.prepare(`DELETE FROM contacts_mirrors WHERE user_id = ?`).bind(auth.user.id).run();
  await env.DB.prepare(`DELETE FROM user_integrations WHERE user_id = ? AND provider = 'google_contacts'`).bind(auth.user.id).run();
  return Response.json({ ok: true });
}
__name(disconnectContacts, "disconnectContacts");
async function refreshSheetsAccessToken(env, userId) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth is not configured.");
  }
  const record = await env.DB.prepare(`
    SELECT access_token, refresh_token FROM user_integrations
    WHERE user_id = ? AND provider = 'google_sheets'
  `).bind(userId).first();
  if (!record?.refresh_token) {
    throw new Error("Sheets must be connected again.");
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
    throw new Error("Failed to refresh Sheets access token.");
  }
  const tokenData = await tokenResponse.json();
  const now = /* @__PURE__ */ new Date();
  const expiresAt = tokenData.expires_in ? new Date(now.getTime() + tokenData.expires_in * 1e3).toISOString() : null;
  await env.DB.prepare(`
    UPDATE user_integrations
    SET access_token = ?, scope = ?, token_type = ?, expires_at = ?, updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'google_sheets'
  `).bind(
    tokenData.access_token,
    tokenData.scope || null,
    tokenData.token_type || null,
    expiresAt,
    userId
  ).run();
  return tokenData.access_token;
}
__name(refreshSheetsAccessToken, "refreshSheetsAccessToken");
async function getSheetsAccessToken(env, userId) {
  const record = await env.DB.prepare(`
    SELECT access_token, expires_at FROM user_integrations
    WHERE user_id = ? AND provider = 'google_sheets'
  `).bind(userId).first();
  if (!record) {
    throw new Error("Sheets not connected.");
  }
  if (record.expires_at) {
    const expiresAt = new Date(record.expires_at).getTime();
    const now = Date.now();
    if (expiresAt - now < 5 * 60 * 1e3) {
      return refreshSheetsAccessToken(env, userId);
    }
  }
  return record.access_token;
}
__name(getSheetsAccessToken, "getSheetsAccessToken");
async function getSheetsProfile(accessToken) {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    throw new Error("Failed to fetch sheets profile.");
  }
  const data = await res.json();
  return { email: data.email, name: data.name };
}
__name(getSheetsProfile, "getSheetsProfile");
async function listSpreadsheets(accessToken, pageSize = 20, pageToken) {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("q", "mimeType='application/vnd.google-apps.spreadsheet'");
  url.searchParams.set("fields", "nextPageToken,files(id,name,modifiedTime)");
  url.searchParams.set("orderBy", "modifiedTime desc");
  if (pageToken) {
    url.searchParams.set("pageToken", pageToken);
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    throw new Error("Failed to list spreadsheets.");
  }
  return res.json();
}
__name(listSpreadsheets, "listSpreadsheets");
async function getSpreadsheet(accessToken, spreadsheetId) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=spreadsheetId,properties.title,sheets.properties`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    throw new Error("Failed to fetch spreadsheet.");
  }
  return res.json();
}
__name(getSpreadsheet, "getSpreadsheet");
async function getSheetValues(accessToken, spreadsheetId, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) {
    throw new Error("Failed to read sheet values.");
  }
  return res.json();
}
__name(getSheetValues, "getSheetValues");
async function updateSheetValues(accessToken, spreadsheetId, range, values) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`);
  url.searchParams.set("valueInputOption", "USER_ENTERED");
  const res = await fetch(url.toString(), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ range, values })
  });
  if (!res.ok) {
    throw new Error("Failed to update sheet values.");
  }
  return res.json();
}
__name(updateSheetValues, "updateSheetValues");
async function appendSheetValues(accessToken, spreadsheetId, range, values) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append`);
  url.searchParams.set("valueInputOption", "USER_ENTERED");
  url.searchParams.set("insertDataOption", "INSERT_ROWS");
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ range, values })
  });
  if (!res.ok) {
    throw new Error("Failed to append sheet values.");
  }
  return res.json();
}
__name(appendSheetValues, "appendSheetValues");
async function connectSheets(request, env, auth) {
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
  await createState(env, auth.user.id, "google_sheets", state, {
    dashboard_id: dashboardId,
    popup: mode === "popup"
  });
  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/sheets/callback`;
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SHEETS_SCOPE.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("state", state);
  return Response.redirect(authUrl.toString(), 302);
}
__name(connectSheets, "connectSheets");
async function callbackSheets(request, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return renderErrorPage("Google OAuth is not configured.");
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return renderErrorPage("Missing authorization code.");
  }
  const stateData = await consumeState(env, state, "google_sheets");
  if (!stateData) {
    return renderErrorPage("Invalid or expired state.");
  }
  const dashboardId = typeof stateData.metadata.dashboard_id === "string" ? stateData.metadata.dashboard_id : null;
  const popup = stateData.metadata.popup === true;
  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/sheets/callback`;
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
  let emailAddress = "";
  try {
    const profile = await getSheetsProfile(tokenData.access_token);
    emailAddress = profile.email;
  } catch {
  }
  const metadata = JSON.stringify({
    scope: tokenData.scope,
    token_type: tokenData.token_type,
    email_address: emailAddress
  });
  await env.DB.prepare(`
    INSERT INTO user_integrations (
      id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata
    ) VALUES (?, ?, 'google_sheets', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
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
  const frontendUrl = env.FRONTEND_URL || "https://orcabot.com";
  if (popup) {
    return renderProviderAuthCompletePage(frontendUrl, "Sheets", "sheets-auth-complete", dashboardId);
  }
  return renderSuccessPage("Google Sheets");
}
__name(callbackSheets, "callbackSheets");
async function getSheetsIntegration(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  const integration = await env.DB.prepare(`
    SELECT metadata FROM user_integrations WHERE user_id = ? AND provider = 'google_sheets'
  `).bind(auth.user.id).first();
  if (!integration) {
    return Response.json({ connected: false, linked: false, emailAddress: null });
  }
  let metadata = {};
  try {
    metadata = JSON.parse(integration.metadata || "{}");
  } catch {
    metadata = {};
  }
  if (!dashboardId) {
    return Response.json({
      connected: true,
      linked: false,
      emailAddress: metadata.email_address || null
    });
  }
  const mirror = await env.DB.prepare(`
    SELECT email_address, spreadsheet_id, spreadsheet_name, status, last_accessed_at
    FROM sheets_mirrors
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!mirror) {
    return Response.json({
      connected: true,
      linked: false,
      emailAddress: metadata.email_address || null
    });
  }
  return Response.json({
    connected: true,
    linked: true,
    emailAddress: mirror.email_address,
    spreadsheetId: mirror.spreadsheet_id,
    spreadsheetName: mirror.spreadsheet_name,
    status: mirror.status,
    lastAccessedAt: mirror.last_accessed_at
  });
}
__name(getSheetsIntegration, "getSheetsIntegration");
async function setupSheetsMirror(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId) {
    return Response.json({ error: "E79970: dashboardId is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79971: Not found or no access" }, { status: 404 });
  }
  let accessToken;
  try {
    accessToken = await getSheetsAccessToken(env, auth.user.id);
  } catch {
    return Response.json({ error: "E79972: Sheets not connected" }, { status: 404 });
  }
  const profile = await getSheetsProfile(accessToken);
  let spreadsheetName = null;
  if (data.spreadsheetId) {
    try {
      const spreadsheet = await getSpreadsheet(accessToken, data.spreadsheetId);
      spreadsheetName = spreadsheet.properties.title;
    } catch {
    }
  }
  await env.DB.prepare(`
    INSERT INTO sheets_mirrors (
      dashboard_id, user_id, email_address, spreadsheet_id, spreadsheet_name, status, updated_at, created_at
    ) VALUES (?, ?, ?, ?, ?, 'linked', datetime('now'), datetime('now'))
    ON CONFLICT(dashboard_id) DO UPDATE SET
      email_address = excluded.email_address,
      spreadsheet_id = excluded.spreadsheet_id,
      spreadsheet_name = excluded.spreadsheet_name,
      status = 'linked',
      updated_at = datetime('now')
  `).bind(
    data.dashboardId,
    auth.user.id,
    profile.email,
    data.spreadsheetId || null,
    spreadsheetName
  ).run();
  return Response.json({ ok: true, emailAddress: profile.email });
}
__name(setupSheetsMirror, "setupSheetsMirror");
async function unlinkSheetsMirror(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "E79973: dashboard_id is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79974: Not found or no access" }, { status: 404 });
  }
  await env.DB.prepare(`DELETE FROM sheets_mirrors WHERE dashboard_id = ?`).bind(dashboardId).run();
  return Response.json({ ok: true });
}
__name(unlinkSheetsMirror, "unlinkSheetsMirror");
async function listSpreadsheetsEndpoint(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const pageSize = parseInt(url.searchParams.get("page_size") || "20", 10);
  const pageToken = url.searchParams.get("page_token") || void 0;
  try {
    const accessToken = await getSheetsAccessToken(env, auth.user.id);
    const result = await listSpreadsheets(accessToken, pageSize, pageToken);
    return Response.json({
      spreadsheets: result.files.map((f) => ({
        id: f.id,
        name: f.name,
        modifiedTime: f.modifiedTime
      })),
      nextPageToken: result.nextPageToken
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Failed to list spreadsheets";
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}
__name(listSpreadsheetsEndpoint, "listSpreadsheetsEndpoint");
async function getSpreadsheetEndpoint(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  const spreadsheetId = url.searchParams.get("spreadsheet_id");
  if (!dashboardId) {
    return Response.json({ error: "E79975: dashboard_id is required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79976: Not found or no access" }, { status: 404 });
  }
  let sheetId = spreadsheetId;
  if (!sheetId) {
    const mirror = await env.DB.prepare(`
      SELECT spreadsheet_id FROM sheets_mirrors WHERE dashboard_id = ?
    `).bind(dashboardId).first();
    sheetId = mirror?.spreadsheet_id || null;
  }
  if (!sheetId) {
    return Response.json({ error: "E79977: No spreadsheet linked" }, { status: 400 });
  }
  try {
    const accessToken = await getSheetsAccessToken(env, auth.user.id);
    const spreadsheet = await getSpreadsheet(accessToken, sheetId);
    await env.DB.prepare(`
      UPDATE sheets_mirrors SET last_accessed_at = datetime('now') WHERE dashboard_id = ?
    `).bind(dashboardId).run();
    return Response.json({
      spreadsheetId: spreadsheet.spreadsheetId,
      title: spreadsheet.properties.title,
      sheets: (spreadsheet.sheets || []).map((s) => ({
        sheetId: s.properties.sheetId,
        title: s.properties.title,
        index: s.properties.index
      }))
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Failed to fetch spreadsheet";
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}
__name(getSpreadsheetEndpoint, "getSpreadsheetEndpoint");
async function readSheetValues(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  const spreadsheetId = url.searchParams.get("spreadsheet_id");
  const range = url.searchParams.get("range");
  if (!dashboardId || !range) {
    return Response.json({ error: "E79978: dashboard_id and range are required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79979: Not found or no access" }, { status: 404 });
  }
  let sheetId = spreadsheetId;
  if (!sheetId) {
    const mirror = await env.DB.prepare(`
      SELECT spreadsheet_id FROM sheets_mirrors WHERE dashboard_id = ?
    `).bind(dashboardId).first();
    sheetId = mirror?.spreadsheet_id || null;
  }
  if (!sheetId) {
    return Response.json({ error: "E79980: No spreadsheet linked" }, { status: 400 });
  }
  try {
    const accessToken = await getSheetsAccessToken(env, auth.user.id);
    const result = await getSheetValues(accessToken, sheetId, range);
    return Response.json({
      range: result.range,
      values: result.values || []
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Failed to read values";
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}
__name(readSheetValues, "readSheetValues");
async function writeSheetValues(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId || !data.range || !data.values) {
    return Response.json({ error: "E79981: dashboardId, range, and values are required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79982: Not found or no access" }, { status: 404 });
  }
  let sheetId = data.spreadsheetId;
  if (!sheetId) {
    const mirror = await env.DB.prepare(`
      SELECT spreadsheet_id FROM sheets_mirrors WHERE dashboard_id = ?
    `).bind(data.dashboardId).first();
    sheetId = mirror?.spreadsheet_id || null;
  }
  if (!sheetId) {
    return Response.json({ error: "E79983: No spreadsheet linked" }, { status: 400 });
  }
  try {
    const accessToken = await getSheetsAccessToken(env, auth.user.id);
    const result = await updateSheetValues(accessToken, sheetId, data.range, data.values);
    return Response.json({
      ok: true,
      updatedCells: result.updatedCells,
      updatedRows: result.updatedRows,
      updatedColumns: result.updatedColumns
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Failed to write values";
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}
__name(writeSheetValues, "writeSheetValues");
async function appendSheetValuesEndpoint(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId || !data.range || !data.values) {
    return Response.json({ error: "E79984: dashboardId, range, and values are required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79985: Not found or no access" }, { status: 404 });
  }
  let sheetId = data.spreadsheetId;
  if (!sheetId) {
    const mirror = await env.DB.prepare(`
      SELECT spreadsheet_id FROM sheets_mirrors WHERE dashboard_id = ?
    `).bind(data.dashboardId).first();
    sheetId = mirror?.spreadsheet_id || null;
  }
  if (!sheetId) {
    return Response.json({ error: "E79986: No spreadsheet linked" }, { status: 400 });
  }
  try {
    const accessToken = await getSheetsAccessToken(env, auth.user.id);
    const result = await appendSheetValues(accessToken, sheetId, data.range, data.values);
    return Response.json({
      ok: true,
      updatedCells: result.updates.updatedCells,
      updatedRows: result.updates.updatedRows
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Failed to append values";
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}
__name(appendSheetValuesEndpoint, "appendSheetValuesEndpoint");
async function setLinkedSpreadsheet(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const data = await request.json();
  if (!data.dashboardId || !data.spreadsheetId) {
    return Response.json({ error: "E79987: dashboardId and spreadsheetId are required" }, { status: 400 });
  }
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
  `).bind(data.dashboardId, auth.user.id).first();
  if (!access) {
    return Response.json({ error: "E79988: Not found or no access" }, { status: 404 });
  }
  let accessToken;
  try {
    accessToken = await getSheetsAccessToken(env, auth.user.id);
  } catch {
    return Response.json({ error: "E79989: Sheets not connected" }, { status: 404 });
  }
  let spreadsheetName;
  try {
    const spreadsheet = await getSpreadsheet(accessToken, data.spreadsheetId);
    spreadsheetName = spreadsheet.properties.title;
  } catch {
    return Response.json({ error: "E79990: Spreadsheet not found or not accessible" }, { status: 404 });
  }
  await env.DB.prepare(`
    UPDATE sheets_mirrors
    SET spreadsheet_id = ?, spreadsheet_name = ?, status = 'linked', updated_at = datetime('now')
    WHERE dashboard_id = ?
  `).bind(data.spreadsheetId, spreadsheetName, data.dashboardId).run();
  return Response.json({ ok: true, spreadsheetName });
}
__name(setLinkedSpreadsheet, "setLinkedSpreadsheet");
async function disconnectSheets(_request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  await env.DB.prepare(`DELETE FROM sheets_mirrors WHERE user_id = ?`).bind(auth.user.id).run();
  await env.DB.prepare(`DELETE FROM user_integrations WHERE user_id = ? AND provider = 'google_sheets'`).bind(auth.user.id).run();
  return Response.json({ ok: true });
}
__name(disconnectSheets, "disconnectSheets");
async function refreshFormsAccessToken(env, userId) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth is not configured.");
  }
  const record = await env.DB.prepare(`
    SELECT access_token, refresh_token FROM user_integrations
    WHERE user_id = ? AND provider = 'google_forms'
  `).bind(userId).first();
  if (!record?.refresh_token) {
    throw new Error("Forms must be connected again.");
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
    throw new Error("Failed to refresh Forms access token.");
  }
  const tokenData = await tokenResponse.json();
  const now = /* @__PURE__ */ new Date();
  const expiresAt = tokenData.expires_in ? new Date(now.getTime() + tokenData.expires_in * 1e3).toISOString() : null;
  await env.DB.prepare(`
    UPDATE user_integrations
    SET access_token = ?, expires_at = ?, updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'google_forms'
  `).bind(tokenData.access_token, expiresAt, userId).run();
  return tokenData.access_token;
}
__name(refreshFormsAccessToken, "refreshFormsAccessToken");
async function getFormsAccessToken(env, userId) {
  const record = await env.DB.prepare(`
    SELECT access_token, expires_at FROM user_integrations
    WHERE user_id = ? AND provider = 'google_forms'
  `).bind(userId).first();
  if (!record) {
    throw new Error("Forms not connected.");
  }
  if (record.expires_at) {
    const expiresAt = new Date(record.expires_at).getTime();
    const now = Date.now();
    if (expiresAt - now < 5 * 60 * 1e3) {
      return refreshFormsAccessToken(env, userId);
    }
  }
  return record.access_token;
}
__name(getFormsAccessToken, "getFormsAccessToken");
async function connectForms(request, env, auth) {
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
  await createState(env, auth.user.id, "google_forms", state, {
    dashboard_id: dashboardId,
    popup: mode === "popup"
  });
  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/forms/callback`;
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", FORMS_SCOPE.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("state", state);
  return Response.redirect(authUrl.toString(), 302);
}
__name(connectForms, "connectForms");
async function callbackForms(request, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return renderErrorPage("Google OAuth is not configured.");
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return renderErrorPage("Missing authorization code.");
  }
  const stateData = await consumeState(env, state, "google_forms");
  if (!stateData) {
    return renderErrorPage("Invalid or expired state.");
  }
  const dashboardId = typeof stateData.metadata.dashboard_id === "string" ? stateData.metadata.dashboard_id : null;
  const popup = stateData.metadata.popup === true;
  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/google/forms/callback`;
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
  let emailAddress = "";
  try {
    const userInfoRes = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
    );
    if (userInfoRes.ok) {
      const userInfo = await userInfoRes.json();
      emailAddress = userInfo.email || "";
    }
  } catch {
  }
  const metadata = JSON.stringify({
    scope: tokenData.scope,
    token_type: tokenData.token_type,
    email_address: emailAddress
  });
  await env.DB.prepare(`
    INSERT INTO user_integrations (
      id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata
    ) VALUES (?, ?, 'google_forms', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
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
  const frontendUrl = env.FRONTEND_URL || "https://orcabot.com";
  if (popup) {
    return renderProviderAuthCompletePage(frontendUrl, "Forms", "forms-auth-complete", dashboardId);
  }
  return renderSuccessPage("Google Forms");
}
__name(callbackForms, "callbackForms");
async function getFormsIntegration(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  const integration = await env.DB.prepare(
    `SELECT access_token, refresh_token, expires_at FROM user_integrations WHERE user_id = ? AND provider = 'google_forms'`
  ).bind(auth.user.id).first();
  if (!integration) {
    return Response.json({ connected: false, linked: false, emailAddress: null });
  }
  let emailAddress = null;
  try {
    const accessToken = await getFormsAccessToken(env, auth.user.id);
    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (userInfoRes.ok) {
      const userInfo = await userInfoRes.json();
      emailAddress = userInfo.email || null;
    }
  } catch {
  }
  if (!dashboardId) {
    return Response.json({ connected: true, linked: false, emailAddress });
  }
  const mirror = await env.DB.prepare(
    `SELECT form_id, form_title, status FROM forms_mirrors WHERE dashboard_id = ? AND user_id = ?`
  ).bind(dashboardId, auth.user.id).first();
  if (!mirror) {
    return Response.json({ connected: true, linked: false, emailAddress });
  }
  return Response.json({
    connected: true,
    linked: true,
    emailAddress,
    formId: mirror.form_id,
    formTitle: mirror.form_title,
    status: mirror.status
  });
}
__name(getFormsIntegration, "getFormsIntegration");
async function setupFormsMirror(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const body = await request.json();
  const { dashboardId } = body;
  if (!dashboardId) {
    return Response.json({ error: "dashboardId is required" }, { status: 400 });
  }
  const integration = await env.DB.prepare(
    `SELECT access_token, refresh_token, expires_at FROM user_integrations WHERE user_id = ? AND provider = 'google_forms'`
  ).bind(auth.user.id).first();
  if (!integration) {
    return Response.json({ error: "Google Forms not connected" }, { status: 400 });
  }
  let emailAddress = "";
  try {
    const accessToken = await getFormsAccessToken(env, auth.user.id);
    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (userInfoRes.ok) {
      const userInfo = await userInfoRes.json();
      emailAddress = userInfo.email || "";
    }
  } catch {
  }
  const existing = await env.DB.prepare(
    `SELECT dashboard_id FROM forms_mirrors WHERE dashboard_id = ?`
  ).bind(dashboardId).first();
  if (existing) {
    await env.DB.prepare(
      `UPDATE forms_mirrors SET user_id = ?, email_address = ?, status = 'idle', updated_at = datetime('now') WHERE dashboard_id = ?`
    ).bind(auth.user.id, emailAddress, dashboardId).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO forms_mirrors (dashboard_id, user_id, email_address, status) VALUES (?, ?, ?, 'idle')`
    ).bind(dashboardId, auth.user.id, emailAddress).run();
  }
  return Response.json({ ok: true, emailAddress });
}
__name(setupFormsMirror, "setupFormsMirror");
async function unlinkFormsMirror(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "dashboard_id is required" }, { status: 400 });
  }
  await env.DB.prepare(
    `DELETE FROM form_responses WHERE dashboard_id = ? AND user_id = ?`
  ).bind(dashboardId, auth.user.id).run();
  await env.DB.prepare(
    `DELETE FROM forms_mirrors WHERE dashboard_id = ? AND user_id = ?`
  ).bind(dashboardId, auth.user.id).run();
  return Response.json({ ok: true });
}
__name(unlinkFormsMirror, "unlinkFormsMirror");
async function listFormsEndpoint(_request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const integration = await env.DB.prepare(
    `SELECT access_token, refresh_token, expires_at FROM user_integrations WHERE user_id = ? AND provider = 'google_forms'`
  ).bind(auth.user.id).first();
  if (!integration) {
    return Response.json({ connected: false, forms: [] });
  }
  const accessToken = await getFormsAccessToken(env, auth.user.id);
  const driveRes = await fetch(
    "https://www.googleapis.com/drive/v3/files?q=mimeType='application/vnd.google-apps.form'&fields=files(id,name)",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!driveRes.ok) {
    const errorText = await driveRes.text();
    return Response.json({ error: `Failed to list forms: ${errorText}` }, { status: 500 });
  }
  const driveData = await driveRes.json();
  return Response.json({
    connected: true,
    forms: driveData.files.map((f) => ({ id: f.id, name: f.name }))
  });
}
__name(listFormsEndpoint, "listFormsEndpoint");
async function getFormEndpoint(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const formId = url.searchParams.get("form_id");
  if (!formId) {
    return Response.json({ error: "form_id is required" }, { status: 400 });
  }
  const integration = await env.DB.prepare(
    `SELECT access_token, refresh_token, expires_at FROM user_integrations WHERE user_id = ? AND provider = 'google_forms'`
  ).bind(auth.user.id).first();
  if (!integration) {
    return Response.json({ error: "Google Forms not connected" }, { status: 400 });
  }
  const accessToken = await getFormsAccessToken(env, auth.user.id);
  const formRes = await fetch(
    `https://forms.googleapis.com/v1/forms/${formId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!formRes.ok) {
    const errorText = await formRes.text();
    return Response.json({ error: `Failed to get form: ${errorText}` }, { status: 500 });
  }
  const formData = await formRes.json();
  return Response.json({
    formId: formData.formId,
    title: formData.info.title,
    description: formData.info.description,
    documentTitle: formData.info.documentTitle,
    responderUri: formData.responderUri,
    items: formData.items?.map((item) => ({
      itemId: item.itemId,
      title: item.title,
      description: item.description,
      question: item.questionItem?.question
    })) || []
  });
}
__name(getFormEndpoint, "getFormEndpoint");
async function getFormResponsesEndpoint(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const formId = url.searchParams.get("form_id");
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!formId || !dashboardId) {
    return Response.json({ error: "form_id and dashboard_id are required" }, { status: 400 });
  }
  const integration = await env.DB.prepare(
    `SELECT access_token, refresh_token, expires_at FROM user_integrations WHERE user_id = ? AND provider = 'google_forms'`
  ).bind(auth.user.id).first();
  if (!integration) {
    return Response.json({ error: "Google Forms not connected" }, { status: 400 });
  }
  const accessToken = await getFormsAccessToken(env, auth.user.id);
  const responsesRes = await fetch(
    `https://forms.googleapis.com/v1/forms/${formId}/responses`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!responsesRes.ok) {
    const errorText = await responsesRes.text();
    return Response.json({ error: `Failed to get responses: ${errorText}` }, { status: 500 });
  }
  const responsesData = await responsesRes.json();
  const responses = responsesData.responses || [];
  for (const response of responses) {
    const existing = await env.DB.prepare(
      `SELECT id FROM form_responses WHERE dashboard_id = ? AND response_id = ?`
    ).bind(dashboardId, response.responseId).first();
    if (existing) {
      await env.DB.prepare(
        `UPDATE form_responses SET respondent_email = ?, submitted_at = ?, answers = ?, updated_at = datetime('now') WHERE dashboard_id = ? AND response_id = ?`
      ).bind(response.respondentEmail || null, response.lastSubmittedTime, JSON.stringify(response.answers || {}), dashboardId, response.responseId).run();
    } else {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO form_responses (id, user_id, dashboard_id, form_id, response_id, respondent_email, submitted_at, answers) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, auth.user.id, dashboardId, formId, response.responseId, response.respondentEmail || null, response.lastSubmittedTime, JSON.stringify(response.answers || {})).run();
    }
  }
  return Response.json({
    total: responses.length,
    responses: responses.map((r) => ({
      responseId: r.responseId,
      respondentEmail: r.respondentEmail,
      submittedAt: r.lastSubmittedTime,
      answers: r.answers
    }))
  });
}
__name(getFormResponsesEndpoint, "getFormResponsesEndpoint");
async function setLinkedForm(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const body = await request.json();
  const { dashboardId, formId, formTitle } = body;
  if (!dashboardId || !formId || !formTitle) {
    return Response.json({ error: "dashboardId, formId, and formTitle are required" }, { status: 400 });
  }
  const existing = await env.DB.prepare(
    `SELECT dashboard_id FROM forms_mirrors WHERE dashboard_id = ?`
  ).bind(dashboardId).first();
  if (existing) {
    await env.DB.prepare(
      `UPDATE forms_mirrors SET form_id = ?, form_title = ?, status = 'linked', last_accessed_at = datetime('now'), updated_at = datetime('now') WHERE dashboard_id = ?`
    ).bind(formId, formTitle, dashboardId).run();
  } else {
    return Response.json({ error: "Forms mirror not set up for this dashboard" }, { status: 400 });
  }
  return Response.json({ ok: true });
}
__name(setLinkedForm, "setLinkedForm");
async function disconnectForms(_request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  await env.DB.prepare(`DELETE FROM form_responses WHERE user_id = ?`).bind(auth.user.id).run();
  await env.DB.prepare(`DELETE FROM forms_mirrors WHERE user_id = ?`).bind(auth.user.id).run();
  await env.DB.prepare(`DELETE FROM user_integrations WHERE user_id = ? AND provider = 'google_forms'`).bind(auth.user.id).run();
  return Response.json({ ok: true });
}
__name(disconnectForms, "disconnectForms");
async function connectSlack(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
    return renderErrorPage("Slack OAuth is not configured.");
  }
  const requestUrl = new URL(request.url);
  const dashboardId = requestUrl.searchParams.get("dashboard_id");
  const mode = requestUrl.searchParams.get("mode");
  const state = buildState();
  await createState(env, auth.user.id, "slack", state, {
    dashboard_id: dashboardId,
    popup: mode === "popup"
  });
  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/slack/callback`;
  const authUrl = new URL("https://slack.com/oauth/v2/authorize");
  authUrl.searchParams.set("client_id", env.SLACK_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", SLACK_SCOPE.join(","));
  authUrl.searchParams.set("state", state);
  return Response.redirect(authUrl.toString(), 302);
}
__name(connectSlack, "connectSlack");
async function callbackSlack(request, env) {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
    return renderErrorPage("Slack OAuth is not configured.");
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return renderErrorPage("Missing authorization code.");
  }
  const stateData = await consumeState(env, state, "slack");
  if (!stateData) {
    return renderErrorPage("Invalid or expired state.");
  }
  const dashboardId = typeof stateData.metadata.dashboard_id === "string" ? stateData.metadata.dashboard_id : null;
  const popup = stateData.metadata.popup === true;
  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/slack/callback`;
  const body = new URLSearchParams();
  body.set("client_id", env.SLACK_CLIENT_ID);
  body.set("client_secret", env.SLACK_CLIENT_SECRET);
  body.set("code", code);
  body.set("redirect_uri", redirectUri);
  const tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!tokenResponse.ok) {
    return renderErrorPage("Failed to exchange Slack token.");
  }
  const tokenData = await tokenResponse.json();
  if (!tokenData.ok || !tokenData.access_token) {
    return renderErrorPage(`Slack authorization failed: ${tokenData.error || "unknown error"}`);
  }
  const metadata = JSON.stringify({
    scope: tokenData.scope,
    token_type: tokenData.token_type,
    team_id: tokenData.team?.id,
    team_name: tokenData.team?.name,
    bot_user_id: tokenData.bot_user_id,
    authed_user_id: tokenData.authed_user?.id,
    app_id: tokenData.app_id
  });
  await env.DB.prepare(`
    INSERT INTO user_integrations (
      id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata
    ) VALUES (?, ?, 'slack', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
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
    // Slack bot tokens do not use refresh tokens
    tokenData.scope || null,
    tokenData.token_type || null,
    null,
    // Slack bot tokens do not expire
    metadata
  ).run();
  const frontendUrl = env.FRONTEND_URL || "https://orcabot.com";
  if (popup) {
    return renderProviderAuthCompletePage(frontendUrl, "Slack", "slack-auth-complete", dashboardId);
  }
  return renderSuccessPage("Slack");
}
__name(callbackSlack, "callbackSlack");
async function getSlackIntegration(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const integration = await env.DB.prepare(`
    SELECT metadata FROM user_integrations WHERE user_id = ? AND provider = 'slack'
  `).bind(auth.user.id).first();
  if (!integration) {
    return Response.json({ connected: false, teamName: null, teamId: null, channels: [] });
  }
  let meta = {};
  try {
    meta = JSON.parse(integration.metadata || "{}");
  } catch {
  }
  return Response.json({
    connected: true,
    teamName: meta.team_name || null,
    teamId: meta.team_id || null,
    botUserId: meta.bot_user_id || null,
    channels: []
    // Channel list populated by MCP tool calls, not here
  });
}
__name(getSlackIntegration, "getSlackIntegration");
async function getSlackStatus(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "dashboard_id is required" }, { status: 400 });
  }
  const membership = await env.DB.prepare(
    "SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?"
  ).bind(dashboardId, auth.user.id).first();
  if (!membership) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const stats = await env.DB.prepare(`
    SELECT COUNT(*) as sub_count, MAX(last_message_at) as last_activity
    FROM messaging_subscriptions
    WHERE dashboard_id = ? AND provider = 'slack' AND status = 'active'
  `).bind(dashboardId).first();
  return Response.json({
    channelCount: stats?.sub_count || 0,
    lastActivityAt: stats?.last_activity || null
  });
}
__name(getSlackStatus, "getSlackStatus");
async function disconnectSlack(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  await env.DB.prepare(`
    DELETE FROM user_integrations WHERE user_id = ? AND provider = 'slack'
  `).bind(auth.user.id).run();
  await env.DB.prepare(`
    UPDATE messaging_subscriptions SET status = 'paused', updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'slack'
  `).bind(auth.user.id).run();
  return Response.json({ ok: true });
}
__name(disconnectSlack, "disconnectSlack");
async function listSlackChannels(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") || void 0;
  const integration = await env.DB.prepare(`
    SELECT access_token FROM user_integrations WHERE user_id = ? AND provider = 'slack'
  `).bind(auth.user.id).first();
  if (!integration?.access_token) {
    return Response.json({ error: "Slack not connected" }, { status: 404 });
  }
  const params = new URLSearchParams({
    types: "public_channel,private_channel",
    exclude_archived: "true",
    limit: "200"
  });
  if (cursor) {
    params.set("cursor", cursor);
  }
  const resp = await fetch(`https://slack.com/api/conversations.list?${params}`, {
    headers: { Authorization: `Bearer ${integration.access_token}` }
  });
  if (!resp.ok) {
    console.error(`[integrations] Slack conversations.list failed: ${resp.status}`);
    return Response.json({ error: "Failed to fetch channels from Slack" }, { status: 502 });
  }
  const body = await resp.json();
  if (!body.ok) {
    console.error(`[integrations] Slack API error: ${body.error}`);
    return Response.json({ error: body.error || "Slack API error" }, { status: 502 });
  }
  const channels = (body.channels || []).map((ch) => ({
    id: ch.id,
    name: ch.name,
    is_private: ch.is_private,
    num_members: ch.num_members,
    topic: ch.topic?.value || null,
    purpose: ch.purpose?.value || null
  }));
  const nextCursor = body.response_metadata?.next_cursor || null;
  return Response.json({ channels, next_cursor: nextCursor });
}
__name(listSlackChannels, "listSlackChannels");
var DISCORD_BOT_PERMISSIONS = (1024 + 2048 + 65536 + 64).toString();
async function connectDiscord(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    return renderErrorPage("Discord OAuth is not configured.");
  }
  const requestUrl = new URL(request.url);
  const dashboardId = requestUrl.searchParams.get("dashboard_id");
  const mode = requestUrl.searchParams.get("mode");
  const state = buildState();
  await createState(env, auth.user.id, "discord", state, {
    dashboard_id: dashboardId,
    popup: mode === "popup"
  });
  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/discord/callback`;
  const authUrl = new URL("https://discord.com/oauth2/authorize");
  authUrl.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "bot identify guilds");
  authUrl.searchParams.set("permissions", DISCORD_BOT_PERMISSIONS);
  authUrl.searchParams.set("state", state);
  return Response.redirect(authUrl.toString(), 302);
}
__name(connectDiscord, "connectDiscord");
async function callbackDiscord(request, env) {
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    return renderErrorPage("Discord OAuth is not configured.");
  }
  if (!env.DISCORD_BOT_TOKEN) {
    return renderErrorPage("Discord bot token is not configured.");
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const guildId = url.searchParams.get("guild_id");
  if (!code || !state) {
    return renderErrorPage("Missing authorization code.");
  }
  const stateData = await consumeState(env, state, "discord");
  if (!stateData) {
    return renderErrorPage("Invalid or expired state.");
  }
  const dashboardId = typeof stateData.metadata.dashboard_id === "string" ? stateData.metadata.dashboard_id : null;
  const popup = stateData.metadata.popup === true;
  const redirectBase = getRedirectBase(request, env);
  const redirectUri = `${redirectBase}/integrations/discord/callback`;
  const body = new URLSearchParams();
  body.set("client_id", env.DISCORD_CLIENT_ID);
  body.set("client_secret", env.DISCORD_CLIENT_SECRET);
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", redirectUri);
  const tokenResponse = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!tokenResponse.ok) {
    const errText = await tokenResponse.text().catch(() => "");
    console.error(`[integrations] Discord token exchange failed: ${tokenResponse.status} ${errText}`);
    return renderErrorPage("Failed to exchange Discord token.");
  }
  const tokenData = await tokenResponse.json();
  if (!tokenData.access_token) {
    return renderErrorPage("Discord authorization failed: no access token.");
  }
  const resolvedGuildId = tokenData.guild?.id || guildId;
  const resolvedGuildName = tokenData.guild?.name || null;
  let discordUser = null;
  try {
    const userResp = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    if (userResp.ok) {
      discordUser = await userResp.json();
    }
  } catch {
  }
  const metadata = JSON.stringify({
    scope: tokenData.scope,
    token_type: tokenData.token_type,
    guild_id: resolvedGuildId,
    guild_name: resolvedGuildName,
    guild_icon: tokenData.guild?.icon || null,
    discord_user_id: discordUser?.id || null,
    discord_username: discordUser?.username || null
  });
  const expiresAt = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1e3).toISOString() : null;
  await env.DB.prepare(`
    INSERT INTO user_integrations (
      id, user_id, provider, access_token, refresh_token, scope, token_type, expires_at, metadata
    ) VALUES (?, ?, 'discord', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, user_integrations.refresh_token),
      scope = excluded.scope,
      token_type = excluded.token_type,
      expires_at = excluded.expires_at,
      metadata = excluded.metadata,
      updated_at = datetime('now')
  `).bind(
    crypto.randomUUID(),
    stateData.userId,
    env.DISCORD_BOT_TOKEN,
    // Bot token for API calls (never expires)
    null,
    // Bot tokens don't need refresh
    tokenData.scope || null,
    "Bot",
    null,
    // Bot tokens don't expire
    metadata
  ).run();
  const frontendUrl = env.FRONTEND_URL || "https://orcabot.com";
  if (popup) {
    return renderProviderAuthCompletePage(frontendUrl, "Discord", "discord-auth-complete", dashboardId);
  }
  return renderSuccessPage("Discord");
}
__name(callbackDiscord, "callbackDiscord");
async function getDiscordIntegration(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const integration = await env.DB.prepare(`
    SELECT metadata FROM user_integrations WHERE user_id = ? AND provider = 'discord'
  `).bind(auth.user.id).first();
  if (!integration) {
    return Response.json({ connected: false, guildName: null, guildId: null });
  }
  let meta = {};
  try {
    meta = JSON.parse(integration.metadata || "{}");
  } catch {
  }
  return Response.json({
    connected: true,
    guildName: meta.guild_name || null,
    guildId: meta.guild_id || null,
    discordUsername: meta.discord_username || null
  });
}
__name(getDiscordIntegration, "getDiscordIntegration");
async function getDiscordStatus(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get("dashboard_id");
  if (!dashboardId) {
    return Response.json({ error: "dashboard_id is required" }, { status: 400 });
  }
  const membership = await env.DB.prepare(
    "SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?"
  ).bind(dashboardId, auth.user.id).first();
  if (!membership) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const stats = await env.DB.prepare(`
    SELECT COUNT(*) as sub_count, MAX(last_message_at) as last_activity
    FROM messaging_subscriptions
    WHERE dashboard_id = ? AND provider = 'discord' AND status = 'active'
  `).bind(dashboardId).first();
  return Response.json({
    channelCount: stats?.sub_count || 0,
    lastActivityAt: stats?.last_activity || null
  });
}
__name(getDiscordStatus, "getDiscordStatus");
async function disconnectDiscord(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  await env.DB.prepare(`
    DELETE FROM user_integrations WHERE user_id = ? AND provider = 'discord'
  `).bind(auth.user.id).run();
  await env.DB.prepare(`
    UPDATE messaging_subscriptions SET status = 'paused', updated_at = datetime('now')
    WHERE user_id = ? AND provider = 'discord'
  `).bind(auth.user.id).run();
  return Response.json({ ok: true });
}
__name(disconnectDiscord, "disconnectDiscord");
async function listDiscordChannels(request, env, auth) {
  const authError = requireAuth(auth);
  if (authError)
    return authError;
  if (!env.DISCORD_BOT_TOKEN) {
    return Response.json({ error: "Discord bot token not configured" }, { status: 500 });
  }
  const integration = await env.DB.prepare(`
    SELECT metadata FROM user_integrations WHERE user_id = ? AND provider = 'discord'
  `).bind(auth.user.id).first();
  if (!integration) {
    return Response.json({ error: "Discord not connected" }, { status: 404 });
  }
  let meta = {};
  try {
    meta = JSON.parse(integration.metadata || "{}");
  } catch {
    return Response.json({ error: "Invalid integration metadata" }, { status: 500 });
  }
  const guildId = meta.guild_id;
  if (!guildId) {
    return Response.json({ error: "No guild associated with this integration" }, { status: 400 });
  }
  const resp = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }
  });
  if (!resp.ok) {
    console.error(`[integrations] Discord channels fetch failed: ${resp.status}`);
    return Response.json({ error: "Failed to fetch channels from Discord" }, { status: 502 });
  }
  const rawChannels = await resp.json();
  const channels = rawChannels.filter((ch) => ch.type === 0 || ch.type === 5).sort((a, b) => a.position - b.position).map((ch) => ({
    id: ch.id,
    name: ch.name,
    is_private: false,
    // Guild channels visible to bot are not private
    topic: ch.topic || null
  }));
  return Response.json({ channels });
}
__name(listDiscordChannels, "listDiscordChannels");

// src/index.ts
init_handler3();

// src/email/resend.ts
async function sendEmail(env, options) {
  if (!env.RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not configured, skipping email send");
    return;
  }
  const from = env.EMAIL_FROM || "OrcaBot <noreply@orcabot.com>";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: options.to,
      subject: options.subject,
      html: options.html,
      attachments: options.attachments
    })
  });
  if (!response.ok) {
    const error = await response.text();
    console.error("Failed to send email:", error);
    throw new Error(`Failed to send email: ${error}`);
  }
}
__name(sendEmail, "sendEmail");
function buildInvitationEmail(params) {
  return {
    subject: `${params.inviterName} invited you to "${params.dashboardName}" on OrcaBot`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #0066ff 0%, #0052cc 100%); padding: 32px; border-radius: 12px 12px 0 0;">
    <h1 style="margin: 0; color: white; font-size: 24px; font-weight: 600;">You've been invited!</h1>
  </div>

  <div style="background: #ffffff; padding: 32px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <p style="margin: 0 0 16px; font-size: 16px;">
      <strong>${escapeHtml2(params.inviterName)}</strong> has invited you to collaborate on
      <strong>"${escapeHtml2(params.dashboardName)}"</strong> as a <strong>${escapeHtml2(params.role)}</strong>.
    </p>

    <p style="margin: 24px 0;">
      <a href="${escapeHtml2(params.acceptUrl)}"
         style="display: inline-block; padding: 14px 28px; background: #0066ff; color: white; text-decoration: none; border-radius: 8px; font-weight: 500; font-size: 16px;">
        Accept Invitation
      </a>
    </p>

    <p style="margin: 24px 0 0; color: #666; font-size: 14px;">
      This invitation will expire in 7 days. If you don't have an OrcaBot account yet,
      you'll be able to create one when you accept the invitation.
    </p>
  </div>

  <p style="margin: 24px 0 0; color: #999; font-size: 12px; text-align: center;">
    OrcaBot - Collaborative AI Coding Platform
  </p>
</body>
</html>
    `.trim()
  };
}
__name(buildInvitationEmail, "buildInvitationEmail");
function buildAccessGrantedEmail(params) {
  return {
    subject: `${params.inviterName} added you to "${params.dashboardName}" on OrcaBot`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #0066ff 0%, #0052cc 100%); padding: 32px; border-radius: 12px 12px 0 0;">
    <h1 style="margin: 0; color: white; font-size: 24px; font-weight: 600;">You've been added!</h1>
  </div>

  <div style="background: #ffffff; padding: 32px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <p style="margin: 0 0 16px; font-size: 16px;">
      <strong>${escapeHtml2(params.inviterName)}</strong> has added you to
      <strong>"${escapeHtml2(params.dashboardName)}"</strong> as a <strong>${escapeHtml2(params.role)}</strong>.
    </p>

    <p style="margin: 24px 0;">
      <a href="${escapeHtml2(params.dashboardUrl)}"
         style="display: inline-block; padding: 14px 28px; background: #0066ff; color: white; text-decoration: none; border-radius: 8px; font-weight: 500; font-size: 16px;">
        Open Dashboard
      </a>
    </p>
  </div>

  <p style="margin: 24px 0 0; color: #999; font-size: 12px; text-align: center;">
    OrcaBot - Collaborative AI Coding Platform
  </p>
</body>
</html>
    `.trim()
  };
}
__name(buildAccessGrantedEmail, "buildAccessGrantedEmail");
function buildInterestThankYouEmail() {
  return {
    subject: "Thanks for your interest in OrcaBot!",
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #0066ff 0%, #0052cc 100%); padding: 32px; border-radius: 12px 12px 0 0;">
    <h1 style="margin: 0; color: white; font-size: 24px; font-weight: 600;">Thanks for your interest!</h1>
  </div>

  <div style="background: #ffffff; padding: 32px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <p style="margin: 0 0 16px; font-size: 16px;">
      We've received your registration and we're excited that you're interested in OrcaBot!
    </p>

    <p style="margin: 16px 0; font-size: 16px;">
      We'll be in touch soon with updates on access and new features.
    </p>

    <p style="margin: 24px 0 0; color: #666; font-size: 14px;">
      In the meantime, feel free to reply to this email if you have any questions.
    </p>
  </div>

  <p style="margin: 24px 0 0; color: #999; font-size: 12px; text-align: center;">
    OrcaBot - Agentic AI Coding Agent Orchestration
  </p>
</body>
</html>
    `.trim()
  };
}
__name(buildInterestThankYouEmail, "buildInterestThankYouEmail");
function buildInterestNotificationEmail(params) {
  const noteSection = params.note ? `
    <div style="margin: 16px 0; padding: 16px; background: #f5f5f5; border-radius: 8px;">
      <p style="margin: 0 0 8px; font-size: 14px; color: #666; font-weight: 500;">Note from user:</p>
      <p style="margin: 0; font-size: 14px;">${escapeHtml2(params.note)}</p>
    </div>` : "";
  return {
    subject: `New OrcaBot interest registration: ${params.email}`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 32px; border-radius: 12px 12px 0 0;">
    <h1 style="margin: 0; color: white; font-size: 24px; font-weight: 600;">New Interest Registration</h1>
  </div>

  <div style="background: #ffffff; padding: 32px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <p style="margin: 0 0 16px; font-size: 16px;">
      Someone has registered their interest in OrcaBot:
    </p>

    <p style="margin: 16px 0; font-size: 16px;">
      <strong>Email:</strong> ${escapeHtml2(params.email)}
    </p>
    ${noteSection}
    <p style="margin: 24px 0 0; color: #666; font-size: 14px;">
      Registered at: ${(/* @__PURE__ */ new Date()).toISOString()}
    </p>
  </div>

  <p style="margin: 24px 0 0; color: #999; font-size: 12px; text-align: center;">
    OrcaBot Admin Notification
  </p>
</body>
</html>
    `.trim()
  };
}
__name(buildInterestNotificationEmail, "buildInterestNotificationEmail");
function buildTemplateReviewEmail(params) {
  return {
    subject: `[OrcaBot] Template submitted for review: "${params.templateName}"`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 32px; border-radius: 12px 12px 0 0;">
    <h1 style="margin: 0; color: white; font-size: 24px; font-weight: 600;">Template Review Required</h1>
  </div>

  <div style="background: #ffffff; padding: 32px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <p style="margin: 0 0 16px; font-size: 16px;">
      A new template has been submitted for review:
    </p>

    <table style="width: 100%; font-size: 14px; margin-bottom: 16px; border-collapse: collapse;">
      <tr><td style="color: #666; padding: 4px 8px 4px 0;">Template:</td><td style="padding: 4px 0; font-weight: 500;">${escapeHtml2(params.templateName)}</td></tr>
      <tr><td style="color: #666; padding: 4px 8px 4px 0;">Author:</td><td style="padding: 4px 0;">${escapeHtml2(params.authorName)} (${escapeHtml2(params.authorEmail)})</td></tr>
      <tr><td style="color: #666; padding: 4px 8px 4px 0;">Category:</td><td style="padding: 4px 0;">${escapeHtml2(params.category)}</td></tr>
      <tr><td style="color: #666; padding: 4px 8px 4px 0;">Items:</td><td style="padding: 4px 0;">${params.itemCount} blocks</td></tr>
      <tr><td style="color: #666; padding: 4px 8px 4px 0;">Submitted:</td><td style="padding: 4px 0;">${(/* @__PURE__ */ new Date()).toISOString()}</td></tr>
    </table>

    <p style="margin: 16px 0 0; color: #666; font-size: 14px;">
      Log in and enable admin mode to approve or reject this template.
    </p>
  </div>

  <p style="margin: 24px 0 0; color: #999; font-size: 12px; text-align: center;">
    OrcaBot Admin Notification
  </p>
</body>
</html>
    `.trim()
  };
}
__name(buildTemplateReviewEmail, "buildTemplateReviewEmail");
function buildBugReportEmail(params) {
  const notesSection = params.notes ? `
    <div style="margin: 16px 0; padding: 16px; background: #f5f5f5; border-radius: 8px;">
      <p style="margin: 0 0 8px; font-size: 14px; color: #666; font-weight: 500;">Notes:</p>
      <p style="margin: 0; font-size: 14px; white-space: pre-wrap;">${escapeHtml2(params.notes)}</p>
    </div>` : '<p style="color: #666; font-style: italic;">No additional notes provided.</p>';
  return {
    subject: `[OrcaBot Bug Report] from ${params.userName}`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); padding: 32px; border-radius: 12px 12px 0 0;">
    <h1 style="margin: 0; color: white; font-size: 24px; font-weight: 600;">Bug Report</h1>
  </div>

  <div style="background: #ffffff; padding: 32px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px;">
    <table style="width: 100%; font-size: 14px; margin-bottom: 16px; border-collapse: collapse;">
      <tr><td style="color: #666; padding: 4px 8px 4px 0; vertical-align: top;">From:</td><td style="padding: 4px 0;">${escapeHtml2(params.userName)} (${escapeHtml2(params.userEmail)})</td></tr>
      <tr><td style="color: #666; padding: 4px 8px 4px 0; vertical-align: top;">Dashboard:</td><td style="padding: 4px 0;">${escapeHtml2(params.dashboardName)} (${escapeHtml2(params.dashboardId)})</td></tr>
      <tr><td style="color: #666; padding: 4px 8px 4px 0; vertical-align: top;">URL:</td><td style="padding: 4px 0; word-break: break-all;">${escapeHtml2(params.url)}</td></tr>
      <tr><td style="color: #666; padding: 4px 8px 4px 0; vertical-align: top;">User Agent:</td><td style="padding: 4px 0; font-size: 12px; color: #888;">${escapeHtml2(params.userAgent)}</td></tr>
      <tr><td style="color: #666; padding: 4px 8px 4px 0; vertical-align: top;">Screenshot:</td><td style="padding: 4px 0;">${params.hasScreenshot ? "\u{1F4CE} Attached" : "Not included"}</td></tr>
      <tr><td style="color: #666; padding: 4px 8px 4px 0; vertical-align: top;">Submitted:</td><td style="padding: 4px 0;">${(/* @__PURE__ */ new Date()).toISOString()}</td></tr>
    </table>

    ${notesSection}
  </div>

  <p style="margin: 24px 0 0; color: #999; font-size: 12px; text-align: center;">
    OrcaBot Bug Report System
  </p>
</body>
</html>
    `.trim()
  };
}
__name(buildBugReportEmail, "buildBugReportEmail");
function escapeHtml2(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
__name(escapeHtml2, "escapeHtml");

// src/members/handler.ts
function generateId8() {
  return crypto.randomUUID();
}
__name(generateId8, "generateId");
function generateToken() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(generateToken, "generateToken");
async function getDashboardRole(env, dashboardId, userId) {
  const access = await env.DB.prepare(`
    SELECT role FROM dashboard_members
    WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, userId).first();
  return access?.role ?? null;
}
__name(getDashboardRole, "getDashboardRole");
async function getDashboardInfo(env, dashboardId) {
  const dashboard = await env.DB.prepare(`
    SELECT name, owner_id FROM dashboards WHERE id = ?
  `).bind(dashboardId).first();
  if (!dashboard)
    return null;
  return { name: dashboard.name, ownerId: dashboard.owner_id };
}
__name(getDashboardInfo, "getDashboardInfo");
async function getUserByEmail(env, email) {
  return env.DB.prepare(`
    SELECT id, name, email FROM users WHERE LOWER(email) = LOWER(?)
  `).bind(email).first();
}
__name(getUserByEmail, "getUserByEmail");
async function getUserById(env, userId) {
  return env.DB.prepare(`
    SELECT id, name, email FROM users WHERE id = ?
  `).bind(userId).first();
}
__name(getUserById, "getUserById");
function getFrontendUrl(env) {
  return env.FRONTEND_URL || "https://orcabot.com";
}
__name(getFrontendUrl, "getFrontendUrl");
async function listMembers(env, dashboardId, userId) {
  const role = await getDashboardRole(env, dashboardId, userId);
  if (!role) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }
  const membersResult = await env.DB.prepare(`
    SELECT dm.user_id, dm.role, dm.added_at, u.email, u.name
    FROM dashboard_members dm
    JOIN users u ON dm.user_id = u.id
    WHERE dm.dashboard_id = ?
    ORDER BY
      CASE dm.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,
      dm.added_at ASC
  `).bind(dashboardId).all();
  const members = (membersResult.results || []).map((row) => ({
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    addedAt: row.added_at
  }));
  const invitationsResult = await env.DB.prepare(`
    SELECT i.id, i.email, i.role, i.created_at, i.expires_at, u.name as invited_by_name
    FROM dashboard_invitations i
    JOIN users u ON i.invited_by = u.id
    WHERE i.dashboard_id = ?
      AND i.accepted_at IS NULL
      AND i.expires_at > datetime('now')
    ORDER BY i.created_at DESC
  `).bind(dashboardId).all();
  const invitations = (invitationsResult.results || []).map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    invitedByName: row.invited_by_name,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  }));
  return Response.json({ members, invitations });
}
__name(listMembers, "listMembers");
async function addMember(env, dashboardId, userId, data) {
  const role = await getDashboardRole(env, dashboardId, userId);
  if (role !== "owner") {
    return Response.json({ error: "Only owners can add members" }, { status: 403 });
  }
  const dashboard = await getDashboardInfo(env, dashboardId);
  if (!dashboard) {
    return Response.json({ error: "Dashboard not found" }, { status: 404 });
  }
  const inviter = await getUserById(env, userId);
  if (!inviter) {
    return Response.json({ error: "User not found" }, { status: 404 });
  }
  const email = data.email.toLowerCase().trim();
  const inviteRole = data.role;
  if (!["editor", "viewer"].includes(inviteRole)) {
    return Response.json({ error: "Invalid role. Must be editor or viewer." }, { status: 400 });
  }
  const existingUser = await getUserByEmail(env, email);
  if (existingUser) {
    const existingMember = await env.DB.prepare(`
      SELECT 1 FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?
    `).bind(dashboardId, existingUser.id).first();
    if (existingMember) {
      return Response.json({ error: "User is already a member of this dashboard" }, { status: 400 });
    }
    const now2 = (/* @__PURE__ */ new Date()).toISOString();
    await env.DB.prepare(`
      INSERT INTO dashboard_members (dashboard_id, user_id, role, added_at)
      VALUES (?, ?, ?, ?)
    `).bind(dashboardId, existingUser.id, inviteRole, now2).run();
    const dashboardUrl = `${getFrontendUrl(env)}/dashboards/${dashboardId}`;
    try {
      const emailContent = buildAccessGrantedEmail({
        inviterName: inviter.name,
        dashboardName: dashboard.name,
        role: inviteRole,
        dashboardUrl
      });
      await sendEmail(env, {
        to: email,
        subject: emailContent.subject,
        html: emailContent.html
      });
    } catch (e) {
      console.error("Failed to send access granted email:", e);
    }
    const member = {
      userId: existingUser.id,
      email: existingUser.email,
      name: existingUser.name,
      role: inviteRole,
      addedAt: now2
    };
    return Response.json({ member }, { status: 201 });
  }
  const existingInvitation = await env.DB.prepare(`
    SELECT id FROM dashboard_invitations
    WHERE dashboard_id = ? AND LOWER(email) = LOWER(?) AND accepted_at IS NULL
  `).bind(dashboardId, email).first();
  if (existingInvitation) {
    return Response.json({ error: "An invitation has already been sent to this email" }, { status: 400 });
  }
  const invitationId = generateId8();
  const token = generateToken();
  const now = /* @__PURE__ */ new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1e3);
  await env.DB.prepare(`
    INSERT INTO dashboard_invitations (id, dashboard_id, email, role, invited_by, token, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    invitationId,
    dashboardId,
    email,
    inviteRole,
    userId,
    token,
    now.toISOString(),
    expiresAt.toISOString()
  ).run();
  const acceptUrl = `${getFrontendUrl(env)}/login?invite=${token}`;
  try {
    const emailContent = buildInvitationEmail({
      inviterName: inviter.name,
      dashboardName: dashboard.name,
      role: inviteRole,
      acceptUrl
    });
    await sendEmail(env, {
      to: email,
      subject: emailContent.subject,
      html: emailContent.html
    });
  } catch (e) {
    console.error("Failed to send invitation email:", e);
  }
  const invitation = {
    id: invitationId,
    email,
    role: inviteRole,
    invitedByName: inviter.name,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString()
  };
  return Response.json({ invitation }, { status: 201 });
}
__name(addMember, "addMember");
async function updateMemberRole(env, dashboardId, userId, memberId, data) {
  const role = await getDashboardRole(env, dashboardId, userId);
  if (role !== "owner") {
    return Response.json({ error: "Only owners can update member roles" }, { status: 403 });
  }
  const memberRole = await getDashboardRole(env, dashboardId, memberId);
  if (memberRole === "owner") {
    return Response.json({ error: "Cannot change the owner's role" }, { status: 400 });
  }
  if (!memberRole) {
    return Response.json({ error: "Member not found" }, { status: 404 });
  }
  const newRole = data.role;
  if (!["editor", "viewer"].includes(newRole)) {
    return Response.json({ error: "Invalid role. Must be editor or viewer." }, { status: 400 });
  }
  await env.DB.prepare(`
    UPDATE dashboard_members SET role = ? WHERE dashboard_id = ? AND user_id = ?
  `).bind(newRole, dashboardId, memberId).run();
  const member = await getUserById(env, memberId);
  if (!member) {
    return Response.json({ error: "Member user not found" }, { status: 404 });
  }
  const result = await env.DB.prepare(`
    SELECT added_at FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, memberId).first();
  const updatedMember = {
    userId: memberId,
    email: member.email,
    name: member.name,
    role: newRole,
    addedAt: result?.added_at || ""
  };
  return Response.json({ member: updatedMember });
}
__name(updateMemberRole, "updateMemberRole");
async function removeMember(env, dashboardId, userId, memberId) {
  const role = await getDashboardRole(env, dashboardId, userId);
  if (role !== "owner") {
    return Response.json({ error: "Only owners can remove members" }, { status: 403 });
  }
  const memberRole = await getDashboardRole(env, dashboardId, memberId);
  if (memberRole === "owner") {
    return Response.json({ error: "Cannot remove the owner" }, { status: 400 });
  }
  if (!memberRole) {
    return Response.json({ error: "Member not found" }, { status: 404 });
  }
  await env.DB.prepare(`
    DELETE FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?
  `).bind(dashboardId, memberId).run();
  return Response.json({ success: true });
}
__name(removeMember, "removeMember");
async function resendInvitation(env, dashboardId, userId, invitationId) {
  const role = await getDashboardRole(env, dashboardId, userId);
  if (role !== "owner") {
    return Response.json({ error: "Only owners can resend invitations" }, { status: 403 });
  }
  const invitation = await env.DB.prepare(`
    SELECT * FROM dashboard_invitations
    WHERE id = ? AND dashboard_id = ? AND accepted_at IS NULL
  `).bind(invitationId, dashboardId).first();
  if (!invitation) {
    return Response.json({ error: "Invitation not found or already accepted" }, { status: 404 });
  }
  const dashboard = await getDashboardInfo(env, dashboardId);
  if (!dashboard) {
    return Response.json({ error: "Dashboard not found" }, { status: 404 });
  }
  const inviter = await getUserById(env, userId);
  if (!inviter) {
    return Response.json({ error: "User not found" }, { status: 404 });
  }
  const newToken = generateToken();
  const now = /* @__PURE__ */ new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1e3);
  await env.DB.prepare(`
    UPDATE dashboard_invitations
    SET token = ?, expires_at = ?
    WHERE id = ?
  `).bind(newToken, expiresAt.toISOString(), invitationId).run();
  const acceptUrl = `${getFrontendUrl(env)}/login?invite=${newToken}`;
  try {
    const emailContent = buildInvitationEmail({
      inviterName: inviter.name,
      dashboardName: dashboard.name,
      role: invitation.role,
      acceptUrl
    });
    await sendEmail(env, {
      to: invitation.email,
      subject: emailContent.subject,
      html: emailContent.html
    });
  } catch (e) {
    console.error("Failed to send invitation email:", e);
    return Response.json({ error: "Failed to send email" }, { status: 500 });
  }
  return Response.json({ success: true });
}
__name(resendInvitation, "resendInvitation");
async function cancelInvitation(env, dashboardId, userId, invitationId) {
  const role = await getDashboardRole(env, dashboardId, userId);
  if (role !== "owner") {
    return Response.json({ error: "Only owners can cancel invitations" }, { status: 403 });
  }
  const invitation = await env.DB.prepare(`
    SELECT id FROM dashboard_invitations
    WHERE id = ? AND dashboard_id = ? AND accepted_at IS NULL
  `).bind(invitationId, dashboardId).first();
  if (!invitation) {
    return Response.json({ error: "Invitation not found or already accepted" }, { status: 404 });
  }
  await env.DB.prepare(`
    DELETE FROM dashboard_invitations WHERE id = ?
  `).bind(invitationId).run();
  return Response.json({ success: true });
}
__name(cancelInvitation, "cancelInvitation");
async function processPendingInvitations(env, userId, email) {
  const invitations = await env.DB.prepare(`
    SELECT id, dashboard_id, role FROM dashboard_invitations
    WHERE LOWER(email) = LOWER(?)
      AND accepted_at IS NULL
      AND expires_at > datetime('now')
  `).bind(email).all();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  for (const inv of invitations.results || []) {
    const existing = await env.DB.prepare(`
      SELECT 1 FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?
    `).bind(inv.dashboard_id, userId).first();
    if (!existing) {
      await env.DB.prepare(`
        INSERT INTO dashboard_members (dashboard_id, user_id, role, added_at)
        VALUES (?, ?, ?, ?)
      `).bind(inv.dashboard_id, userId, inv.role, now).run();
    }
    await env.DB.prepare(`
      UPDATE dashboard_invitations SET accepted_at = ? WHERE id = ?
    `).bind(now, inv.id).run();
  }
}
__name(processPendingInvitations, "processPendingInvitations");

// src/mcp-ui/handler.ts
var UI_TOOLS = [
  {
    name: "create_browser",
    description: "Create a browser panel on the dashboard to display a web page",
    inputSchema: {
      type: "object",
      properties: {
        dashboard_id: {
          type: "string",
          description: "The ID of the dashboard to create the browser in"
        },
        url: {
          type: "string",
          description: "The URL to open in the browser"
        },
        position: {
          type: "object",
          description: "Position on the canvas (optional, defaults to auto-placement)",
          properties: {
            x: { type: "number" },
            y: { type: "number" }
          }
        },
        size: {
          type: "object",
          description: "Size of the browser panel (optional)",
          properties: {
            width: { type: "number" },
            height: { type: "number" }
          }
        }
      },
      required: ["dashboard_id", "url"]
    }
  },
  {
    name: "create_todo",
    description: "Create a todo list panel on the dashboard",
    inputSchema: {
      type: "object",
      properties: {
        dashboard_id: {
          type: "string",
          description: "The ID of the dashboard to create the todo in"
        },
        title: {
          type: "string",
          description: "Title of the todo list"
        },
        items: {
          type: "array",
          description: "Initial todo items (optional)",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              completed: { type: "boolean" }
            },
            required: ["text"]
          }
        },
        position: {
          type: "object",
          description: "Position on the canvas (optional)",
          properties: {
            x: { type: "number" },
            y: { type: "number" }
          }
        },
        size: {
          type: "object",
          description: "Size of the todo panel (optional)",
          properties: {
            width: { type: "number" },
            height: { type: "number" }
          }
        }
      },
      required: ["dashboard_id", "title"]
    }
  },
  {
    name: "create_note",
    description: "Create a sticky note on the dashboard",
    inputSchema: {
      type: "object",
      properties: {
        dashboard_id: {
          type: "string",
          description: "The ID of the dashboard to create the note in"
        },
        text: {
          type: "string",
          description: "Text content of the note"
        },
        color: {
          type: "string",
          description: "Color of the note",
          enum: ["yellow", "blue", "green", "pink", "purple"]
        },
        position: {
          type: "object",
          description: "Position on the canvas (optional)",
          properties: {
            x: { type: "number" },
            y: { type: "number" }
          }
        },
        size: {
          type: "object",
          description: "Size of the note (optional)",
          properties: {
            width: { type: "number" },
            height: { type: "number" }
          }
        }
      },
      required: ["dashboard_id", "text"]
    }
  },
  {
    name: "create_terminal",
    description: "Create a new terminal panel on the dashboard",
    inputSchema: {
      type: "object",
      properties: {
        dashboard_id: {
          type: "string",
          description: "The ID of the dashboard to create the terminal in"
        },
        name: {
          type: "string",
          description: "Name of the terminal (optional)"
        },
        position: {
          type: "object",
          description: "Position on the canvas (optional)",
          properties: {
            x: { type: "number" },
            y: { type: "number" }
          }
        },
        size: {
          type: "object",
          description: "Size of the terminal panel (optional)",
          properties: {
            width: { type: "number" },
            height: { type: "number" }
          }
        }
      },
      required: ["dashboard_id"]
    }
  },
  {
    name: "update_item",
    description: "Update an existing item on the dashboard",
    inputSchema: {
      type: "object",
      properties: {
        dashboard_id: {
          type: "string",
          description: "The ID of the dashboard containing the item"
        },
        item_id: {
          type: "string",
          description: "The ID of the item to update"
        },
        content: {
          type: "string",
          description: "New content for the item (JSON string)"
        },
        position: {
          type: "object",
          description: "New position (optional)",
          properties: {
            x: { type: "number" },
            y: { type: "number" }
          }
        },
        size: {
          type: "object",
          description: "New size (optional)",
          properties: {
            width: { type: "number" },
            height: { type: "number" }
          }
        }
      },
      required: ["dashboard_id", "item_id"]
    }
  },
  {
    name: "delete_item",
    description: "Delete an item from the dashboard",
    inputSchema: {
      type: "object",
      properties: {
        dashboard_id: {
          type: "string",
          description: "The ID of the dashboard containing the item"
        },
        item_id: {
          type: "string",
          description: "The ID of the item to delete"
        }
      },
      required: ["dashboard_id", "item_id"]
    }
  },
  {
    name: "connect_nodes",
    description: "Connect two items on the dashboard with an edge",
    inputSchema: {
      type: "object",
      properties: {
        dashboard_id: {
          type: "string",
          description: "The ID of the dashboard containing the items"
        },
        source_item_id: {
          type: "string",
          description: "The ID of the source item"
        },
        target_item_id: {
          type: "string",
          description: "The ID of the target item"
        },
        source_handle: {
          type: "string",
          description: "Handle on the source item (optional)"
        },
        target_handle: {
          type: "string",
          description: "Handle on the target item (optional)"
        }
      },
      required: ["dashboard_id", "source_item_id", "target_item_id"]
    }
  },
  {
    name: "disconnect_nodes",
    description: "Remove the connection between two items",
    inputSchema: {
      type: "object",
      properties: {
        dashboard_id: {
          type: "string",
          description: "The ID of the dashboard containing the items"
        },
        source_item_id: {
          type: "string",
          description: "The ID of the source item"
        },
        target_item_id: {
          type: "string",
          description: "The ID of the target item"
        },
        source_handle: {
          type: "string",
          description: "Handle on the source item (optional, for disambiguating multiple edges)"
        },
        target_handle: {
          type: "string",
          description: "Handle on the target item (optional, for disambiguating multiple edges)"
        }
      },
      required: ["dashboard_id", "source_item_id", "target_item_id"]
    }
  },
  {
    name: "navigate_browser",
    description: "Navigate an existing browser panel to a new URL",
    inputSchema: {
      type: "object",
      properties: {
        dashboard_id: {
          type: "string",
          description: "The ID of the dashboard containing the browser"
        },
        item_id: {
          type: "string",
          description: "The ID of the browser item"
        },
        url: {
          type: "string",
          description: "The new URL to navigate to"
        }
      },
      required: ["dashboard_id", "item_id", "url"]
    }
  },
  {
    name: "add_todo_item",
    description: "Add an item to an existing todo list",
    inputSchema: {
      type: "object",
      properties: {
        dashboard_id: {
          type: "string",
          description: "The ID of the dashboard containing the todo"
        },
        item_id: {
          type: "string",
          description: "The ID of the todo block"
        },
        text: {
          type: "string",
          description: "The text of the todo item"
        },
        completed: {
          type: "boolean",
          description: "Whether the item is completed (defaults to false)"
        }
      },
      required: ["dashboard_id", "item_id", "text"]
    }
  },
  {
    name: "toggle_todo_item",
    description: "Toggle the completion status of a todo item",
    inputSchema: {
      type: "object",
      properties: {
        dashboard_id: {
          type: "string",
          description: "The ID of the dashboard containing the todo"
        },
        item_id: {
          type: "string",
          description: "The ID of the todo block"
        },
        todo_item_id: {
          type: "string",
          description: "The ID of the todo item to toggle"
        }
      },
      required: ["dashboard_id", "item_id", "todo_item_id"]
    }
  },
  {
    name: "list_items",
    description: "List all items on a dashboard",
    inputSchema: {
      type: "object",
      properties: {
        dashboard_id: {
          type: "string",
          description: "The ID of the dashboard to list items from"
        }
      },
      required: ["dashboard_id"]
    }
  }
];
function listTools() {
  return Response.json({
    tools: UI_TOOLS
  });
}
__name(listTools, "listTools");
function generateCommandId() {
  return `cmd_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}
__name(generateCommandId, "generateCommandId");
function getDashboardDO(env, dashboardId) {
  const doId = env.DASHBOARD.idFromName(dashboardId);
  return env.DASHBOARD.get(doId);
}
__name(getDashboardDO, "getDashboardDO");
async function callTool(env, toolName, args, sourceTerminalId, userId) {
  const commandId = generateCommandId();
  const dashboardId = args.dashboard_id;
  if (!dashboardId) {
    return Response.json(
      { error: "dashboard_id is required" },
      { status: 400 }
    );
  }
  if (userId) {
    const { hasAccess } = await checkDashb\u043EardAccess(env, dashboardId, userId, "editor");
    if (!hasAccess) {
      return Response.json(
        { error: "E79802: Access denied - you are not a member of this dashboard" },
        { status: 403 }
      );
    }
  }
  if (toolName === "list_items") {
    const d\u043E2 = getDashboardDO(env, dashboardId);
    const response2 = await d\u043E2.fetch(new Request("http://do/items", { method: "GET" }));
    const data = await response2.json();
    return Response.json({
      content: [
        {
          type: "text",
          text: JSON.stringify(data, null, 2)
        }
      ]
    });
  }
  let command;
  switch (toolName) {
    case "create_browser":
      command = {
        type: "create_browser",
        command_id: commandId,
        source_terminal_id: sourceTerminalId,
        url: args.url,
        position: args.position,
        size: args.size
      };
      break;
    case "create_todo":
      command = {
        type: "create_todo",
        command_id: commandId,
        source_terminal_id: sourceTerminalId,
        title: args.title,
        items: args.items,
        position: args.position,
        size: args.size
      };
      break;
    case "create_note":
      command = {
        type: "create_note",
        command_id: commandId,
        source_terminal_id: sourceTerminalId,
        text: args.text,
        color: args.color,
        position: args.position,
        size: args.size
      };
      break;
    case "create_terminal":
      command = {
        type: "create_terminal",
        command_id: commandId,
        source_terminal_id: sourceTerminalId,
        name: args.name,
        position: args.position,
        size: args.size
      };
      break;
    case "update_item":
      command = {
        type: "update_item",
        command_id: commandId,
        source_terminal_id: sourceTerminalId,
        item_id: args.item_id,
        content: args.content,
        position: args.position,
        size: args.size
      };
      break;
    case "delete_item":
      command = {
        type: "delete_item",
        command_id: commandId,
        source_terminal_id: sourceTerminalId,
        item_id: args.item_id
      };
      break;
    case "connect_nodes":
      command = {
        type: "connect_nodes",
        command_id: commandId,
        source_terminal_id: sourceTerminalId,
        source_item_id: args.source_item_id,
        target_item_id: args.target_item_id,
        source_handle: args.source_handle,
        target_handle: args.target_handle
      };
      break;
    case "disconnect_nodes":
      command = {
        type: "disconnect_nodes",
        command_id: commandId,
        source_terminal_id: sourceTerminalId,
        source_item_id: args.source_item_id,
        target_item_id: args.target_item_id,
        source_handle: args.source_handle,
        target_handle: args.target_handle
      };
      break;
    case "navigate_browser":
      command = {
        type: "navigate_browser",
        command_id: commandId,
        source_terminal_id: sourceTerminalId,
        item_id: args.item_id,
        url: args.url
      };
      break;
    case "add_todo_item":
      command = {
        type: "add_todo_item",
        command_id: commandId,
        source_terminal_id: sourceTerminalId,
        item_id: args.item_id,
        text: args.text,
        completed: args.completed
      };
      break;
    case "toggle_todo_item":
      command = {
        type: "toggle_todo_item",
        command_id: commandId,
        source_terminal_id: sourceTerminalId,
        item_id: args.item_id,
        todo_item_id: args.todo_item_id
      };
      break;
    default:
      return Response.json(
        { error: `Unknown tool: ${toolName}` },
        { status: 400 }
      );
  }
  const d\u043E = getDashboardDO(env, dashboardId);
  const response = await d\u043E.fetch(
    new Request("http://do/ui-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command)
    })
  );
  if (!response.ok) {
    const error = await response.text();
    return Response.json(
      { error: `Failed to send UI command: ${error}` },
      { status: 500 }
    );
  }
  return Response.json({
    content: [
      {
        type: "text",
        text: `Command sent successfully. Command ID: ${commandId}. The UI will execute this command asynchronously.`
      }
    ]
  });
}
__name(callTool, "callTool");
async function getItems(env, dashboardId, userId) {
  if (userId) {
    const { hasAccess } = await checkDashb\u043EardAccess(env, dashboardId, userId, "viewer");
    if (!hasAccess) {
      return Response.json(
        { error: "E79803: Access denied - you are not a member of this dashboard" },
        { status: 403 }
      );
    }
  }
  const d\u043E = getDashboardDO(env, dashboardId);
  const response = await d\u043E.fetch(new Request("http://do/items", { method: "GET" }));
  if (!response.ok) {
    return Response.json(
      { error: "Failed to get dashboard items" },
      { status: 500 }
    );
  }
  return response;
}
__name(getItems, "getItems");

// src/bug-reports/handler.ts
var BUG_REPORT_EMAIL = "rob.d.macrae@gmail.com";
var handlerRevision = "bug-report-v3-fixes";
var DATA_URL_PREFIX_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,/;
var BASE64_RE = /^[A-Za-z0-9+/\n\r]+=*$/;
var MAX_DECODED_BYTES = 5 * 1024 * 1024;
var IMAGE_TYPE_TO_EXT = {
  png: "png",
  jpeg: "jpeg",
  jpg: "jpg",
  webp: "webp",
  gif: "gif"
};
function validateScreenshot(raw) {
  const prefixMatch = raw.match(DATA_URL_PREFIX_RE);
  if (!prefixMatch) {
    return null;
  }
  const imageType = prefixMatch[1];
  const base64Content = raw.slice(prefixMatch[0].length);
  if (!base64Content || !BASE64_RE.test(base64Content)) {
    return null;
  }
  const stripped = base64Content.replace(/[\n\r]/g, "");
  const padding = stripped.endsWith("==") ? 2 : stripped.endsWith("=") ? 1 : 0;
  const decodedBytes = Math.floor(stripped.length * 3 / 4) - padding;
  if (decodedBytes > MAX_DECODED_BYTES) {
    return null;
  }
  return {
    base64: base64Content,
    ext: IMAGE_TYPE_TO_EXT[imageType] || "png"
  };
}
__name(validateScreenshot, "validateScreenshot");
async function submitBugReport(env, user, data) {
  console.log(`[bug-reports] submitBugReport called at ${(/* @__PURE__ */ new Date()).toISOString()}, revision: ${handlerRevision}`);
  const rateLimitResult = await checkRat\u0435LimitByKey(`bugreport:${user.id}`, env);
  if (!rateLimitResult.allowed) {
    return rateLimitResult.response;
  }
  const notes = typeof data.notes === "string" ? data.notes.trim() : "";
  const dashboardId = data.dashboardId || "N/A";
  const dashboardName = data.dashboardName || "N/A";
  const userAgent = data.userAgent || "N/A";
  const url = data.url || "N/A";
  let validScreenshot = null;
  let screenshotExcluded = false;
  if (data.screenshot && typeof data.screenshot === "string") {
    validScreenshot = validateScreenshot(data.screenshot);
    if (!validScreenshot) {
      console.warn("[bug-reports] Screenshot excluded: invalid format or too large");
      screenshotExcluded = true;
    }
  }
  try {
    const email = buildBugReportEmail({
      userEmail: user.email,
      userName: user.name,
      notes,
      dashboardId,
      dashboardName,
      userAgent,
      url,
      hasScreenshot: Boolean(validScreenshot)
    });
    const attachments = [];
    if (validScreenshot) {
      attachments.push({
        filename: `screenshot-${Date.now()}.${validScreenshot.ext}`,
        content: validScreenshot.base64,
        encoding: "base64"
      });
    }
    await sendEmail(env, {
      to: BUG_REPORT_EMAIL,
      subject: email.subject,
      html: email.html,
      attachments: attachments.length > 0 ? attachments : void 0
    });
    console.log(`[bug-reports] Bug report sent successfully from ${user.email}`);
    return Response.json({
      success: true,
      screenshotIncluded: Boolean(validScreenshot),
      screenshotExcluded
    }, { status: 201 });
  } catch (error) {
    console.error("[bug-reports] Failed to send bug report:", error);
    return Response.json({ error: "Failed to submit bug report" }, { status: 500 });
  }
}
__name(submitBugReport, "submitBugReport");

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
function escapeHtml3(unsafe) {
  return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
__name(escapeHtml3, "escapeHtml");
function renderErrorPage2(message) {
  const safeMessage = escapeHtml3(message);
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
  await processPendingInvitations(env, userId, userInfo.email);
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

// src/auth/admin.ts
function parseEmailList(value) {
  if (!value) {
    return null;
  }
  const entries = value.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  return entries.length > 0 ? new Set(entries) : null;
}
__name(parseEmailList, "parseEmailList");
function isAdminEmail(env, email) {
  const adminEmails = parseEmailList(env.ADMIN_EMAILS);
  if (!adminEmails) {
    return false;
  }
  return adminEmails.has(email.trim().toLowerCase());
}
__name(isAdminEmail, "isAdminEmail");

// src/health/checker.ts
init_client();
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

// src/index.ts
init_fetch();

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
  /**
   * Safely serialize attachment to a WebSocket (hibernation support).
   * No-op if hibernation APIs aren't available.
   */
  safeSerializeAttachment(ws, attachment) {
    const hws = ws;
    if (typeof hws.serializeAttachment === "function") {
      try {
        hws.serializeAttachment(attachment);
      } catch {
      }
    }
  }
  /**
   * Safely deserialize attachment from a WebSocket (hibernation support).
   * Returns null if hibernation APIs aren't available or deserialization fails.
   */
  safeDeserializeAttachment(ws) {
    const hws = ws;
    if (typeof hws.deserializeAttachment === "function") {
      try {
        return hws.deserializeAttachment();
      } catch {
      }
    }
    return null;
  }
  /**
   * Rehydrate sessions, presence, and userConnectionCount from getWebSockets().
   * Called after hibernation when in-memory state is empty but WebSocket connections exist.
   */
  rehydrateFromWebSockets() {
    const allWebSockets = this.state.getWebSockets();
    if (this.sessions.size > 0) {
      return;
    }
    if (allWebSockets.length === 0) {
      return;
    }
    console.log(`[DashboardDO] Rehydrating state from ${allWebSockets.length} WebSocket(s)`);
    this.sessions.clear();
    this.presence.clear();
    this.userConnectionCount.clear();
    for (const ws of allWebSockets) {
      const attachment = this.safeDeserializeAttachment(ws);
      if (attachment) {
        this.sessions.set(ws, attachment);
        const currentCount = this.userConnectionCount.get(attachment.userId) || 0;
        this.userConnectionCount.set(attachment.userId, currentCount + 1);
        if (!this.presence.has(attachment.userId)) {
          this.presence.set(attachment.userId, {
            userId: attachment.userId,
            userName: attachment.userName,
            cursor: null,
            selectedItemId: null,
            connectedAt: (/* @__PURE__ */ new Date()).toISOString()
          });
        }
      }
    }
    console.log(`[DashboardDO] Rehydrated: ${this.sessions.size} sessions, ${this.presence.size} users`);
  }
  /**
   * Get the count of connected WebSockets, accounting for hibernation.
   * Uses getWebSockets() which returns accurate count even after hibernation.
   */
  getConnectedClientCount() {
    return this.state.getWebSockets().length;
  }
  async fetch(request) {
    await this.initPromise;
    this.rehydrateFromWebSockets();
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
        if (this.getConnectedClientCount() === 0) {
          this.pendingBrowserOpenUrl = url2;
          await this.persistState();
        } else {
          this.pendingBrowserOpenUrl = null;
        }
        this.broadcast({ type: "browser_open", url: url2 });
      }
      return Response.json({ success: true });
    }
    if (path === "/ui-command" && request.method === "POST") {
      const command = await request.json();
      this.broadcast({ type: "ui_command", command });
      return Response.json({ success: true, command_id: command.command_id });
    }
    if (path === "/ui-command-result" && request.method === "POST") {
      const data = await request.json();
      this.broadcast({
        type: "ui_command_result",
        command_id: data.command_id,
        success: data.success,
        error: data.error,
        created_item_id: data.created_item_id
      });
      return Response.json({ success: true });
    }
    if (path === "/items" && request.method === "GET") {
      return Response.json({
        items: Array.from(this.items.values()),
        edges: Array.from(this.edges.values())
      });
    }
    if (path === "/pending-approval" && request.method === "POST") {
      const data = await request.json();
      this.broadcast({
        type: "pending_approval",
        secret_name: data.secretName,
        domain: data.domain
      });
      return Response.json({ success: true });
    }
    return new Response("Not found", { status: 404 });
  }
  handleWebSocket(ws, userId, userName) {
    const attachment = { userId, userName };
    this.safeSerializeAttachment(ws, attachment);
    this.state.acceptWebSocket(ws);
    this.sessions.set(ws, attachment);
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
    this.rehydrateFromWebSockets();
    const attachment = this.sessions.get(ws);
    if (!attachment)
      return;
    if (!this.presence.has(attachment.userId)) {
      this.presence.set(attachment.userId, {
        userId: attachment.userId,
        userName: attachment.userName,
        cursor: null,
        selectedItemId: null,
        connectedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
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
    this.rehydrateFromWebSockets();
    const attachment = this.sessions.get(ws);
    if (!attachment)
      return;
    this.sessions.delete(ws);
    const currentCount = this.userConnectionCount.get(attachment.userId) || 0;
    const newCount = currentCount - 1;
    if (newCount <= 0) {
      this.userConnectionCount.delete(attachment.userId);
      this.presence.delete(attachment.userId);
      this.broadcast({ type: "leave", user_id: attachment.userId });
    } else {
      this.userConnectionCount.set(attachment.userId, newCount);
    }
  }
  webSocketError(ws) {
    this.webSocketClose(ws);
  }
  broadcast(message, exclude) {
    const msgStr = JSON.stringify(message);
    let sentCount = 0;
    const allWebSockets = this.state.getWebSockets();
    for (const ws of allWebSockets) {
      if (ws !== exclude) {
        try {
          ws.send(msgStr);
          sentCount++;
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

// src/rate-limit/DurableObject.ts
var WINDOW_MS = {
  minute: 60 * 1e3,
  hour: 60 * 60 * 1e3,
  day: 24 * 60 * 60 * 1e3
};
var RateLimitCounter = class {
  state;
  counts = /* @__PURE__ */ new Map();
  constructor(state) {
    this.state = state;
  }
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/check" && request.method === "POST") {
      try {
        const body = await request.json();
        const result = this.checkAndMaybeIncrement(
          body.window,
          body.limit,
          body.increment ?? true
        );
        return Response.json(result);
      } catch (e) {
        return Response.json(
          { error: "Invalid request body" },
          { status: 400 }
        );
      }
    }
    if (path === "/status" && request.method === "GET") {
      const window = url.searchParams.get("window") || "minute";
      const result = this.getStatus(window);
      return Response.json(result);
    }
    if (path === "/reset" && request.method === "POST") {
      const body = await request.json();
      if (body.window) {
        this.resetWindow(body.window);
      } else {
        this.counts.clear();
      }
      return Response.json({ reset: true });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  /**
   * Check if action is allowed and optionally increment counter
   */
  checkAndMaybeIncrement(window, limit, increment) {
    const windowMs = WINDOW_MS[window];
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const key = `${window}:${windowStart}`;
    this.cleanOldWindows(windowMs, windowStart);
    let entry = this.counts.get(key);
    if (!entry) {
      entry = { count: 0, windowStart };
      this.counts.set(key, entry);
    }
    const allowed = entry.count < limit;
    const current = entry.count;
    if (allowed && increment) {
      entry.count++;
    }
    return {
      allowed,
      current: increment && allowed ? entry.count : current,
      limit,
      remaining: Math.max(0, limit - (increment && allowed ? entry.count : current)),
      resetAt: windowStart + windowMs
    };
  }
  /**
   * Get current status without incrementing
   */
  getStatus(window) {
    const windowMs = WINDOW_MS[window];
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const key = `${window}:${windowStart}`;
    const entry = this.counts.get(key);
    return {
      count: entry?.count ?? 0,
      windowStart,
      windowEnd: windowStart + windowMs
    };
  }
  /**
   * Reset a specific window
   */
  resetWindow(window) {
    const windowMs = WINDOW_MS[window];
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const key = `${window}:${windowStart}`;
    this.counts.delete(key);
  }
  /**
   * Clean expired window entries
   */
  cleanOldWindows(windowMs, currentWindowStart) {
    for (const [key, entry] of this.counts) {
      if (entry.windowStart < currentWindowStart - windowMs) {
        this.counts.delete(key);
      }
    }
  }
};
__name(RateLimitCounter, "RateLimitCounter");

// src/index.ts
console.log(`[controlplane] REVISION: index-v7-subscription-error-handling loaded at ${(/* @__PURE__ */ new Date()).toISOString()}`);
var CORS_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
var CORS_ALLOWED_HEADERS = "Content-Type, X-User-ID, X-User-Email, X-User-Name";
function parseAll\u043EwedOrigins(env) {
  if (!env.ALLOWED_ORIGINS) {
    return env.DEV_AUTH_ENABLED === "true" ? null : /* @__PURE__ */ new Set();
  }
  return new Set(
    env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  );
}
__name(parseAll\u043EwedOrigins, "parseAll\u043EwedOrigins");
var EMBED_ALLOWED_PROTOCOLS = /* @__PURE__ */ new Set(["http:", "https:"]);
var EMBED_FETCH_TIMEOUT_MS = 5e3;
var EMBED_MAX_REDIRECTS = 5;
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
async function fetchWithTimeout2(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}
__name(fetchWithTimeout2, "fetchWithTimeout");
function resolveRedirectUrl(current, location) {
  try {
    return new URL(location, current);
  } catch {
    return null;
  }
}
__name(resolveRedirectUrl, "resolveRedirectUrl");
async function fetchEmbedTarget(targetUrl) {
  let current = targetUrl;
  for (let i = 0; i <= EMBED_MAX_REDIRECTS; i++) {
    let response = await fetchWithTimeout2(
      current.toString(),
      { method: "HEAD", redirect: "manual" },
      EMBED_FETCH_TIMEOUT_MS
    );
    if (response.status === 405 || response.status === 501) {
      response = await fetchWithTimeout2(
        current.toString(),
        { method: "GET", headers: { Range: "bytes=0-0" }, redirect: "manual" },
        EMBED_FETCH_TIMEOUT_MS
      );
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      if (!location) {
        return { response, finalUrl: current };
      }
      const nextUrl = resolveRedirectUrl(current, location);
      if (!nextUrl || !EMBED_ALLOWED_PROTOCOLS.has(nextUrl.protocol) || isPrivateH\u043Estname(nextUrl.hostname)) {
        throw new Error("E79736: URL not allowed");
      }
      current = nextUrl;
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new Error("E79737: Too many redirects");
}
__name(fetchEmbedTarget, "fetchEmbedTarget");
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
  const sandboxUrlValue = sandboxUrl(env, `/sessions/${sandboxSessionId}/ptys/${ptyId}/ws`);
  sandboxUrlValue.searchParams.set("user_id", userId);
  const headers = sandboxHeaders(env, request.headers, machineId);
  headers.delete("Host");
  const body = ["POST", "PUT", "PATCH"].includes(request.method) ? request.clone().body : void 0;
  const proxyRequest = new Request(sandboxUrlValue.toString(), {
    method: request.method,
    headers,
    body,
    redirect: "manual"
  });
  return fetch(proxyRequest);
}
__name(pr\u043ExySandb\u043ExWebS\u043Ecket, "pr\u043ExySandb\u043ExWebS\u043Ecket");
async function pr\u043ExySandb\u043ExControlWebS\u043Ecket(request, env, sandboxSessionId, machineId) {
  const sandboxUrlValue = sandboxUrl(env, `/sessions/${sandboxSessionId}/control`);
  const headers = sandboxHeaders(env, request.headers, machineId);
  headers.delete("Host");
  const proxyRequest = new Request(sandboxUrlValue.toString(), {
    method: request.method,
    headers,
    redirect: "manual"
  });
  return fetch(proxyRequest);
}
__name(pr\u043ExySandb\u043ExControlWebS\u043Ecket, "pr\u043ExySandb\u043ExControlWebS\u043Ecket");
async function pr\u043ExySandb\u043ExRequest(request, env, path, machineId) {
  const sandboxUrlValue = sandboxUrl(env, path);
  sandboxUrlValue.search = new URL(request.url).search;
  const headers = sandboxHeaders(env, request.headers, machineId);
  headers.delete("Host");
  const body = request.method === "GET" || request.method === "HEAD" ? void 0 : request.body;
  const proxyRequest = new Request(sandboxUrlValue.toString(), {
    method: request.method,
    headers,
    body,
    redirect: "manual"
  });
  return fetch(proxyRequest);
}
__name(pr\u043ExySandb\u043ExRequest, "pr\u043ExySandb\u043ExRequest");
async function pr\u043ExySandb\u043ExWebS\u043EcketPath(request, env, path, machineId) {
  const sandboxUrlValue = sandboxUrl(env, path);
  sandboxUrlValue.search = new URL(request.url).search;
  const headers = sandboxHeaders(env, request.headers, machineId);
  headers.delete("Host");
  const proxyRequest = new Request(sandboxUrlValue.toString(), {
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
  async fetch(request, env, ctx) {
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
      const response = await handleRequest(request, envWithBindings, ctx);
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
      await cleanupStaleExecutions(envWithBindings);
      const { retryBufferedMessages: retryBufferedMessages2, wakeAndDrainStaleMessages: wakeAndDrainStaleMessages2, cleanupExpiredMessages: cleanupExpiredMessages2 } = await Promise.resolve().then(() => (init_delivery(), delivery_exports));
      await retryBufferedMessages2(envWithBindings);
      await wakeAndDrainStaleMessages2(envWithBindings);
      await cleanupExpiredMessages2(envWithBindings);
    } catch (error) {
      if (isDesktopFeatureDisabledError(error)) {
        return;
      }
      throw error;
    }
  }
};
async function handleRequest(request, env, ctx) {
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
  if (segments[0] === "register-interest" && segments.length === 1 && method === "POST") {
    const ipLimitResult = await checkRateLimitIp(request, env);
    if (!ipLimitResult.allowed) {
      return ipLimitResult.response;
    }
    const data = await request.json();
    const email = typeof data.email === "string" ? data.email.trim() : "";
    const note = typeof data.note === "string" ? data.note.trim() : "";
    if (!email || !email.includes("@")) {
      return Response.json({ error: "Valid email is required" }, { status: 400 });
    }
    const truncatedNote = note.slice(0, 1e3);
    try {
      const thankYouEmail = buildInterestThankYouEmail();
      await sendEmail(env, {
        to: email,
        subject: thankYouEmail.subject,
        html: thankYouEmail.html
      });
      const notificationEmail = buildInterestNotificationEmail({
        email,
        note: truncatedNote || void 0
      });
      await sendEmail(env, {
        to: "rob.d.macrae@gmail.com",
        subject: notificationEmail.subject,
        html: notificationEmail.html
      });
      return Response.json({ success: true, message: "Interest registered successfully" }, { status: 201 });
    } catch (error) {
      console.error("Failed to send interest registration emails:", error);
      return Response.json({ error: "Failed to register interest. Please try again." }, { status: 500 });
    }
  }
  if (segments[0] === "bug-reports" && segments.length === 1 && method === "POST") {
    console.log("[controlplane] Bug report route matched, revision: controlplane-v2-bugreport");
    const authError = requireAuth(auth);
    if (authError) {
      console.log("[controlplane] Bug report auth error:", authError);
      return authError;
    }
    let data;
    try {
      data = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    return submitBugReport(env, auth.user, data);
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
    let finalUrl;
    try {
      const result = await fetchEmbedTarget(targetUrl);
      response = result.response;
      finalUrl = result.finalUrl;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("E79736")) {
        return Response.json({ error: "E79736: URL not allowed" }, { status: 400 });
      }
      if (error instanceof Error && error.message.startsWith("E79737")) {
        return Response.json({ error: "E79737: Too many redirects" }, { status: 400 });
      }
      console.warn("Embed check fetch failed:", error);
      return Response.json({ embeddable: true, reason: "fetch_failed" });
    }
    const checkedUrl = finalUrl.toString();
    const checkedOrigin = finalUrl.origin;
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
  if (segments[0] === "dashboards" && segments.length === 3 && segments[2] === "ui-command-result" && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    return sendUICommandResult(env, segments[1], auth.user.id, data);
  }
  if (segments[0] === "dashboards" && segments.length === 3 && segments[2] === "members" && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return listMembers(env, segments[1], auth.user.id);
  }
  if (segments[0] === "dashboards" && segments.length === 3 && segments[2] === "members" && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    return addMember(env, segments[1], auth.user.id, data);
  }
  if (segments[0] === "dashboards" && segments.length === 4 && segments[2] === "members" && method === "PUT") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    return updateMemberRole(env, segments[1], auth.user.id, segments[3], data);
  }
  if (segments[0] === "dashboards" && segments.length === 4 && segments[2] === "members" && method === "DELETE") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return removeMember(env, segments[1], auth.user.id, segments[3]);
  }
  if (segments[0] === "dashboards" && segments.length === 5 && segments[2] === "invitations" && segments[4] === "resend" && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return resendInvitation(env, segments[1], auth.user.id, segments[3]);
  }
  if (segments[0] === "dashboards" && segments.length === 4 && segments[2] === "invitations" && method === "DELETE") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return cancelInvitation(env, segments[1], auth.user.id, segments[3]);
  }
  if (segments[0] === "dashboards" && segments.length === 3 && segments[2] === "integration-labels" && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return listDashboardIntegrationLabels(env, segments[1], auth.user.id);
  }
  if (segments[0] === "dashboards" && segments.length === 5 && segments[2] === "terminals" && segments[4] === "available-integrations" && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return listAvailableIntegrations(env, segments[1], segments[3], auth.user.id);
  }
  if (segments[0] === "dashboards" && segments.length === 5 && segments[2] === "terminals" && segments[4] === "integrations" && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return listTerminalIntegrations(env, segments[1], segments[3], auth.user.id);
  }
  if (segments[0] === "dashboards" && segments.length === 5 && segments[2] === "terminals" && segments[4] === "integrations" && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    return attachIntegration(env, segments[1], segments[3], auth.user.id, data);
  }
  if (segments[0] === "dashboards" && segments.length === 6 && segments[2] === "terminals" && segments[4] === "integrations" && method === "PUT") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    return updateIntegrationPolicy(
      env,
      segments[1],
      segments[3],
      segments[5],
      auth.user.id,
      data
    );
  }
  if (segments[0] === "dashboards" && segments.length === 6 && segments[2] === "terminals" && segments[4] === "integrations" && method === "DELETE") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return detachIntegration(
      env,
      segments[1],
      segments[3],
      segments[5],
      auth.user.id
    );
  }
  if (segments[0] === "dashboards" && segments.length === 7 && segments[2] === "terminals" && segments[4] === "integrations" && segments[6] === "history" && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return getPolicyHistory(
      env,
      segments[1],
      segments[3],
      segments[5],
      auth.user.id
    );
  }
  if (segments[0] === "dashboards" && segments.length === 7 && segments[2] === "terminals" && segments[4] === "integrations" && segments[6] === "audit" && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const limit = parseInt(url.searchParams.get("limit") || "100", 10);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    return getAuditLog(
      env,
      segments[1],
      segments[3],
      segments[5],
      auth.user.id,
      limit,
      offset
    );
  }
  if (segments[0] === "dashboards" && segments.length === 3 && segments[2] === "integration-audit" && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const limit = parseInt(url.searchParams.get("limit") || "100", 10);
    const offset = parseInt(url.searchParams.get("offset") || "0", 10);
    return getDashboardAuditLog(env, segments[1], auth.user.id, limit, offset);
  }
  if (segments[0] === "dashboards" && segments.length === 3 && segments[2] === "workspace-snapshot" && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return getWorkspaceSnapshot(env, segments[1], auth.user.id);
  }
  if (segments[0] === "templates" && segments.length === 1 && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const category = url.searchParams.get("category") || void 0;
    const admin = isAdminEmail(env, auth.user.email);
    return listTemplates(env, category, admin);
  }
  if (segments[0] === "templates" && segments.length === 2 && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return getTemplate(env, segments[1]);
  }
  if (segments[0] === "templates" && segments.length === 1 && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    const response = await createTemplate(env, auth.user.id, data);
    if (response.ok) {
      const cloned = response.clone();
      ctx.waitUntil(
        cloned.json().then((body) => {
          const reviewEmail = buildTemplateReviewEmail({
            templateName: data.name,
            authorName: auth.user.name || "Unknown",
            authorEmail: auth.user.email,
            category: data.category || "custom",
            itemCount: body.template.itemCount
          });
          return sendEmail(env, {
            to: "rob.d.macrae@gmail.com",
            subject: reviewEmail.subject,
            html: reviewEmail.html
          });
        }).catch((err) => console.error("Failed to send template review email:", err))
      );
    }
    return response;
  }
  if (segments[0] === "templates" && segments.length === 3 && segments[2] === "approve" && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    if (!isAdminEmail(env, auth.user.email)) {
      return Response.json(
        { error: "E79807: Admin access required" },
        { status: 403 }
      );
    }
    const { status: newStatus } = await request.json();
    return approveTemplate(env, segments[1], newStatus);
  }
  if (segments[0] === "templates" && segments.length === 2 && method === "DELETE") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const admin = isAdminEmail(env, auth.user.email);
    return deleteTemplate(env, auth.user.id, segments[1], admin);
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
    const type = url2.searchParams.get("type");
    return listSecrets(env, auth.user.id, dashboardId, type || void 0);
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
      "DELETE google/drive/disconnect": disconnectGoogleDrive,
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
      "DELETE github/disconnect": disconnectGithub,
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
      "DELETE box/disconnect": disconnectBox,
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
      "DELETE onedrive/disconnect": disconnectOnedrive,
      "GET onedrive/status": get\u041EnedriveSyncStatus,
      "POST onedrive/sync": sync\u041EnedriveMirr\u043Er,
      "POST onedrive/sync/large": sync\u041EnedriveLargeFiles,
      "GET onedrive/manifest": get\u041EnedriveManifest,
      // Gmail
      "GET google/gmail/connect": connectGmail,
      "GET google/gmail/callback": (request2, env2) => callbackGmail(request2, env2),
      "GET google/gmail": getGmailIntegration,
      "POST google/gmail/setup": setupGmailMirror,
      "DELETE google/gmail": unlinkGmailMirror,
      "GET google/gmail/status": getGmailStatus,
      "POST google/gmail/sync": syncGmailMirror,
      "GET google/gmail/messages": getGmailMessages,
      "GET google/gmail/message": getGmailMessageDetail,
      "POST google/gmail/action": performGmailAction,
      "POST google/gmail/watch": startGmailWatch,
      "POST google/gmail/stop": stopGmailWatchEndpoint,
      "POST google/gmail/push": (request2, env2) => handleGmailPush(request2, env2),
      "DELETE google/gmail/disconnect": disconnectGmail,
      // Google Calendar
      "GET google/calendar/connect": connectCalendar,
      "GET google/calendar/callback": (request2, env2) => callbackCalendar(request2, env2),
      "GET google/calendar": getCalendarIntegration,
      "POST google/calendar/setup": setupCalendarMirror,
      "DELETE google/calendar": unlinkCalendarMirror,
      "GET google/calendar/status": getCalendarStatus,
      "POST google/calendar/sync": syncCalendarMirror,
      "GET google/calendar/events": getCalendarEvents,
      "GET google/calendar/event": getCalendarEventDetail,
      "DELETE google/calendar/disconnect": disconnectCalendar,
      // Google Contacts
      "GET google/contacts/connect": connectContacts,
      "GET google/contacts/callback": (request2, env2) => callbackContacts(request2, env2),
      "GET google/contacts": getContactsIntegration,
      "POST google/contacts/setup": setupContactsMirror,
      "DELETE google/contacts": unlinkContactsMirror,
      "GET google/contacts/status": getContactsStatus,
      "POST google/contacts/sync": syncContactsMirror,
      "GET google/contacts/list": getContacts,
      "GET google/contacts/detail": getContactDetail,
      "GET google/contacts/search": searchContactsEndpoint,
      "DELETE google/contacts/disconnect": disconnectContacts,
      // Google Sheets
      "GET google/sheets/connect": connectSheets,
      "GET google/sheets/callback": (request2, env2) => callbackSheets(request2, env2),
      "GET google/sheets": getSheetsIntegration,
      "POST google/sheets/setup": setupSheetsMirror,
      "DELETE google/sheets": unlinkSheetsMirror,
      "GET google/sheets/list": listSpreadsheetsEndpoint,
      "GET google/sheets/spreadsheet": getSpreadsheetEndpoint,
      "GET google/sheets/values": readSheetValues,
      "POST google/sheets/values": writeSheetValues,
      "POST google/sheets/append": appendSheetValuesEndpoint,
      "POST google/sheets/link": setLinkedSpreadsheet,
      "DELETE google/sheets/disconnect": disconnectSheets,
      // Google Forms
      "GET google/forms/connect": connectForms,
      "GET google/forms/callback": (request2, env2) => callbackForms(request2, env2),
      "GET google/forms": getFormsIntegration,
      "POST google/forms/setup": setupFormsMirror,
      "DELETE google/forms": unlinkFormsMirror,
      "GET google/forms/list": listFormsEndpoint,
      "GET google/forms/form": getFormEndpoint,
      "GET google/forms/responses": getFormResponsesEndpoint,
      "POST google/forms/link": setLinkedForm,
      "DELETE google/forms/disconnect": disconnectForms,
      // Slack
      "GET slack/connect": connectSlack,
      "GET slack/callback": (request2, env2) => callbackSlack(request2, env2),
      "GET slack": getSlackIntegration,
      "GET slack/status": getSlackStatus,
      "GET slack/channels": listSlackChannels,
      "DELETE slack": disconnectSlack,
      // Discord
      "GET discord/connect": connectDiscord,
      "GET discord/callback": (request2, env2) => callbackDiscord(request2, env2),
      "GET discord": getDiscordIntegration,
      "GET discord/status": getDiscordStatus,
      "GET discord/channels": listDiscordChannels,
      "DELETE discord": disconnectDiscord
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
  if (segments[0] === "secrets" && segments.length === 3 && segments[2] === "protection" && method === "PATCH") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const url2 = new URL(request.url);
    const dashboardId = url2.searchParams.get("dashboard_id");
    const data = await request.json();
    return updateSecretProtection(env, auth.user.id, segments[1], dashboardId, data.brokerProtected);
  }
  if (segments[0] === "secrets" && segments.length === 3 && segments[2] === "allowlist" && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const url2 = new URL(request.url);
    const dashboardId = url2.searchParams.get("dashboard_id");
    return listSecretAllowlist(env, auth.user.id, segments[1], dashboardId);
  }
  if (segments[0] === "secrets" && segments.length === 3 && segments[2] === "allowlist" && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const url2 = new URL(request.url);
    const dashboardId = url2.searchParams.get("dashboard_id");
    const data = await request.json();
    return approveSecretDomain(env, auth.user.id, segments[1], dashboardId, data);
  }
  if (segments[0] === "secrets" && segments.length === 4 && segments[2] === "allowlist" && method === "DELETE") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const url2 = new URL(request.url);
    const dashboardId = url2.searchParams.get("dashboard_id");
    return revokeSecretDomain(env, auth.user.id, segments[1], segments[3], dashboardId);
  }
  if (segments[0] === "pending-approvals" && segments.length === 1 && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const url2 = new URL(request.url);
    const dashboardId = url2.searchParams.get("dashboard_id");
    return listPendingApprovals(env, auth.user.id, dashboardId);
  }
  if (segments[0] === "pending-approvals" && segments.length === 2 && method === "DELETE") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return dismissPendingApproval(env, auth.user.id, segments[1]);
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
  if (segments[0] === "dashboards" && segments[2] === "browser" && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const access = await env.DB.prepare(`
      SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ? AND role IN ('owner', 'editor')
    `).bind(segments[1], auth.user.id).first();
    if (!access) {
      return Response.json({ error: "E79301: Not found or no access" }, { status: 404 });
    }
    const sandbox = await env.DB.prepare(`
      SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes WHERE dashboard_id = ?
    `).bind(segments[1]).first();
    if (!sandbox?.sandbox_session_id) {
      return Response.json({ error: "E79816: Browser session not found" }, { status: 404 });
    }
    const suffix = segments.slice(3).join("/");
    const path2 = `/sessions/${sandbox.sandbox_session_id}/browser/${suffix}`;
    return pr\u043ExySandb\u043ExRequest(request, env, path2, sandbox.sandbox_machine_id);
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
  if (segments[0] === "dashboards" && segments.length === 3 && segments[2] === "metrics" && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const access = await env.DB.prepare(`
      SELECT 1 FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?
    `).bind(segments[1], auth.user.id).first();
    if (!access) {
      return Response.json({ error: "E79301: Not found or no access" }, { status: 404 });
    }
    const sandbox = await env.DB.prepare(`
      SELECT sandbox_session_id, sandbox_machine_id FROM dashboard_sandboxes WHERE dashboard_id = ?
    `).bind(segments[1]).first();
    if (!sandbox?.sandbox_session_id) {
      return Response.json({ error: "E79817: No active sandbox for this dashboard" }, { status: 404 });
    }
    return pr\u043ExySandb\u043ExRequest(
      request,
      env,
      `/sessions/${sandbox.sandbox_session_id}/metrics`,
      sandbox.sandbox_machine_id
    );
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
  if (segments[0] === "sessions" && segments.length === 3 && segments[2] === "apply-secrets" && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return applySecretsToSession(env, segments[1], auth.user.id);
  }
  if (segments[0] === "sessions" && segments.length === 3 && segments[2] === "attachments" && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    return attachSessionResources(env, auth.user.id, segments[1], data);
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
    return Response.json({
      user: auth.user,
      isAdmin: isAdminEmail(env, auth.user.email)
    });
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
  if (segments[0] === "internal" && segments[1] === "sessions" && segments.length === 4 && segments[3] === "approval-request" && method === "POST") {
    const authError = requireInternalAuth(request, env);
    if (authError)
      return authError;
    const data = await request.json();
    return createApprovalRequestInternal(env, segments[2], data);
  }
  if (segments[0] === "internal" && segments[1] === "sessions" && segments.length === 4 && segments[3] === "approved-domains" && method === "GET") {
    const authError = requireInternalAuth(request, env);
    if (authError)
      return authError;
    return getApprovedDomainsInternal(env, segments[2]);
  }
  if (segments[0] === "internal" && segments[1] === "gateway" && segments.length === 4 && segments[3] === "validate" && method === "POST") {
    const authError = requireInternalAuth(request, env);
    if (authError)
      return authError;
    const data = await request.json();
    return validateGatewayRequest(
      env,
      data.terminalId,
      segments[2],
      data.dashboardId,
      data.userId
    );
  }
  if (segments[0] === "internal" && segments[1] === "gateway" && segments.length === 4 && segments[3] === "validate-token" && method === "POST") {
    const ptyToken = request.headers.get("X-PTY-Token");
    if (!ptyToken) {
      return Response.json({ error: "AUTH_DENIED", reason: "Missing X-PTY-Token header" }, { status: 401 });
    }
    let action;
    let args;
    try {
      const body = await request.json();
      action = body.action;
      args = body.args;
    } catch {
    }
    const { deriveEnforcementContext: deriveEnforcementContext2 } = await Promise.resolve().then(() => (init_gateway(), gateway_exports));
    const context = args && action ? deriveEnforcementContext2(action, args) : void 0;
    return validateGatewayWithToken(
      env,
      ptyToken,
      segments[2],
      action,
      context
    );
  }
  if (segments[0] === "internal" && segments[1] === "gateway" && segments.length === 4 && segments[3] === "execute" && method === "POST") {
    const { handleGatewayExecute: handleGatewayExecute2 } = await Promise.resolve().then(() => (init_gateway(), gateway_exports));
    return handleGatewayExecute2(
      request,
      env,
      segments[2]
    );
  }
  if (segments[0] === "internal" && segments[1] === "terminals" && segments.length === 4 && segments[3] === "integrations" && method === "GET") {
    const { handleListTerminalIntegrations: handleListTerminalIntegrations2 } = await Promise.resolve().then(() => (init_gateway(), gateway_exports));
    return handleListTerminalIntegrations2(
      request,
      env,
      segments[2]
    );
  }
  if (segments[0] === "internal" && segments[1] === "gateway" && segments[2] === "audit" && segments.length === 3 && method === "POST") {
    const authError = requireInternalAuth(request, env);
    if (authError)
      return authError;
    const data = await request.json();
    return logAuditEntry(env, data);
  }
  if (segments[0] === "webhooks" && (segments.length === 2 || segments.length === 3) && method === "POST") {
    const { handleInboundWebhook: handleInboundWebhook2 } = await Promise.resolve().then(() => (init_webhook_handler(), webhook_handler_exports));
    const provider = segments[1];
    const hookId = segments.length === 3 ? segments[2] : void 0;
    return handleInboundWebhook2(request, env, provider, hookId, ctx);
  }
  if (segments[0] === "messaging" && segments[1] === "subscriptions" && segments.length === 2 && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const dashboardId = url.searchParams.get("dashboard_id");
    if (!dashboardId) {
      return Response.json({ error: "dashboard_id required" }, { status: 400 });
    }
    const membership = await env.DB.prepare(
      "SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?"
    ).bind(dashboardId, auth.user.id).first();
    if (!membership) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const { listSubscriptions: listSubscriptions2 } = await Promise.resolve().then(() => (init_webhook_handler(), webhook_handler_exports));
    return Response.json(await listSubscriptions2(env, dashboardId));
  }
  if (segments[0] === "messaging" && segments[1] === "subscriptions" && segments.length === 2 && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    if (!data.dashboardId || !data.itemId || !data.provider) {
      return Response.json({ error: "dashboardId, itemId, and provider are required" }, { status: 400 });
    }
    const WEBHOOK_READY_PROVIDERS = ["slack", "discord", "telegram"];
    if (!WEBHOOK_READY_PROVIDERS.includes(data.provider)) {
      return Response.json({ error: `Provider '${data.provider}' does not have webhook support yet` }, { status: 400 });
    }
    const membership = await env.DB.prepare(
      "SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?"
    ).bind(data.dashboardId, auth.user.id).first();
    if (!membership) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const item = await env.DB.prepare(
      "SELECT id, type FROM dashboard_items WHERE id = ? AND dashboard_id = ?"
    ).bind(data.itemId, data.dashboardId).first();
    if (!item) {
      return Response.json({ error: "Item not found in dashboard" }, { status: 404 });
    }
    if (item.type !== data.provider) {
      return Response.json(
        { error: `Item type '${item.type}' does not match provider '${data.provider}'` },
        { status: 400 }
      );
    }
    if ((data.provider === "slack" || data.provider === "discord") && !data.channelId) {
      return Response.json(
        { error: `channelId is required for ${data.provider} subscriptions \u2014 resolve channel name to ID client-side` },
        { status: 400 }
      );
    }
    if (data.provider === "telegram" && !data.chatId) {
      return Response.json(
        { error: "chatId is required for telegram subscriptions" },
        { status: 400 }
      );
    }
    const { createSubscription: createSubscription2, SubscriptionError: SubscriptionError2 } = await Promise.resolve().then(() => (init_webhook_handler(), webhook_handler_exports));
    const webhookBaseUrl = env.OAUTH_REDIRECT_BASE?.replace(/\/$/, "") || new URL(request.url).origin;
    try {
      const result = await createSubscription2(env, data.dashboardId, data.itemId, auth.user.id, data.provider, {
        channelId: data.channelId,
        channelName: data.channelName,
        chatId: data.chatId
      }, webhookBaseUrl);
      return Response.json(result, { status: 201 });
    } catch (err) {
      if (err instanceof SubscriptionError2) {
        return Response.json({ error: err.message, code: err.code }, { status: 400 });
      }
      throw err;
    }
  }
  if (segments[0] === "messaging" && segments[1] === "subscriptions" && segments.length === 3 && method === "DELETE") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const sub = await env.DB.prepare(
      `SELECT ms.id, ms.dashboard_id FROM messaging_subscriptions ms
       JOIN dashboard_members dm ON dm.dashboard_id = ms.dashboard_id AND dm.user_id = ?
       WHERE ms.id = ? AND ms.user_id = ?`
    ).bind(auth.user.id, segments[2], auth.user.id).first();
    if (!sub) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const { deleteSubscription: deleteSubscription2 } = await Promise.resolve().then(() => (init_webhook_handler(), webhook_handler_exports));
    await deleteSubscription2(env, segments[2], auth.user.id);
    return Response.json({ ok: true });
  }
  if (segments[0] === "schedules" && segments.length === 1 && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return listSchedules(env, auth.user.id, {
      recipeId: url.searchParams.get("recipe_id") || void 0,
      dashboardId: url.searchParams.get("dashboard_id") || void 0,
      dashboardItemId: url.searchParams.get("dashboard_item_id") || void 0
    });
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
  if (segments[0] === "schedules" && segments.length === 3 && segments[2] === "executions" && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return listScheduleExecutions(env, segments[1], auth.user.id);
  }
  if (segments[0] === "internal" && segments[1] === "schedule-executions" && segments.length === 4 && segments[3] === "pty-completed" && method === "POST") {
    const authError = requireInternalAuth(request, env);
    if (authError)
      return authError;
    const data = await request.json();
    if (!data.ptyId || !data.status) {
      return Response.json({ error: "E79745: ptyId and status are required" }, { status: 400 });
    }
    return handlePtyCompleted(env, segments[2], data);
  }
  if (segments[0] === "internal" && segments[1] === "events" && segments.length === 2 && method === "POST") {
    const authError = requireInternalAuth(request, env);
    if (authError)
      return authError;
    const data = await request.json();
    return emitEvent(env, data.event, data.payload);
  }
  if (segments[0] === "internal" && segments[1] === "migrate-secrets" && segments.length === 2 && method === "POST") {
    const authError = requireInternalAuth(request, env);
    if (authError)
      return authError;
    return migrateUnencryptedSecrets(env);
  }
  if (segments[0] === "internal" && segments[1] === "mcp" && segments[2] === "ui" && segments[3] === "tools" && segments.length === 4 && method === "GET") {
    const mcpAuth = await validateMcpAuth(request, env);
    if (!mcpAuth.isValid)
      return mcpAuth.error;
    return listTools();
  }
  if (segments[0] === "internal" && segments[1] === "mcp" && segments[2] === "ui" && segments[3] === "tools" && segments[4] === "call" && segments.length === 5 && method === "POST") {
    const mcpAuth = await validateMcpAuth(request, env);
    if (!mcpAuth.isValid)
      return mcpAuth.error;
    const data = await request.json();
    if (!data.arguments.dashboard_id) {
      return Response.json({ error: "E79801: dashboard_id is required in arguments" }, { status: 400 });
    }
    if (!mcpAuth.isFullAccess && mcpAuth.dashboardId !== data.arguments.dashboard_id) {
      return Response.json(
        { error: "E79804: Dashboard token does not match dashboard_id in request" },
        { status: 403 }
      );
    }
    return callTool(env, data.name, data.arguments, data.source_terminal_id);
  }
  if (segments[0] === "internal" && segments[1] === "mcp" && segments[2] === "ui" && segments[3] === "dashboards" && segments.length === 6 && segments[5] === "items" && method === "GET") {
    const mcpAuth = await validateMcpAuth(request, env);
    if (!mcpAuth.isValid)
      return mcpAuth.error;
    const requestedDashboardId = segments[4];
    if (!mcpAuth.isFullAccess && mcpAuth.dashboardId !== requestedDashboardId) {
      return Response.json(
        { error: "E79804: Dashboard token does not match requested dashboard" },
        { status: 403 }
      );
    }
    return getItems(env, requestedDashboardId);
  }
  if (segments[0] === "internal" && segments[1] === "dashboards" && segments.length === 4 && segments[3] === "mcp-tools" && method === "GET") {
    const authError = requireInternalAuth(request, env);
    if (authError)
      return authError;
    return getMcpToolsForDashboard(env, segments[2]);
  }
  if (segments[0] === "mcp" && segments[1] === "ui" && segments[2] === "tools" && segments.length === 3 && method === "GET") {
    return listTools();
  }
  if (segments[0] === "mcp" && segments[1] === "ui" && segments[2] === "tools" && segments[3] === "call" && segments.length === 4 && method === "POST") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    const data = await request.json();
    return callTool(env, data.name, data.arguments, data.source_terminal_id, auth.user.id);
  }
  if (segments[0] === "mcp" && segments[1] === "ui" && segments[2] === "dashboards" && segments.length === 5 && segments[4] === "items" && method === "GET") {
    const authError = requireAuth(auth);
    if (authError)
      return authError;
    return getItems(env, segments[3], auth.user.id);
  }
  return Response.json({ error: "E79999: Not found" }, { status: 404 });
}
__name(handleRequest, "handleRequest");
export {
  DashboardDO,
  RateLimitCounter,
  src_default as default
};
//# sourceMappingURL=index.js.map
