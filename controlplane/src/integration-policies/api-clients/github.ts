// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: github-client-v1
console.log(`[github-client] REVISION: github-client-v1 loaded at ${new Date().toISOString()}`);

/**
 * GitHub API Client
 *
 * Executes GitHub API calls with OAuth access token.
 * Token never leaves the control plane.
 */

const GITHUB_API_BASE = 'https://api.github.com';

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  html_url: string;
  clone_url: string;
  owner: { login: string; avatar_url: string };
  default_branch: string;
}

interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  user: { login: string };
  labels: Array<{ name: string }>;
}

interface GitHubPR {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  user: { login: string };
  head: { ref: string; sha: string };
  base: { ref: string };
}

/**
 * Execute a GitHub action
 */
export async function executeGitHubAction(
  action: string,
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  switch (action) {
    case 'github.list_repos':
      return listRepos(args, accessToken);
    case 'github.get_repo':
      return getRepo(args, accessToken);
    case 'github.list_issues':
      return listIssues(args, accessToken);
    case 'github.create_issue':
      return createIssue(args, accessToken);
    case 'github.list_prs':
      return listPRs(args, accessToken);
    case 'github.create_pr':
      return createPR(args, accessToken);
    case 'github.get_file':
      return getFileContent(args, accessToken);
    case 'github.list_files':
      return listFiles(args, accessToken);
    case 'github.search_code':
      return searchCode(args, accessToken);
    default:
      throw new Error(`Unknown GitHub action: ${action}`);
  }
}

async function githubFetch(
  path: string,
  accessToken: string,
  options?: RequestInit
): Promise<Response> {
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API error: ${response.status} - ${error}`);
  }

  return response;
}

async function listRepos(
  args: Record<string, unknown>,
  accessToken: string
): Promise<GitHubRepo[]> {
  const type = args.type as string || 'all'; // all, owner, public, private, member
  const sort = args.sort as string || 'updated';
  const perPage = Math.min(args.perPage as number || 30, 100);

  const params = new URLSearchParams({
    type,
    sort,
    per_page: perPage.toString(),
  });

  const response = await githubFetch(`/user/repos?${params}`, accessToken);
  return response.json() as Promise<GitHubRepo[]>;
}

async function getRepo(
  args: Record<string, unknown>,
  accessToken: string
): Promise<GitHubRepo> {
  const owner = args.owner as string;
  const repo = args.repo as string;
  if (!owner || !repo) {
    throw new Error('owner and repo are required');
  }

  const response = await githubFetch(`/repos/${owner}/${repo}`, accessToken);
  return response.json() as Promise<GitHubRepo>;
}

async function listIssues(
  args: Record<string, unknown>,
  accessToken: string
): Promise<GitHubIssue[]> {
  const owner = args.owner as string;
  const repo = args.repo as string;
  if (!owner || !repo) {
    throw new Error('owner and repo are required');
  }

  const state = args.state as string || 'open';
  const perPage = Math.min(args.perPage as number || 30, 100);

  const params = new URLSearchParams({
    state,
    per_page: perPage.toString(),
  });

  const response = await githubFetch(`/repos/${owner}/${repo}/issues?${params}`, accessToken);
  return response.json() as Promise<GitHubIssue[]>;
}

async function createIssue(
  args: Record<string, unknown>,
  accessToken: string
): Promise<GitHubIssue> {
  const owner = args.owner as string;
  const repo = args.repo as string;
  const title = args.title as string;
  if (!owner || !repo || !title) {
    throw new Error('owner, repo, and title are required');
  }

  const body = args.body as string || '';
  const labels = args.labels as string[] || [];

  const response = await githubFetch(`/repos/${owner}/${repo}/issues`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, labels }),
  });

  return response.json() as Promise<GitHubIssue>;
}

async function listPRs(
  args: Record<string, unknown>,
  accessToken: string
): Promise<GitHubPR[]> {
  const owner = args.owner as string;
  const repo = args.repo as string;
  if (!owner || !repo) {
    throw new Error('owner and repo are required');
  }

  const state = args.state as string || 'open';
  const perPage = Math.min(args.perPage as number || 30, 100);

  const params = new URLSearchParams({
    state,
    per_page: perPage.toString(),
  });

  const response = await githubFetch(`/repos/${owner}/${repo}/pulls?${params}`, accessToken);
  return response.json() as Promise<GitHubPR[]>;
}

async function createPR(
  args: Record<string, unknown>,
  accessToken: string
): Promise<GitHubPR> {
  const owner = args.owner as string;
  const repo = args.repo as string;
  const title = args.title as string;
  const head = args.head as string;
  const base = args.base as string || 'main';
  if (!owner || !repo || !title || !head) {
    throw new Error('owner, repo, title, and head are required');
  }

  const body = args.body as string || '';
  const draft = args.draft as boolean || false;

  const response = await githubFetch(`/repos/${owner}/${repo}/pulls`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, head, base, draft }),
  });

  return response.json() as Promise<GitHubPR>;
}

async function getFileContent(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const owner = args.owner as string;
  const repo = args.repo as string;
  const path = args.path as string;
  if (!owner || !repo || !path) {
    throw new Error('owner, repo, and path are required');
  }

  const ref = args.ref as string || undefined;
  const params = ref ? `?ref=${encodeURIComponent(ref)}` : '';

  const response = await githubFetch(
    `/repos/${owner}/${repo}/contents/${path}${params}`,
    accessToken
  );

  return response.json();
}

async function listFiles(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const owner = args.owner as string;
  const repo = args.repo as string;
  const path = args.path as string || '';
  if (!owner || !repo) {
    throw new Error('owner and repo are required');
  }

  const ref = args.ref as string || undefined;
  const params = ref ? `?ref=${encodeURIComponent(ref)}` : '';

  const response = await githubFetch(
    `/repos/${owner}/${repo}/contents/${path}${params}`,
    accessToken
  );

  return response.json();
}

async function searchCode(
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  const query = args.query as string;
  if (!query) {
    throw new Error('query is required');
  }

  const owner = args.owner as string || undefined;
  const repo = args.repo as string || undefined;
  const perPage = Math.min(args.perPage as number || 30, 100);

  let q = query;
  if (owner && repo) {
    q += ` repo:${owner}/${repo}`;
  } else if (owner) {
    q += ` user:${owner}`;
  }

  const params = new URLSearchParams({
    q,
    per_page: perPage.toString(),
  });

  const response = await githubFetch(`/search/code?${params}`, accessToken);
  return response.json();
}
