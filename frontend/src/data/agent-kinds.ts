// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: agent-block-v1-link-chat-seat

const MODULE_REVISION = "agent-block-v1-link-chat-seat";
console.log(`[agent-kinds] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * The outside agents an Agent block can link, and how to set each one up.
 *
 * Every agent runs on its own computer and connects to Orcabot's agent hub with a
 * small connector. Its setup step prints an 8-character pairing code, which the user
 * types into the Agent block. `{hub}` is replaced with the hub's URL.
 */

export interface AgentKind {
  id: string;
  title: string;
  /** Where it runs and how quickly it answers. */
  where: string;
  intro: string;
  /** What the user pastes into the agent (or runs). */
  setup: string;
}

const guide = "{hub}/agents/setup.md";

export const AGENT_KINDS: AgentKind[] = [
  {
    id: "grok",
    title: "Grok Bot",
    where: "xAI · runs on its own cloud computer, answers within seconds",
    intro: "Paste this into your Grok Bot:",
    setup:
      `Please connect yourself to my Orcabot workspace as my agent, following ${guide} with --server {hub} --name grok --state ~/.orca-agent-grok. ` +
      "Verify the SHA-256 before running anything. When the pair step prints an 8-character pairing code (like ABCD-EFGH), send me the code. " +
      "Then, instead of polling, keep the connector running in the background so you answer quickly: --server {hub} --state ~/.orca-agent-grok " +
      "--listen 127.0.0.1:18790 --webhook <your routine's webhook URL> --webhook-header '<header name>: <sender key>', restart it after your " +
      "computer resets, and use `siren-agent-bridge --attach --state ~/.orca-agent-grok` as your MCP server.",
  },
  {
    id: "muse",
    title: "Muse",
    where: "Meta · runs on its own computer, checks every minute",
    intro: "Paste this into Muse:",
    setup:
      `Please connect yourself to my Orcabot workspace as my agent, following the documentation at ${guide} with --server {hub} --name muse ` +
      "--state ~/.orca-agent-muse. Verify the SHA-256 before running anything. When the pair step prints an 8-character pairing code (like " +
      "ABCD-EFGH), send me the code. Then schedule the --poll check every minute, and add the connector as a local stdio MCP server.",
  },
  {
    id: "dots",
    title: "Dots",
    where: "OpenAI · runs on its own computer, listens in 10-minute runs",
    intro: "Paste this into Dots:",
    setup:
      `Please connect yourself to my Orcabot workspace as my agent, following the documentation at ${guide} with --server {hub} --name dots ` +
      "--state ~/.orca-agent-dots. Verify the SHA-256 before running anything. Your computer may not keep files, so follow \"If your computer " +
      "doesn't keep files\": pair with --pair --backup, send me the 8-character pairing code it prints, and keep the restore key (srk_…) in your " +
      "routine's instructions. Then set up a scheduled routine every 10 minutes that reinstalls the connector if it's missing, then keeps " +
      "listening for about 9 minutes: repeat --wait 240 with --restore-key, and each time it exits 0, handle each JSON line straight away. Use " +
      "the --call commands (with the same --restore-key) for tools: send_message to reply in a chat.",
  },
  {
    id: "claude",
    title: "Claude Code",
    where: "Anthropic · on your own computer, while Claude Code is open",
    intro: "On your computer, in a terminal:",
    setup:
      "siren-agent-bridge --pair --server {hub} --name claude --state ~/.orca-agent-claude\n" +
      "claude mcp add orcabot-agent -- siren-agent-bridge --stdio --server {hub} --state ~/.orca-agent-claude\n\n" +
      "The first command prints a pairing code. Install the connector first: " + guide,
  },
  {
    id: "codex",
    title: "Codex",
    where: "OpenAI · on your own computer, while Codex is open",
    intro: "On your computer, in a terminal:",
    setup:
      "siren-agent-bridge --pair --server {hub} --name codex --state ~/.orca-agent-codex\n" +
      "codex mcp add orcabot-agent -- siren-agent-bridge --stdio --server {hub} --state ~/.orca-agent-codex\n\n" +
      "The first command prints a pairing code. Install the connector first: " + guide,
  },
  {
    id: "other",
    title: "Another agent",
    where: "Any agent that can run a program and keep it running",
    intro: "Give your agent these instructions:",
    setup:
      `Please connect yourself to my Orcabot workspace as my agent, following ${guide} with --server {hub} --name <a short name> ` +
      "--state ~/.orca-agent. Verify the SHA-256 before running anything. When the pair step prints an 8-character pairing code, send me the code.",
  },
];

export function agentKind(id: string | undefined): AgentKind {
  return AGENT_KINDS.find((k) => k.id === id) ?? AGENT_KINDS[0];
}

export function setupText(kind: AgentKind, hubUrl: string): string {
  return kind.setup.replaceAll("{hub}", hubUrl.replace(/\/+$/, ""));
}
