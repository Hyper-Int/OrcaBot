// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const terminalsDoc: DocEntry = {
  title: "Terminals & AI Agents",
  slug: "terminals",
  category: "agents",
  icon: "terminal",
  summary: "Run AI coding agents (Claude, Gemini, Codex) or plain shells in sandboxed terminals.",
  quickHelp: [
    "Add a terminal block to your dashboard  - choose an AI agent or plain shell.",
    "The terminal boots a sandboxed VM with your chosen agent ready to go.",
    "Wire integration blocks (Gmail, GitHub, etc.) to give the agent access to external tools.",
    "Add secrets (API keys) via the Secrets panel so the agent can make API calls.",
    "Multiple users can view the same terminal  - only one can type at a time (turn-taking).",
  ],
  tags: ["terminal", "claude", "gemini", "codex", "shell", "agent", "sandbox", "vm"],
  body: `## Terminal Types

### AI Agent Terminals
- **Claude Code**  - Anthropic's coding agent. Requires \`ANTHROPIC_API_KEY\`.
- **Gemini CLI**  - Google's coding agent. Requires \`GEMINI_API_KEY\`.
- **Codex**  - OpenAI's coding agent. Requires \`OPENAI_API_KEY\`.

Each agent terminal boots with the agent pre-configured and ready to receive prompts.

### Plain Shell
A standard bash terminal in the sandbox. Useful for running commands, installing packages, or debugging.

## How Terminals Work

Each terminal runs inside a **sandboxed VM** (one VM per dashboard). The sandbox provides:
- Isolated filesystem at \`/workspace\`
- Pre-installed tools (git, node, python, etc.)
- Built-in Chromium browser for testing
- Network egress controls

## Turn-Taking

Multiple users can **view** a terminal simultaneously, but only one user or agent can **type** at a time:
- The current controller is shown in the terminal header.
- Click "Request Control" to take over typing.
- While an AI agent is running, human input is disabled.
- You can **stop** or **pause** a running agent at any time.

## Wiring Integrations

To give an agent access to external tools (Gmail, GitHub, etc.):
1. Add the integration block to your dashboard.
2. Connect it (OAuth or API key).
3. Draw a wire from the integration block to the terminal block.
4. The agent will see new MCP tools for that integration.

## Secrets & API Keys

- Open the **Secrets panel** (key icon in terminal header) to manage API keys.
- Broker-protected keys are injected server-side  - agents never see raw values.
- See the "Secrets & API Keys" help topic for details.

## Troubleshooting

### Terminal Won't Start
- The sandbox VM may be booting  - this can take 10-30 seconds on first use.
- If it stays stuck, try deleting the terminal block and creating a new one.

### Agent Says "API Key Missing"
- Check the Secrets panel for the required key.
- Make sure the key name matches (e.g., \`ANTHROPIC_API_KEY\` for Claude).

### Can't Type in Terminal
- Check if another user or agent has control. Look at the header for the current controller.
- Click "Request Control" to take over.`,
};
