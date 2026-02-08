// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Env } from "../types";
import { isDesktopFeatureDisabledError } from "../storage/drive-cache";
import { sandboxFetch, sandboxUrl } from "../sandbox/fetch";

type AttachmentSpec = {
  name: string;
  sourceUrl?: string;
  content?: string;
};

type McpToolSpec = {
  name: string;
  serverUrl: string;
  transport: string;
  config?: Record<string, unknown>;
};

type AttachmentRequest = {
  terminalType?: string;
  attach?: {
    agents?: AttachmentSpec[];
    skills?: AttachmentSpec[];
  };
  detach?: {
    agents?: string[];
    skills?: string[];
  };
  mcpTools?: McpToolSpec[];
};

type AttachmentFile = {
  path: string;
  data: ArrayBuffer;
  contentType?: string | null;
};

const CACHE_PREFIX = "attachments-cache";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5MB per file
const MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024; // 25MB total per attachment

const TERMINAL_PATHS: Record<string, { skills: string | null; agents: string | null }> = {
  claude: { skills: "/.claude/skills", agents: "/.claude/agents" },
  gemini: { skills: "/.gemini/skills", agents: null },
  codex: { skills: "/.codex/skills", agents: null },
  opencode: { skills: "/.config/opencode/skills", agents: "/.config/opencode/agents" },
  droid: { skills: "/.factory/skills", agents: "/.factory/droids" },
  openclaw: { skills: "/.openclaw/skills", agents: null },
  moltbot: { skills: "/.openclaw/skills", agents: null },
};

class AttachmentError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "AttachmentError";
    this.status = status;
  }
}

export async function attachSessionResources(
  env: Env,
  userId: string,
  sessionId: string,
  data: AttachmentRequest
): Promise<Response> {
  try {
    if (!data || !data.terminalType) {
      return Response.json({ error: "E79801: terminalType required" }, { status: 400 });
    }

  const session = await env.DB.prepare(`
      SELECT s.* FROM sessions s
      JOIN dashboard_members dm ON s.dashboard_id = dm.dashboard_id
      WHERE s.id = ? AND dm.user_id = ?
    `).bind(sessionId, userId).first() as Record<string, unknown> | null;

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

  const sandboxSessionId = session.sandbox_session_id as string;
  const machineId = session.sandbox_machine_id as string | undefined;

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
      if (files.length === 0) continue;
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
      if (files.length === 0) continue;
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

// MCP settings generation — writes config files for all supported agent types

type McpServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
};

function buildMcpServerConfigs(tools: McpToolSpec[]): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};

  for (const tool of tools) {
    // Skip tools without a name
    if (!tool.name) continue;

    // Handle built-in OrcaBot MCP tool
    if (tool.serverUrl === "builtin://mcp-bridge") {
      servers.orcabot = { command: "mcp-bridge", env: {} };
      continue;
    }

    const config: McpServerConfig = {};
    const toolConfig = tool.config || {};

    if (tool.transport === "stdio") {
      // Use serverUrl as the command (e.g., "npx") if set, otherwise fall back to config.command
      const command = tool.serverUrl || (typeof toolConfig.command === "string" ? toolConfig.command : undefined);

      // Skip stdio tools without a command
      if (!command) continue;

      config.command = command;

      // Build args: prepend config.command (package name) to config.args when serverUrl is set
      const args: string[] = [];
      if (typeof toolConfig.command === "string" && tool.serverUrl) {
        // When serverUrl is "npx", config.command is the package name (e.g., "@anthropic/mcp-server-filesystem")
        args.push(toolConfig.command);
      }
      if (Array.isArray(toolConfig.args)) {
        args.push(...toolConfig.args.filter((a): a is string => typeof a === "string"));
      }
      if (args.length > 0) config.args = args;

      if (toolConfig.env && typeof toolConfig.env === "object") {
        config.env = {};
        for (const [k, v] of Object.entries(toolConfig.env as Record<string, unknown>)) {
          if (typeof v === "string") config.env[k] = v;
        }
      }
    } else if (tool.transport === "sse" || tool.transport === "streamable-http") {
      const url = tool.serverUrl || (typeof toolConfig.url === "string" ? toolConfig.url : undefined);

      // Skip sse/streamable-http tools without a URL
      if (!url) continue;

      config.type = tool.transport;
      config.url = url;
    } else {
      // Skip tools with unknown transport
      continue;
    }

    servers[tool.name] = config;
  }
  return servers;
}

function generateClaudeSettingsJson(servers: Record<string, McpServerConfig>): string {
  return JSON.stringify({ mcpServers: servers }, null, 2);
}

function generateOpenCodeSettingsJson(servers: Record<string, McpServerConfig>): string {
  const mcp: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    mcp[name] = { ...server, enabled: true };
  }
  return JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp }, null, 2);
}

function generateGeminiSettingsJson(servers: Record<string, McpServerConfig>): string {
  const mcpServers: Record<string, { command?: string; args?: string[]; url?: string; type?: string }> = {};
  for (const [name, server] of Object.entries(servers)) {
    const s: { command?: string; args?: string[]; url?: string; type?: string } = {};
    if (server.command) s.command = server.command;
    if (server.args) s.args = server.args;
    if (server.url) s.url = server.url;
    if (server.type) s.type = server.type;
    mcpServers[name] = s;
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

function generateCodexConfigToml(servers: Record<string, McpServerConfig>): string {
  const lines: string[] = ["# Codex MCP configuration (auto-generated by OrcaBot)", ""];
  for (const [name, server] of Object.entries(servers)) {
    if (!server.command) continue;
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

function generateDroidSettingsJson(servers: Record<string, McpServerConfig>): string {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.url) {
      mcpServers[name] = {
        type: server.type === "sse" ? "sse" : "http",
        url: server.url,
        disabled: false,
      };
    } else {
      mcpServers[name] = {
        type: "stdio",
        command: server.command || "",
        args: server.args || [],
        disabled: false,
      };
    }
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

type MpcSettingsFileSpec = { path: string; content: string; contentType: string };

const MCP_SETTINGS_BY_TERMINAL: Record<string, (servers: Record<string, McpServerConfig>) => MpcSettingsFileSpec> = {
  claude: (servers) => ({ path: "/.claude/settings.json", content: generateClaudeSettingsJson(servers), contentType: "application/json" }),
  opencode: (servers) => ({ path: "/.config/opencode/opencode.json", content: generateOpenCodeSettingsJson(servers), contentType: "application/json" }),
  gemini: (servers) => ({ path: "/.gemini/settings.json", content: generateGeminiSettingsJson(servers), contentType: "application/json" }),
  codex: (servers) => ({ path: "/.codex/config.toml", content: generateCodexConfigToml(servers), contentType: "application/toml" }),
  droid: (servers) => ({ path: "/.factory/mcp.json", content: generateDroidSettingsJson(servers), contentType: "application/json" }),
};

async function writeMcpSettings(
  env: Env,
  sandboxSessionId: string,
  machineId: string | undefined,
  terminalType: string,
  tools: McpToolSpec[]
): Promise<void> {
  const settingsGenerator = MCP_SETTINGS_BY_TERMINAL[terminalType];
  if (!settingsGenerator) {
    // Terminal type doesn't support MCP settings (e.g., shell, copilot)
    return;
  }

  const servers = buildMcpServerConfigs(tools);
  const encoder = new TextEncoder();
  const { path, content, contentType } = settingsGenerator(servers);

  await putSandboxFile(env, sandboxSessionId, machineId, path, {
    path: path.split("/").pop() || "settings.json",
    data: encoder.encode(content).buffer as ArrayBuffer,
    contentType,
  });
}

async function resolveAttachmentFiles(env: Env, attachment: AttachmentSpec): Promise<AttachmentFile[]> {
  if (attachment.sourceUrl) {
    validateAttachmentUrl(attachment.sourceUrl);
    return getCachedFiles(env, attachment.sourceUrl);
  }
  if (attachment.content) {
    const encoder = new TextEncoder();
    return [{
      path: "SKILL.md",
      data: encoder.encode(attachment.content).buffer,
      contentType: "text/markdown",
    }];
  }
  return [];
}

async function getCachedFiles(env: Env, sourceUrl: string): Promise<AttachmentFile[]> {
  if (!env.DRIVE_CACHE) {
    return fetchSourceFiles(sourceUrl);
  }
  const hash = await sha256(sourceUrl);
  const manifestKey = `${CACHE_PREFIX}/${hash}/manifest.json`;
  const now = Date.now();
  let cachedManifest: R2ObjectBody | null = null;
  try {
    cachedManifest = await env.DRIVE_CACHE.get(manifestKey);
  } catch (error) {
    if (isDesktopFeatureDisabledError(error)) {
      return fetchSourceFiles(sourceUrl);
    }
    throw error;
  }
  if (cachedManifest) {
    const manifest = await cachedManifest.json() as { fetchedAt: string; files: { path: string; key: string; contentType?: string | null }[] };
    const fetchedAt = Date.parse(manifest.fetchedAt);
    if (!Number.isNaN(fetchedAt) && now - fetchedAt < CACHE_TTL_MS) {
      const cachedFiles: AttachmentFile[] = [];
      let totalBytes = 0;
      for (const entry of manifest.files) {
        let object: R2ObjectBody | null = null;
        try {
          object = await env.DRIVE_CACHE.get(entry.key);
        } catch (error) {
          if (isDesktopFeatureDisabledError(error)) {
            return fetchSourceFiles(sourceUrl);
          }
          throw error;
        }
        if (!object) continue;
        if (typeof object.size === "number" && object.size > MAX_ATTACHMENT_BYTES) {
          throw new AttachmentError("E79811: Attachment file too large");
        }
        cachedFiles.push({
          path: entry.path,
          data: await object.arrayBuffer(),
          contentType: entry.contentType ?? null,
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
  const manifestFiles: { path: string; key: string; contentType?: string | null }[] = [];
  if (env.DRIVE_CACHE) {
    for (const file of fetchedFiles) {
      const fileKey = `${CACHE_PREFIX}/${hash}/files/${file.path}`;
      try {
        await env.DRIVE_CACHE.put(fileKey, file.data, {
          httpMetadata: file.contentType ? { contentType: file.contentType } : undefined,
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
        fetchedAt: new Date().toISOString(),
        files: manifestFiles,
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

async function fetchSourceFiles(sourceUrl: string): Promise<AttachmentFile[]> {
  const parsed = parseGitHubUrl(sourceUrl);
  if (parsed && parsed.type === "tree") {
    return fetchGitHubTreeFiles(parsed.owner, parsed.repo, parsed.ref, parsed.path);
  }
  if (parsed && (parsed.type === "raw" || parsed.type === "blob")) {
    const rawUrl = parsed.type === "raw"
      ? sourceUrl
      : `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${parsed.ref}/${parsed.path}`;
    return fetchSingleFile(rawUrl, basename(parsed.path));
  }
  throw new AttachmentError("E79809: Unsupported attachment source (only GitHub URLs are allowed)");
}

async function fetchGitHubTreeFiles(owner: string, repo: string, ref: string, basePath: string): Promise<AttachmentFile[]> {
  const files = await listGitHubDirectory(owner, repo, ref, basePath);
  const result: AttachmentFile[] = [];
  let totalBytes = 0;
  for (const file of files) {
    const response = await fetchWithTimeout(file.downloadUrl, { headers: githubHeaders() });
    if (!response.ok) continue;
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
      contentType: response.headers.get("content-type"),
    });
  }
  return result;
}

async function listGitHubDirectory(
  owner: string,
  repo: string,
  ref: string,
  basePath: string
): Promise<{ relativePath: string; downloadUrl: string }[]> {
  const results: { relativePath: string; downloadUrl: string }[] = [];
  const queue: string[] = [basePath];

  while (queue.length > 0) {
    const current = queue.shift() || "";
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${current}?ref=${ref}`;
    const response = await fetchWithTimeout(url, { headers: githubHeaders() });
    if (!response.ok) {
      continue;
    }
    const data = await response.json() as Array<{ type: string; path: string; download_url?: string }>;
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

function parseGitHubUrl(sourceUrl: string): { type: "raw" | "blob" | "tree"; owner: string; repo: string; ref: string; path: string } | null {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (url.hostname === "raw.githubusercontent.com") {
    if (parts.length < 4) return null;
    const [owner, repo, ref, ...pathParts] = parts;
    return { type: "raw", owner, repo, ref, path: pathParts.join("/") };
  }
  if (url.hostname === "github.com") {
    if (parts.length < 4) return null;
    const [owner, repo, kind, ref, ...pathParts] = parts;
    if (kind === "tree" || kind === "blob") {
      return { type: kind, owner, repo, ref, path: pathParts.join("/") };
    }
  }
  return null;
}

async function fetchSingleFile(sourceUrl: string, fileName: string): Promise<AttachmentFile[]> {
  const response = await fetchWithTimeout(sourceUrl, { headers: githubHeaders() });
  if (!response.ok) return [];
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
    contentType: response.headers.get("content-type"),
  }];
}

async function putSandboxFile(
  env: Env,
  sandboxSessionId: string,
  machineId: string | undefined,
  path: string,
  file: AttachmentFile
): Promise<void> {
  const url = sandboxUrl(env, `/sessions/${sandboxSessionId}/file`);
  url.searchParams.set("path", path);
  await sandboxFetch(env, url.toString(), {
    method: "PUT",
    headers: {
      "Content-Type": file.contentType || "application/octet-stream",
    },
    body: file.data,
    machineId,
  });
}

async function deleteSandboxPath(
  env: Env,
  sandboxSessionId: string,
  machineId: string | undefined,
  path: string
): Promise<void> {
  const url = sandboxUrl(env, `/sessions/${sandboxSessionId}/file`);
  url.searchParams.set("path", path);
  await sandboxFetch(env, url.toString(), { method: "DELETE", machineId });
}

function githubHeaders(): Record<string, string> {
  return {
    "User-Agent": "Orcabot-ControlPlane",
    "Accept": "application/vnd.github+json",
  };
}

function trimPathPrefix(path: string, prefix: string): string {
  if (!prefix) return path;
  if (path.startsWith(prefix)) {
    return path.slice(prefix.length).replace(/^\/+/, "");
  }
  return path;
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || "file";
}

function extensionForPath(path: string): string {
  const index = path.lastIndexOf(".");
  if (index === -1) return ".md";
  return path.slice(index);
}

function validateAttachmentUrl(sourceUrl: string): void {
  let url: URL;
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

async function fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new AttachmentError("E79810: Attachment fetch timed out", 408);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function sha256(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
