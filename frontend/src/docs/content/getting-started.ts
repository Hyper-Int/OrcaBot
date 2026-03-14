// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const gettingStartedDoc: DocEntry = {
  title: "Getting Started with Orcabot",
  slug: "getting-started",
  category: "getting-started",
  icon: "rocket",
  summary: "Create your first dashboard, start an AI agent, and begin coding in minutes.",
  quickHelp: [
    "Sign in with Google (or use dev mode for local development).",
    "Create a new dashboard  - this is your collaborative workspace.",
    "Add a terminal block and choose an AI agent (Claude, Gemini, or Codex).",
    "Add your API key in the Secrets panel  - it's encrypted and broker-protected.",
    "Start chatting with your AI agent to build, debug, and deploy code.",
  ],
  tags: ["getting started", "quickstart", "onboarding", "first steps", "setup"],
  body: `## What is Orcabot?

Orcabot is a **sandboxed, multiplayer AI coding platform**. Think Figma + terminals:
- **Dashboards** are collaborative workspaces you share with your team.
- **Terminals** run AI coding agents (Claude, Gemini, Codex) in isolated VMs.
- **Integrations** connect your tools (Gmail, GitHub, Calendar) to your agents.
- **Secrets** are broker-protected  - AI agents can use your API keys without seeing them.

## Quick Start

### 1. Create a Dashboard
After signing in, click **New Dashboard**. Name it after your project. This is your persistent workspace  - it saves automatically and supports real-time collaboration.

### 2. Add a Terminal
Click the **+** button on the canvas and select **Terminal**. Choose:
- **Claude Code**  - best for complex coding tasks
- **Gemini CLI**  - fast and efficient for quick tasks
- **Codex**  - OpenAI's coding agent
- **Shell**  - plain terminal for manual commands

### 3. Add Your API Key
When you create an agent terminal, you'll need the matching API key:
- Claude → \`ANTHROPIC_API_KEY\` (from console.anthropic.com)
- Gemini → \`GEMINI_API_KEY\` (from aistudio.google.com)
- Codex → \`OPENAI_API_KEY\` (from platform.openai.com)

Click the **key icon** in the terminal header to open the Secrets panel. Add your key there  - it's encrypted and protected by the secrets broker.

### 4. Start Coding
Your AI agent is ready. Type a prompt in the terminal and watch it work. You can:
- Ask it to build features, fix bugs, write tests
- Give it access to your GitHub repos, Gmail, Calendar
- Watch it browse the web and test code in a built-in Chromium browser

### 5. Collaborate
Share your dashboard URL with teammates. Everyone can:
- View terminals in real time
- Take turns typing
- Add notes, todos, and links to the board
- Wire up their own integrations

## Key Concepts

### Dashboards Are Documents
Dashboards persist like Google Docs. They save automatically. You can close the browser and come back  - everything is still there.

### Sandboxes Are Temporary
The VM running your terminal is temporary. If it stops (timeout, crash), a new one boots automatically. Your workspace files are preserved.

### Secrets Are Protected
API keys never appear in terminal output. The secrets broker injects them server-side, so even a compromised AI agent can't exfiltrate your keys.`,
};
