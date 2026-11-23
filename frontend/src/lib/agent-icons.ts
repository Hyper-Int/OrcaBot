// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: agent-icons-v2-detect-from-script
const MODULE_REVISION = "agent-icons-v2-detect-from-script";
console.log(`[agent-icons] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Shared utility for agent type detection and icon mapping.
 * Used by both TerminalBlock and WorkspaceSidebar.
 */

export type AgentType =
  | "claude"
  | "gemini"
  | "codex"
  | "opencode"
  | "droid"
  | "moltbot"
  | "shell";

const BOOT_COMMAND_MAP: Record<string, AgentType> = {
  claude: "claude",
  gemini: "gemini",
  codex: "codex",
  opencode: "opencode",
  droid: "droid",
  openclaw: "moltbot",
  moltbot: "moltbot",
};

const NAME_MAP: Record<string, AgentType> = {
  "Claude Code": "claude",
  "Gemini CLI": "gemini",
  Codex: "codex",
  OpenCode: "opencode",
  Droid: "droid",
  OpenClaw: "moltbot",
  Moltbot: "moltbot",
};

/**
 * The agent a boot command runs: the whole command ("codex"), else the first agent a
 * non-comment line runs (a script such as PokerBench's seats: `... exec codex -m x`,
 * `/usr/bin/claude`). Then the terminal's name, exactly or as a prefix ("Codex 2"), so a
 * renamed terminal keeps its agent type. REVISION: agent-icons-v2-detect-from-script
 */
export function getAgentType(
  bootCommand?: string,
  name?: string
): AgentType {
  if (bootCommand && BOOT_COMMAND_MAP[bootCommand]) {
    return BOOT_COMMAND_MAP[bootCommand];
  }
  const fromScript = bootCommand ? agentInScript(bootCommand) : null;
  if (fromScript) return fromScript;
  if (name) {
    if (NAME_MAP[name]) return NAME_MAP[name];
    const prefix = Object.keys(NAME_MAP).find((n) => name.startsWith(n + " ") || name.startsWith(n + "-") || name.startsWith(n + "("));
    if (prefix) return NAME_MAP[prefix];
  }
  return "shell";
}

function agentInScript(script: string): AgentType | null {
  for (const raw of script.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    for (const token of line.split(/[\s;&|()`]+/)) {
      const word = token.split("/").pop() ?? "";
      if (Object.prototype.hasOwnProperty.call(BOOT_COMMAND_MAP, word)) return BOOT_COMMAND_MAP[word];
    }
  }
  return null;
}

const ICON_SRC_MAP: Record<AgentType, string | null> = {
  claude: "/icons/claude.ico",
  gemini: "/icons/gemini.ico",
  codex: "/icons/codex.png",
  opencode: "/icons/opencode.ico",
  droid: "/icons/droid.png",
  moltbot: "/icons/moltbot.png",
  shell: null,
};

/** Returns the icon src path for the agent type, or null for plain terminal. */
export function getAgentIconSrc(agentType: AgentType): string | null {
  return ICON_SRC_MAP[agentType];
}

const DISPLAY_NAME_MAP: Record<AgentType, string> = {
  claude: "Claude Code",
  gemini: "Gemini CLI",
  codex: "Codex",
  opencode: "OpenCode",
  droid: "Droid",
  moltbot: "OpenClaw",
  shell: "Terminal",
};

export function getAgentDisplayName(agentType: AgentType): string {
  return DISPLAY_NAME_MAP[agentType];
}
