// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Env } from "../types";
import { isDesktopFeatureDisabledError } from "../storage/drive-cache";

type AttachmentSpec = {
  name: string;
  sourceUrl?: string;
  content?: string;
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
};

type AttachmentFile = {
  path: string;
  data: ArrayBuffer;
  contentType?: string | null;
};

const CACHE_PREFIX = "attachments-cache";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const TERMINAL_PATHS: Record<string, { skills: string | null; agents: string | null }> = {
  claude: { skills: "/.claude/skills", agents: "/.claude/agents" },
  gemini: { skills: "/.gemini/skills", agents: null },
  codex: { skills: "/.codex/skills", agents: null },
  opencode: { skills: "/.config/opencode/skills", agents: "/.config/opencode/agents" },
  copilot: { skills: "/.copilot/skills", agents: null },
  droid: { skills: "/.factory/skills", agents: "/.factory/droids" },
};

export async function attachSessionResources(
  env: Env,
  userId: string,
  sessionId: string,
  data: AttachmentRequest
): Promise<Response> {
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

  return Response.json({ ok: true });
}

async function resolveAttachmentFiles(env: Env, attachment: AttachmentSpec): Promise<AttachmentFile[]> {
  if (attachment.sourceUrl) {
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
        cachedFiles.push({
          path: entry.path,
          data: await object.arrayBuffer(),
          contentType: entry.contentType ?? null,
        });
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
  return fetchSingleFile(sourceUrl, basename(new URL(sourceUrl).pathname));
}

async function fetchGitHubTreeFiles(owner: string, repo: string, ref: string, basePath: string): Promise<AttachmentFile[]> {
  const files = await listGitHubDirectory(owner, repo, ref, basePath);
  const result: AttachmentFile[] = [];
  for (const file of files) {
    const response = await fetch(file.downloadUrl, { headers: githubHeaders() });
    if (!response.ok) continue;
    const data = await response.arrayBuffer();
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
    const response = await fetch(url, { headers: githubHeaders() });
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
  const response = await fetch(sourceUrl, { headers: githubHeaders() });
  if (!response.ok) return [];
  const data = await response.arrayBuffer();
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
  const url = new URL(`${env.SANDBOX_URL.replace(/\/$/, "")}/sessions/${sandboxSessionId}/file`);
  url.searchParams.set("path", path);
  const headers = new Headers({
    "X-Internal-Token": env.SANDBOX_INTERNAL_TOKEN,
    "Content-Type": file.contentType || "application/octet-stream",
  });
  if (machineId) {
    headers.set("X-Sandbox-Machine-ID", machineId);
  }
  await fetch(url.toString(), {
    method: "PUT",
    headers,
    body: file.data,
  });
}

async function deleteSandboxPath(
  env: Env,
  sandboxSessionId: string,
  machineId: string | undefined,
  path: string
): Promise<void> {
  const url = new URL(`${env.SANDBOX_URL.replace(/\/$/, "")}/sessions/${sandboxSessionId}/file`);
  url.searchParams.set("path", path);
  const headers = new Headers({
    "X-Internal-Token": env.SANDBOX_INTERNAL_TOKEN,
  });
  if (machineId) {
    headers.set("X-Sandbox-Machine-ID", machineId);
  }
  await fetch(url.toString(), { method: "DELETE", headers });
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

async function sha256(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
