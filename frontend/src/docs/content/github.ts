// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const githubDoc: DocEntry = {
  title: "GitHub Integration",
  slug: "github",
  category: "workspace",
  icon: "github",
  summary: "Clone repos into your workspace and give AI agents access to browse code, manage issues, and review PRs.",
  quickHelp: [
    "Connect GitHub via the workspace sidebar (GitHub icon) or the integrations panel inside a terminal.",
    "Authorize with GitHub OAuth  - choose which repos to grant access to.",
    "To clone a repo: use the workspace sidebar GitHub button, then pick a repo to import into /workspace.",
    "To give an agent GitHub tools: open a terminal's integrations panel and attach GitHub (auto-attaches to all terminals).",
    "Set a policy when attaching  - choose read-only, or enable high-risk actions (push, merge PRs, etc.).",
  ],
  tags: ["github", "git", "code", "repos", "issues", "pull requests", "oauth", "workspace", "clone"],
  body: `## Two Ways to Use GitHub

GitHub works differently from other integrations  - there's no GitHub block on the canvas. Instead, GitHub is accessed in two ways:

### 1. Workspace Sync (Clone Repos)
Use the **GitHub icon in the workspace sidebar** to connect and clone repositories into your \`/workspace\` directory.

- Click the GitHub icon in the sidebar toolbar.
- Authorize with GitHub OAuth if not already connected.
- Pick a repository from the list  - click **Import** to clone it.
- The repo files appear in your workspace file tree.

### 2. Agent Tool Access (Browse, Issues, PRs)
Use the **integrations panel inside a terminal** to attach GitHub as an MCP tool for your AI agent.

- Click the integrations icon in any terminal block header.
- Find GitHub in the "Available to Attach" list.
- Click **Connect** (if not yet authorized) or **Attach**.
- Choose access level: **Read Only** or **Full Access**.
- GitHub tools are automatically available to the agent in that terminal.

**Note:** When GitHub is attached via workspace sync, it auto-attaches to all active terminals on the dashboard.

## What You Need

**A GitHub Account**  - any GitHub account works. Authorization uses GitHub's standard OAuth flow. No API keys or developer accounts needed.

## Access Levels

When attaching GitHub to a terminal, you can control what the agent can do:

### Read Only (Default)
- Browse repositories and view files
- Search code across repos
- List issues and pull requests
- View PR reviews and comments

### Full Access (High-Risk Actions)
Additional capabilities that require explicit opt-in:
- **Push to repos**  - commit and push code changes
- **Merge PRs**  - merge pull requests
- **Approve PRs**  - approve pull request reviews
- **Delete repos**  - permanently delete repositories

Each high-risk action has its own checkbox  - you can enable push without enabling delete, for example.

## What Your Agent Can Do

- **Browse repos**  - list repositories, view files and directories
- **Search code**  - find code across repos by keyword or pattern
- **Read files**  - view file contents at any ref/branch
- **List issues**  - browse open/closed issues with filters
- **Create issues**  - open new issues with title, body, labels
- **List PRs**  - view pull requests and their status
- **Comment**  - add comments to issues and PRs

## Security

- Your GitHub OAuth token **never leaves the control plane**  - the agent never sees it.
- All API calls are made server-side through the policy gateway.
- Repository access can be restricted at both the GitHub level (during OAuth) and the Orcabot policy level.
- High-risk actions (push, merge, delete) require explicit opt-in per terminal.

## Troubleshooting

### Agent Can't See GitHub Tools
- Open the terminal's integrations panel and check that GitHub is attached.
- If you only connected via workspace sidebar, GitHub tools may need to be explicitly attached.

### Agent Can't See a Specific Repo
- Check that you authorized Orcabot to access that repo during GitHub OAuth setup.
- Check the policy on the attachment  - it may have a repo filter.
- Update repo access at GitHub Settings → Applications → Orcabot.

### Repo Not Appearing in Workspace
- Make sure you clicked **Import** on the repo in the workspace sidebar picker.
- Check the workspace file tree  - the repo clones into \`/workspace\`.

### "Rate Limited"
- GitHub's API has rate limits (5,000 requests/hour for authenticated users).
- If you're hitting limits, consider reducing the agent's search scope.`,
};
