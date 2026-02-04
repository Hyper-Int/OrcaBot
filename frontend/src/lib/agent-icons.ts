// REVISION: workspace-sidebar-v1-agent-icons
const MODULE_REVISION = "workspace-sidebar-v1-agent-icons";
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

export function getAgentType(
  bootCommand?: string,
  name?: string
): AgentType {
  if (bootCommand && BOOT_COMMAND_MAP[bootCommand]) {
    return BOOT_COMMAND_MAP[bootCommand];
  }
  if (name && NAME_MAP[name]) {
    return NAME_MAP[name];
  }
  return "shell";
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
