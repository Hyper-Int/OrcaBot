// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: chat-v14-url-history-json

/**
 * Orcabot Chat Handler
 *
 * Provides a conversational interface for users to interact with Orcabot.
 * Orcabot uses MCP tools to control the platform (create dashboards, terminals, etc.)
 *
 * Endpoints:
 * - POST /chat/message - Send a message and get a streaming response
 * - GET /chat/history - Get conversation history
 * - DELETE /chat/history - Clear conversation history
 */

console.log(`[chat] REVISION: chat-v14-url-history-json loaded at ${new Date().toISOString()}`);

import type { Env, ChatMessage, ChatToolCall, ChatToolResult, ChatStreamEvent, AnyUIGuidanceCommand } from '../types';
import {
  streamChat,
  buildTextMessage,
  buildFunctionCallMessage,
  buildFunctionResponse,
  type GeminiMessage,
  type GeminiTool,
} from '../gemini/client';
import { UI_TOOLS, callTool as callUiTool } from '../mcp-ui/handler';
import * as dashboards from '../dashboards/handler';
import * as secrets from '../secrets/handler';
import * as integrationPolicies from '../integration-policies/handler';
import { SandboxClient } from '../sandbox/client';

// System prompt for Orcabot
const ORCABOT_SYSTEM_PROMPT = `You are Orcabot, the AI assistant for Orca — a sandboxed, multiplayer AI coding platform.

CRITICAL RESPONSE RULES:
- Be EXTREMELY brief. One sentence is ideal, two max.
- NEVER write more than one short paragraph.
- Skip pleasantries, greetings, and filler words.
- Just do the action and confirm in minimal words.
- Examples of good responses:
  - "Created dashboard 'My Project'."
  - "Terminal started with Claude."
  - "Gmail connected. Attach it to a terminal to use."

You can:
- Create dashboards, terminals, browsers, notes, todos
- Connect integrations (Gmail, GitHub, Slack, Discord, etc.)
- Control terminals and start AI agents (Claude, Gemini, Codex)
- Manage secrets
- Guide users with UI highlights and tooltips

TERMINAL CREATION RULES:
- To create a Claude Code terminal: use create_terminal with boot_command="claude", agentic=true, name="Claude Code"
- To create a Gemini CLI terminal: use create_terminal with boot_command="gemini", agentic=true, name="Gemini CLI"
- To create a Codex terminal: use create_terminal with boot_command="codex", agentic=true, name="Codex"
- To create a plain shell terminal: use create_terminal with no boot_command, agentic=false
- NEVER create a plain terminal and then use terminal_start_agent to start an agent. Always use boot_command on create_terminal instead.
- terminal_start_agent is only for starting agents in EXISTING terminals that are already open.

When working with dashboards, use dashboard_list first to find existing ones, or dashboard_create to make a new one.`;

// ============================================
// Tool Definitions
// ============================================

// Phase 2: Dashboard management tools
const DASHBOARD_TOOLS: GeminiTool[] = [
  {
    name: 'dashboard_list',
    description: 'List all dashboards owned by or shared with the user',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'dashboard_create',
    description: 'Create a new dashboard',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name for the new dashboard',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'dashboard_get',
    description: 'Get details of a specific dashboard including all its items',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The ID of the dashboard to get',
        },
      },
      required: ['dashboard_id'],
    },
  },
  {
    name: 'dashboard_rename',
    description: 'Rename a dashboard',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The ID of the dashboard to rename',
        },
        name: {
          type: 'string',
          description: 'The new name for the dashboard',
        },
      },
      required: ['dashboard_id', 'name'],
    },
  },
  {
    name: 'dashboard_delete',
    description: 'Delete a dashboard (only the owner can do this)',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The ID of the dashboard to delete',
        },
      },
      required: ['dashboard_id'],
    },
  },
];

// Phase 3: Integration management tools
const INTEGRATION_TOOLS: GeminiTool[] = [
  {
    name: 'integration_list_available',
    description: 'List all available integration providers (Gmail, GitHub, Slack, etc.)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'integration_list_connected',
    description: 'List all integrations the user has connected (OAuth authenticated)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'integration_get_connect_url',
    description: 'Get the OAuth URL to connect a new integration. User must visit this URL to authorize.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'The provider to connect (gmail, github, slack, discord, google_calendar, google_drive, etc.)',
        },
        dashboard_id: {
          type: 'string',
          description: 'The dashboard ID for context (optional)',
        },
      },
      required: ['provider'],
    },
  },
  {
    name: 'integration_list_terminal_attachments',
    description: 'List integrations attached to terminals in a dashboard',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The dashboard ID',
        },
      },
      required: ['dashboard_id'],
    },
  },
  {
    name: 'integration_attach',
    description: 'Attach an integration to a terminal. The integration must be connected first.',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The dashboard ID',
        },
        terminal_id: {
          type: 'string',
          description: 'The terminal (PTY) ID to attach to',
        },
        provider: {
          type: 'string',
          description: 'The provider to attach (gmail, github, slack, etc.)',
        },
        security_level: {
          type: 'string',
          description: 'Security level: "restricted" (read-only, default) or "full" (read+write). Use restricted unless the user explicitly asks for full access.',
          enum: ['restricted', 'full'],
        },
      },
      required: ['dashboard_id', 'terminal_id', 'provider'],
    },
  },
  {
    name: 'integration_detach',
    description: 'Detach an integration from a terminal',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The dashboard ID',
        },
        terminal_id: {
          type: 'string',
          description: 'The terminal (PTY) ID',
        },
        provider: {
          type: 'string',
          description: 'The provider to detach',
        },
      },
      required: ['dashboard_id', 'terminal_id', 'provider'],
    },
  },
];

// Phase 4: Terminal control tools
const TERMINAL_TOOLS: GeminiTool[] = [
  {
    name: 'terminal_send_input',
    description: 'Send text input to a terminal. Use this to run commands or type text.',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The dashboard ID containing the terminal',
        },
        terminal_item_id: {
          type: 'string',
          description: 'The terminal item ID (from dashboard items)',
        },
        input: {
          type: 'string',
          description: 'The text to send to the terminal',
        },
        press_enter: {
          type: 'boolean',
          description: 'Whether to press Enter after the input (default: true)',
        },
      },
      required: ['dashboard_id', 'terminal_item_id', 'input'],
    },
  },
  {
    name: 'terminal_start_agent',
    description: 'Start an AI coding agent in a terminal',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The dashboard ID',
        },
        terminal_item_id: {
          type: 'string',
          description: 'The terminal item ID',
        },
        agent: {
          type: 'string',
          description: 'The agent to start: claude, gemini, codex, or shell',
        },
      },
      required: ['dashboard_id', 'terminal_item_id', 'agent'],
    },
  },
  {
    name: 'terminal_get_sessions',
    description: 'Get all active terminal sessions for a dashboard',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The dashboard ID',
        },
      },
      required: ['dashboard_id'],
    },
  },
];

// Phase 5: Secrets management tools
const SECRETS_TOOLS: GeminiTool[] = [
  {
    name: 'secrets_list',
    description: 'List all secrets for a dashboard (names only, not values)',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The dashboard ID',
        },
      },
      required: ['dashboard_id'],
    },
  },
  {
    name: 'secrets_create',
    description: 'Create a new secret or environment variable',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The dashboard ID',
        },
        name: {
          type: 'string',
          description: 'The name of the secret (e.g., OPENAI_API_KEY)',
        },
        value: {
          type: 'string',
          description: 'The secret value',
        },
        description: {
          type: 'string',
          description: 'Optional description of what this secret is for',
        },
        type: {
          type: 'string',
          description: 'Type: secret (brokered, LLM cannot read) or env_var (regular environment variable)',
        },
      },
      required: ['dashboard_id', 'name', 'value'],
    },
  },
  {
    name: 'secrets_delete',
    description: 'Delete a secret',
    inputSchema: {
      type: 'object',
      properties: {
        secret_id: {
          type: 'string',
          description: 'The ID of the secret to delete',
        },
      },
      required: ['secret_id'],
    },
  },
];

// Phase 5: UI guidance tools (for onboarding)
const GUIDANCE_TOOLS: GeminiTool[] = [
  {
    name: 'ui_show_message',
    description: 'Show a message to the user in the chat (no action needed, just returns the message)',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message to display',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'ui_highlight',
    description: 'Highlight a UI element to draw the user\'s attention. Use for onboarding and guidance.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Element to highlight. Toolbar buttons: "claude-code", "gemini-cli", "codex", "terminal", "browser", "note", "todo". Dashboard items: "terminal-{id}", "browser-{id}". Panels: "integrations-panel", "files-sidebar"',
        },
        target_description: {
          type: 'string',
          description: 'Human-readable description of the target element for accessibility',
        },
        style: {
          type: 'string',
          description: 'Highlight style: pulse (default), glow, or ring',
        },
        duration: {
          type: 'number',
          description: 'Duration in milliseconds (default: 3000)',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'ui_tooltip',
    description: 'Show a tooltip near a UI element with helpful text. Great for explaining features.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Element to attach tooltip to: "claude-code", "gemini-cli", "codex", "terminal", "browser", "note", "terminal-{id}", "integrations-panel"',
        },
        text: {
          type: 'string',
          description: 'Text to show in the tooltip',
        },
        position: {
          type: 'string',
          description: 'Position relative to target: top, bottom, left, right (default: bottom)',
        },
        duration: {
          type: 'number',
          description: 'Auto-dismiss after milliseconds (default: 5000, 0 = manual dismiss)',
        },
      },
      required: ['target', 'text'],
    },
  },
  {
    name: 'ui_open_panel',
    description: 'Open a specific panel or sidebar in the UI',
    inputSchema: {
      type: 'object',
      properties: {
        panel: {
          type: 'string',
          description: 'Panel to open: "integrations", "settings", "files", "secrets", "chat"',
        },
      },
      required: ['panel'],
    },
  },
  {
    name: 'ui_scroll_to',
    description: 'Scroll the dashboard canvas to show a specific element',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Element to scroll to: "terminal-{id}", "browser-{id}", "note-{id}", or item ID',
        },
        behavior: {
          type: 'string',
          description: 'Scroll behavior: smooth (default) or instant',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'ui_dismiss_guidance',
    description: 'Dismiss active highlights and tooltips',
    inputSchema: {
      type: 'object',
      properties: {
        all: {
          type: 'boolean',
          description: 'Dismiss all guidance elements (default: true)',
        },
      },
    },
  },
];

// Convert MCP UI tools to Gemini format
function convertMcpToGeminiTools(mcpTools: typeof UI_TOOLS): GeminiTool[] {
  return mcpTools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as GeminiTool['inputSchema'],
  }));
}

// Get all available tools for Orcabot
function getOrcabotTools(): GeminiTool[] {
  return [
    ...DASHBOARD_TOOLS,
    ...INTEGRATION_TOOLS,
    ...TERMINAL_TOOLS,
    ...SECRETS_TOOLS,
    ...GUIDANCE_TOOLS,
    ...convertMcpToGeminiTools(UI_TOOLS),
  ];
}

// Generate unique IDs
function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

// ============================================
// Tool Execution
// ============================================

// Available integration providers
// Only list providers that have working OAuth connect URLs
const AVAILABLE_PROVIDERS = [
  { provider: 'gmail', name: 'Gmail', description: 'Read and send emails' },
  { provider: 'github', name: 'GitHub', description: 'Access repositories and issues' },
  { provider: 'google_calendar', name: 'Google Calendar', description: 'Manage calendar events' },
  { provider: 'google_drive', name: 'Google Drive', description: 'Access files and folders' },
  { provider: 'slack', name: 'Slack', description: 'Send and receive messages' },
  { provider: 'discord', name: 'Discord', description: 'Send and receive messages' },
];

// Map provider names to OAuth connect URLs
function getConnectUrl(env: Env, provider: string, dashboardId?: string, requestOrigin?: string): string | null {
  // OAuth connect endpoints are served by the control plane.
  // Prefer the request origin (most reliable), then OAUTH_REDIRECT_BASE, then CONTROLPLANE_URL.
  // FRONTEND_URL is intentionally NOT used — it points at a different origin where these routes don't exist.
  const base = requestOrigin || env.OAUTH_REDIRECT_BASE || (env as Record<string, unknown>).CONTROLPLANE_URL as string || '';

  // Guard: base must be an absolute URL, otherwise the connect link is unusable
  if (!base || !base.startsWith('http')) {
    console.warn('[chat] getConnectUrl: no valid base URL configured (request origin / OAUTH_REDIRECT_BASE / CONTROLPLANE_URL)');
    return null;
  }

  const providerMap: Record<string, string> = {
    gmail: '/integrations/google/gmail/connect',
    github: '/integrations/github/connect',
    google_calendar: '/integrations/google/calendar/connect',
    google_drive: '/integrations/google/drive/connect',
    google_contacts: '/integrations/google/contacts/connect',
    google_sheets: '/integrations/google/sheets/connect',
    google_forms: '/integrations/google/forms/connect',
    slack: '/integrations/slack/connect',
    discord: '/integrations/discord/connect',
  };

  const path = providerMap[provider];
  if (!path) return null;

  let url = `${base}${path}`;
  if (dashboardId) {
    url += `?dashboard_id=${dashboardId}`;
  }
  return url;
}

// Agent command mapping
const AGENT_COMMANDS: Record<string, string> = {
  claude: 'claude',
  gemini: 'gemini',
  codex: 'codex',
  shell: 'bash',
};

/**
 * Execute a tool call and return the result
 */
async function executeTool(
  env: Env,
  userId: string,
  toolName: string,
  args: Record<string, unknown>,
  requestOrigin?: string
): Promise<{ result: Record<string, unknown>; isError: boolean }> {
  try {
    // ==========================================
    // Phase 2: Dashboard Management Tools
    // ==========================================

    if (toolName === 'dashboard_list') {
      const response = await dashboards.listDashbоards(env, userId);
      const data = await response.json();
      return { result: data as Record<string, unknown>, isError: !response.ok };
    }

    if (toolName === 'dashboard_create') {
      const response = await dashboards.createDashbоard(env, userId, {
        name: args.name as string,
      });
      const data = await response.json();
      return { result: data as Record<string, unknown>, isError: !response.ok };
    }

    if (toolName === 'dashboard_get') {
      const response = await dashboards.getDashbоard(env, args.dashboard_id as string, userId);
      const data = await response.json();
      return { result: data as Record<string, unknown>, isError: !response.ok };
    }

    if (toolName === 'dashboard_rename') {
      const response = await dashboards.updateDashbоard(
        env,
        args.dashboard_id as string,
        userId,
        { name: args.name as string }
      );
      const data = await response.json();
      return { result: data as Record<string, unknown>, isError: !response.ok };
    }

    if (toolName === 'dashboard_delete') {
      const response = await dashboards.deleteDashbоard(env, args.dashboard_id as string, userId);
      if (response.status === 204) {
        return { result: { success: true, message: 'Dashboard deleted' }, isError: false };
      }
      const data = await response.json();
      return { result: data as Record<string, unknown>, isError: !response.ok };
    }

    // ==========================================
    // Phase 3: Integration Management Tools
    // ==========================================

    if (toolName === 'integration_list_available') {
      return {
        result: {
          providers: AVAILABLE_PROVIDERS,
          message: 'Use integration_get_connect_url to get the OAuth URL for a provider',
        },
        isError: false,
      };
    }

    if (toolName === 'integration_list_connected') {
      // Query user_integrations directly to list all OAuth connections for the user
      const result = await env.DB.prepare(`
        SELECT id, provider, metadata, created_at
        FROM user_integrations
        WHERE user_id = ?
        ORDER BY created_at DESC
      `).bind(userId).all<{
        id: string;
        provider: string;
        metadata: string | null;
        created_at: string;
      }>();

      const integrations = result.results.map(row => {
        let meta: Record<string, unknown> = {};
        try {
          meta = row.metadata ? JSON.parse(row.metadata) : {};
        } catch {
          console.warn(`[chat] Malformed metadata JSON in integration ${row.id}, skipping`);
        }
        return {
          id: row.id,
          provider: row.provider,
          accountEmail: meta.email || meta.login || null,
          accountLabel: meta.name || null,
          connectedAt: row.created_at,
        };
      });

      return {
        result: {
          integrations,
          count: integrations.length,
          message: 'Use integration_attach to attach a connected integration to a terminal',
        },
        isError: false,
      };
    }

    if (toolName === 'integration_get_connect_url') {
      const provider = args.provider as string;
      const dashboardId = args.dashboard_id as string | undefined;
      const url = getConnectUrl(env, provider, dashboardId, requestOrigin);

      if (!url) {
        const knownProviders = AVAILABLE_PROVIDERS.map(p => p.provider);
        const errorMsg = knownProviders.includes(provider)
          ? `Cannot generate connect URL for ${provider}: server base URL is not configured (OAUTH_REDIRECT_BASE).`
          : `Unknown provider: ${provider}. Available: ${knownProviders.join(', ')}`;
        return {
          result: { error: errorMsg },
          isError: true,
        };
      }

      return {
        result: {
          provider,
          connect_url: url,
          message: `To connect ${provider}, the user must visit this URL and complete OAuth authorization`,
        },
        isError: false,
      };
    }

    if (toolName === 'integration_list_terminal_attachments') {
      const response = await integrationPolicies.listDashboardIntegrationLabels(
        env,
        args.dashboard_id as string,
        userId
      );
      const data = await response.json();
      return { result: data as Record<string, unknown>, isError: !response.ok };
    }

    if (toolName === 'integration_attach') {
      const securityLevel = (args.security_level as string) || 'restricted';
      const provider = args.provider as string;
      const dashboardId = args.dashboard_id as string;
      const terminalId = args.terminal_id as string;

      // Create the appropriate policy based on security level
      let policy;
      if (securityLevel === 'full') {
        policy = integrationPolicies.createDefaultFullAccessPolicy(provider as any);
      } else {
        policy = integrationPolicies.createReadOnlyPolicy(provider as any);
      }

      // Look up the user's OAuth integration for this provider
      const userIntegration = await env.DB.prepare(`
        SELECT id FROM user_integrations
        WHERE user_id = ? AND provider = ?
        ORDER BY created_at DESC LIMIT 1
      `).bind(userId, provider).first<{ id: string }>();

      if (!userIntegration && provider !== 'browser') {
        return {
          result: {
            error: `No ${provider} connection found. The user needs to connect ${provider} first using integration_get_connect_url.`,
          },
          isError: true,
        };
      }

      const response = await integrationPolicies.attachIntegration(
        env,
        dashboardId,
        terminalId,
        userId,
        {
          provider: provider as any,
          userIntegrationId: userIntegration?.id,
          policy,
        }
      );
      const data = await response.json();
      return { result: data as Record<string, unknown>, isError: !response.ok };
    }

    if (toolName === 'integration_detach') {
      const response = await integrationPolicies.detachIntegration(
        env,
        args.dashboard_id as string,
        args.terminal_id as string,
        args.provider as any,
        userId
      );
      if (response.status === 204) {
        return { result: { success: true, message: 'Integration detached' }, isError: false };
      }
      const data = await response.json();
      return { result: data as Record<string, unknown>, isError: !response.ok };
    }

    // ==========================================
    // Phase 4: Terminal Control Tools
    // ==========================================

    if (toolName === 'terminal_send_input') {
      const dashboardId = args.dashboard_id as string;
      const terminalItemId = args.terminal_item_id as string;
      const input = args.input as string;
      const pressEnter = args.press_enter !== false;

      // Verify user has access to the dashboard
      const access = await env.DB.prepare(`
        SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?
      `).bind(dashboardId, userId).first<{ role: string }>();

      if (!access) {
        return {
          result: { error: 'Access denied. User does not have access to this dashboard.' },
          isError: true,
        };
      }

      // Get the session for this terminal
      const sessionRow = await env.DB.prepare(`
        SELECT s.*, ds.sandbox_session_id as dashboard_sandbox_session_id, ds.sandbox_machine_id as dashboard_sandbox_machine_id
        FROM sessions s
        JOIN dashboard_sandboxes ds ON s.dashboard_id = ds.dashboard_id
        WHERE s.item_id = ? AND s.dashboard_id = ? AND s.status = 'active'
        ORDER BY s.created_at DESC LIMIT 1
      `).bind(terminalItemId, dashboardId).first<{
        sandbox_session_id: string;
        pty_id: string;
        sandbox_machine_id: string;
        dashboard_sandbox_session_id: string;
        dashboard_sandbox_machine_id: string;
      }>();

      if (!sessionRow) {
        return {
          result: { error: 'No active session found for this terminal. The terminal may need to be opened first.' },
          isError: true,
        };
      }

      // Send input to the PTY
      const client = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
      const textToSend = pressEnter ? `${input}\n` : input;

      await client.writePty(
        sessionRow.dashboard_sandbox_session_id,
        sessionRow.pty_id,
        textToSend,
        sessionRow.dashboard_sandbox_machine_id
      );

      return {
        result: {
          success: true,
          message: 'Input sent to terminal.',
          terminal_item_id: terminalItemId,
        },
        isError: false,
      };
    }

    if (toolName === 'terminal_start_agent') {
      const dashboardId = args.dashboard_id as string;
      const terminalItemId = args.terminal_item_id as string;
      const agent = args.agent as string;

      const command = AGENT_COMMANDS[agent];
      if (!command) {
        return {
          result: { error: `Unknown agent: ${agent}. Available: ${Object.keys(AGENT_COMMANDS).join(', ')}` },
          isError: true,
        };
      }

      // Verify user has access to the dashboard
      const access = await env.DB.prepare(`
        SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?
      `).bind(dashboardId, userId).first<{ role: string }>();

      if (!access) {
        return {
          result: { error: 'Access denied. User does not have access to this dashboard.' },
          isError: true,
        };
      }

      // Get the session for this terminal
      const sessionRow = await env.DB.prepare(`
        SELECT s.*, ds.sandbox_session_id as dashboard_sandbox_session_id, ds.sandbox_machine_id as dashboard_sandbox_machine_id
        FROM sessions s
        JOIN dashboard_sandboxes ds ON s.dashboard_id = ds.dashboard_id
        WHERE s.item_id = ? AND s.dashboard_id = ? AND s.status = 'active'
        ORDER BY s.created_at DESC LIMIT 1
      `).bind(terminalItemId, dashboardId).first<{
        sandbox_session_id: string;
        pty_id: string;
        dashboard_sandbox_session_id: string;
        dashboard_sandbox_machine_id: string;
      }>();

      if (!sessionRow) {
        return {
          result: { error: 'No active session found for this terminal. The terminal may need to be opened first.' },
          isError: true,
        };
      }

      // Send the agent command
      const client = new SandboxClient(env.SANDBOX_URL, env.SANDBOX_INTERNAL_TOKEN);
      await client.writePty(
        sessionRow.dashboard_sandbox_session_id,
        sessionRow.pty_id,
        `${command}\n`,
        sessionRow.dashboard_sandbox_machine_id
      );

      return {
        result: {
          success: true,
          message: `Started ${agent} agent in terminal`,
          command,
          terminal_item_id: terminalItemId,
        },
        isError: false,
      };
    }

    if (toolName === 'terminal_get_sessions') {
      const dashboardId = args.dashboard_id as string;

      // Verify user has access to the dashboard
      const access = await env.DB.prepare(`
        SELECT role FROM dashboard_members WHERE dashboard_id = ? AND user_id = ?
      `).bind(dashboardId, userId).first<{ role: string }>();

      if (!access) {
        return {
          result: { error: 'Access denied. User does not have access to this dashboard.' },
          isError: true,
        };
      }

      const result = await env.DB.prepare(`
        SELECT s.id, s.item_id, s.pty_id, s.status, s.created_at,
               di.content as terminal_name
        FROM sessions s
        LEFT JOIN dashboard_items di ON s.item_id = di.id
        WHERE s.dashboard_id = ? AND s.status = 'active'
        ORDER BY s.created_at DESC
      `).bind(dashboardId).all<{
        id: string;
        item_id: string;
        pty_id: string;
        status: string;
        created_at: string;
        terminal_name: string | null;
      }>();

      const sessions = result.results.map(row => {
        let name = 'Terminal';
        if (row.terminal_name) {
          try {
            const parsed = JSON.parse(row.terminal_name);
            name = parsed.name || 'Terminal';
          } catch {
            name = row.terminal_name;
          }
        }
        return {
        sessionId: row.id,
        terminalItemId: row.item_id,
        ptyId: row.pty_id,
        status: row.status,
        name,
        createdAt: row.created_at,
        };
      });

      return {
        result: { sessions, count: sessions.length },
        isError: false,
      };
    }

    // ==========================================
    // Phase 5: Secrets Management Tools
    // ==========================================

    if (toolName === 'secrets_list') {
      const dashboardId = args.dashboard_id as string;
      const response = await secrets.listSecrets(env, userId, dashboardId);
      const data = await response.json();

      // Remove actual values for security
      if (data && typeof data === 'object' && 'secrets' in data) {
        const secretsList = (data as { secrets: Array<{ name: string; description: string; type: string; id: string }> }).secrets;
        return {
          result: {
            secrets: secretsList.map(s => ({
              id: s.id,
              name: s.name,
              description: s.description,
              type: s.type,
            })),
          },
          isError: false,
        };
      }

      return { result: data as Record<string, unknown>, isError: !response.ok };
    }

    if (toolName === 'secrets_create') {
      const response = await secrets.createSecret(env, userId, {
        dashboardId: args.dashboard_id as string,
        name: args.name as string,
        value: args.value as string,
        description: (args.description as string) || '',
        type: (args.type as 'secret' | 'env_var') || 'secret',
        brokerProtected: true,
      });
      const data = await response.json();

      // Don't return the actual value
      if (data && typeof data === 'object' && 'secret' in data) {
        const secret = (data as { secret: { id: string; name: string } }).secret;
        return {
          result: {
            success: true,
            secret: { id: secret.id, name: secret.name },
            message: 'Secret created successfully',
          },
          isError: false,
        };
      }

      return { result: data as Record<string, unknown>, isError: !response.ok };
    }

    if (toolName === 'secrets_delete') {
      const response = await secrets.deleteSecret(env, userId, args.secret_id as string);
      if (response.status === 204) {
        return { result: { success: true, message: 'Secret deleted' }, isError: false };
      }
      const data = await response.json();
      return { result: data as Record<string, unknown>, isError: !response.ok };
    }

    // ==========================================
    // Phase 5: Guidance Tools
    // ==========================================

    if (toolName === 'ui_show_message') {
      return {
        result: { message: args.message as string },
        isError: false,
      };
    }

    if (toolName === 'ui_highlight') {
      const command: AnyUIGuidanceCommand = {
        type: 'highlight',
        command_id: `cmd_${generateId()}`,
        target: args.target as string,
        target_description: args.target_description as string | undefined,
        style: (args.style as 'pulse' | 'glow' | 'ring') || 'pulse',
        duration: (args.duration as number) || 3000,
      };
      return {
        result: {
          success: true,
          message: `Highlighting ${args.target}`,
          _ui_command: command,
        },
        isError: false,
      };
    }

    if (toolName === 'ui_tooltip') {
      const command: AnyUIGuidanceCommand = {
        type: 'tooltip',
        command_id: `cmd_${generateId()}`,
        target: args.target as string,
        text: args.text as string,
        position: (args.position as 'top' | 'bottom' | 'left' | 'right') || 'bottom',
        duration: (args.duration as number) ?? 5000,
      };
      return {
        result: {
          success: true,
          message: `Showing tooltip on ${args.target}`,
          _ui_command: command,
        },
        isError: false,
      };
    }

    if (toolName === 'ui_open_panel') {
      const command: AnyUIGuidanceCommand = {
        type: 'open_panel',
        command_id: `cmd_${generateId()}`,
        panel: args.panel as string,
      };
      return {
        result: {
          success: true,
          message: `Opening ${args.panel} panel`,
          _ui_command: command,
        },
        isError: false,
      };
    }

    if (toolName === 'ui_scroll_to') {
      const command: AnyUIGuidanceCommand = {
        type: 'scroll_to',
        command_id: `cmd_${generateId()}`,
        target: args.target as string,
        behavior: (args.behavior as 'smooth' | 'instant') || 'smooth',
      };
      return {
        result: {
          success: true,
          message: `Scrolling to ${args.target}`,
          _ui_command: command,
        },
        isError: false,
      };
    }

    if (toolName === 'ui_dismiss_guidance') {
      const command: AnyUIGuidanceCommand = {
        type: 'dismiss_guidance',
        command_id: `cmd_${generateId()}`,
        all: args.all !== false,
      };
      return {
        result: {
          success: true,
          message: 'Dismissed guidance elements',
          _ui_command: command,
        },
        isError: false,
      };
    }

    // ==========================================
    // UI Control Tools (from MCP-UI)
    // ==========================================

    const uiToolNames = UI_TOOLS.map(t => t.name);
    if (uiToolNames.includes(toolName)) {
      const response = await callUiTool(env, toolName, args, undefined, userId);
      const data = await response.json();
      return { result: data as Record<string, unknown>, isError: !response.ok };
    }

    return {
      result: { error: `Unknown tool: ${toolName}` },
      isError: true,
    };
  } catch (error) {
    console.error(`[chat] Tool execution error for ${toolName}:`, error);
    return {
      result: { error: error instanceof Error ? error.message : 'Tool execution failed' },
      isError: true,
    };
  }
}

// ============================================
// Message Storage
// ============================================

/**
 * Save a chat message to the database
 */
async function saveMessage(
  env: Env,
  userId: string,
  dashboardId: string | null,
  role: 'user' | 'assistant' | 'tool',
  content: string,
  toolCalls?: ChatToolCall[],
  toolResults?: ChatToolResult[]
): Promise<ChatMessage> {
  const id = `msg_${generateId()}`;
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO chat_messages (id, user_id, dashboard_id, role, content, tool_calls, tool_results, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    userId,
    dashboardId,
    role,
    content,
    toolCalls ? JSON.stringify(toolCalls) : null,
    toolResults ? JSON.stringify(toolResults) : null,
    now
  ).run();

  return {
    id,
    userId,
    dashboardId,
    role,
    content,
    toolCalls,
    toolResults,
    createdAt: now,
  };
}

/**
 * Load conversation history from the database
 */
async function loadHistory(
  env: Env,
  userId: string,
  dashboardId: string | null,
  limit: number = 50
): Promise<ChatMessage[]> {
  const query = dashboardId
    ? `SELECT * FROM chat_messages WHERE user_id = ? AND dashboard_id = ? ORDER BY created_at DESC LIMIT ?`
    : `SELECT * FROM chat_messages WHERE user_id = ? AND dashboard_id IS NULL ORDER BY created_at DESC LIMIT ?`;

  const params = dashboardId ? [userId, dashboardId, limit] : [userId, limit];
  const result = await env.DB.prepare(query).bind(...params).all<{
    id: string;
    user_id: string;
    dashboard_id: string | null;
    role: 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls: string | null;
    tool_results: string | null;
    created_at: string;
  }>();

  return (result.results || []).map(row => {
    let toolCalls: ChatToolCall[] | undefined;
    let toolResults: ChatToolResult[] | undefined;
    try {
      toolCalls = row.tool_calls ? JSON.parse(row.tool_calls) : undefined;
    } catch {
      console.warn(`[chat] Malformed tool_calls JSON in message ${row.id}, skipping`);
    }
    try {
      toolResults = row.tool_results ? JSON.parse(row.tool_results) : undefined;
    } catch {
      console.warn(`[chat] Malformed tool_results JSON in message ${row.id}, skipping`);
    }
    return {
      id: row.id,
      userId: row.user_id,
      dashboardId: row.dashboard_id,
      role: row.role,
      content: row.content,
      toolCalls,
      toolResults,
      createdAt: row.created_at,
    };
  }).reverse(); // Reverse to get chronological order
}

/**
 * Convert chat history to Gemini message format
 *
 * Note: Gemini 3 requires thoughtSignature for function calls.
 * We skip any function call/response pairs without thoughtSignature (legacy data).
 */
function historyToGeminiMessages(history: ChatMessage[], dashboardId?: string): GeminiMessage[] {
  const messages: GeminiMessage[] = [];

  // Add system prompt as first user message (Gemini doesn't have system role)
  let systemPrompt = ORCABOT_SYSTEM_PROMPT;
  if (dashboardId) {
    systemPrompt += `\n\nCURRENT CONTEXT:\n- The user is viewing dashboard_id: "${dashboardId}". Use this as the dashboard_id for all tool calls unless the user explicitly refers to a different dashboard.`;
  }
  messages.push(buildTextMessage('user', systemPrompt));
  messages.push(buildTextMessage('model', 'Ready.'));

  // Build a lookup of tool results from legacy 'tool' role rows,
  // so we can fall back when assistant rows don't have toolResults (old data).
  const legacyToolResults = new Map<string, ChatToolResult>();
  for (const msg of history) {
    if (msg.role === 'tool' && msg.toolResults) {
      for (const tr of msg.toolResults) {
        legacyToolResults.set(tr.toolCallId, tr);
      }
    }
  }

  for (const msg of history) {
    if (msg.role === 'user') {
      messages.push(buildTextMessage('user', msg.content));
    } else if (msg.role === 'assistant') {
      // Add text content if present
      if (msg.content) {
        messages.push(buildTextMessage('model', msg.content));
      }
      // Add tool calls with thoughtSignatures
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          if (tc.thoughtSignature) {
            messages.push(buildFunctionCallMessage(tc.name, tc.args, tc.thoughtSignature));
            // Look for result on assistant row first, then fall back to legacy tool rows
            const result = msg.toolResults?.find(tr => tr.toolCallId === tc.id)
              || legacyToolResults.get(tc.id);
            if (result) {
              messages.push(buildFunctionResponse(tc.name, result.result));
            }
          }
        }
      }
    }
    // Skip 'tool' role messages - results are consumed above via legacyToolResults fallback
  }

  return messages;
}

// ============================================
// HTTP Handlers
// ============================================

/**
 * Stream a chat response
 *
 * POST /chat/message
 */
export async function streamMessage(
  request: Request,
  env: Env,
  userId: string
): Promise<Response> {
  const apiKey = env.GEMINI_ORCABOT_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'Orcabot Gemini API key not configured' },
      { status: 500 }
    );
  }

  let body: { message: string; dashboardId?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { message, dashboardId } = body;
  if (!message || typeof message !== 'string') {
    return Response.json({ error: 'Message is required' }, { status: 400 });
  }

  // Load conversation history
  const history = await loadHistory(env, userId, dashboardId || null, 20);

  // Save user message
  await saveMessage(env, userId, dashboardId || null, 'user', message);

  // Build Gemini messages (inject dashboardId as context so model knows the active dashboard)
  const geminiMessages = historyToGeminiMessages(history, dashboardId);
  geminiMessages.push(buildTextMessage('user', message));

  // Get available tools
  const tools = getOrcabotTools();

  // Derive the control plane origin from the incoming request for OAuth URLs
  const requestOrigin = new URL(request.url).origin;

  // Create streaming response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        let fullContent = '';
        const toolCalls: ChatToolCall[] = [];
        let currentMessages = geminiMessages;

        // Loop to handle multi-turn tool calls
        let maxTurns = 10; // Increased for complex workflows
        while (maxTurns > 0) {
          maxTurns--;
          let hasToolCall = false;

          for await (const chunk of streamChat(apiKey, currentMessages, tools, {
            model: 'gemini-3-flash',
            thinkingLevel: 'low',
            temperature: 1.0,
            maxOutputTokens: 4096,
          })) {
            if (chunk.type === 'text' && chunk.text) {
              fullContent += chunk.text;
              const event: ChatStreamEvent = { type: 'text', content: chunk.text };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            } else if (chunk.type === 'function_call' && chunk.functionCall) {
              hasToolCall = true;
              const tcId = `tc_${generateId()}`;
              const thoughtSignature = chunk.thoughtSignature || chunk.functionCall.thoughtSignature;

              // Send tool call event
              const tcEvent: ChatStreamEvent = {
                type: 'tool_call',
                id: tcId,
                name: chunk.functionCall.name,
                args: chunk.functionCall.args,
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(tcEvent)}\n\n`));

              // Auto-fill dashboard_id from request context if the model omitted it
              const toolArgs = { ...chunk.functionCall.args };
              if (!toolArgs.dashboard_id && dashboardId) {
                toolArgs.dashboard_id = dashboardId;
              }

              // Execute the tool
              const { result, isError } = await executeTool(env, userId, chunk.functionCall.name, toolArgs, requestOrigin);

              // Store the tool call with result for persistence (use toolArgs which includes auto-filled dashboard_id)
              const tc: ChatToolCall & { result?: Record<string, unknown>; isError?: boolean; thoughtSignature?: string } = {
                id: tcId,
                name: chunk.functionCall.name,
                args: toolArgs,
                result,
                isError,
                thoughtSignature: thoughtSignature,
              };
              toolCalls.push(tc);

              // Send tool result event
              const trEvent: ChatStreamEvent = {
                type: 'tool_result',
                toolCallId: tc.id,
                name: tc.name,
                result,
                isError,
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(trEvent)}\n\n`));

              // Check if the tool result contains a valid UI command and emit it
              if (result && '_ui_command' in result) {
                const cmd = result._ui_command;
                // Validate minimum shape before forwarding to client
                if (
                  cmd && typeof cmd === 'object' &&
                  'type' in cmd && typeof (cmd as Record<string, unknown>).type === 'string' &&
                  'command_id' in cmd && typeof (cmd as Record<string, unknown>).command_id === 'string'
                ) {
                  const uiCommandEvent: ChatStreamEvent = {
                    type: 'ui_command',
                    command: cmd as AnyUIGuidanceCommand,
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(uiCommandEvent)}\n\n`));
                } else {
                  console.warn('[chat] Skipping malformed _ui_command:', JSON.stringify(cmd));
                }
              }

              // Add tool call and result to messages for next turn
              // Include thoughtSignature as required by Gemini 3
              currentMessages = [
                ...currentMessages,
                buildFunctionCallMessage(tc.name, tc.args, thoughtSignature),
                buildFunctionResponse(tc.name, result),
              ];
            } else if (chunk.type === 'error') {
              const errorEvent: ChatStreamEvent = { type: 'error', error: chunk.error || 'Unknown error' };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
            }
          }

          // If no tool call, we're done
          if (!hasToolCall) {
            break;
          }
        }

        // Save assistant message with tool calls AND results on the same row
        if (fullContent || toolCalls.length > 0) {
          const toolResults: ChatToolResult[] | undefined = toolCalls.length > 0
            ? toolCalls.map(tc => ({
                toolCallId: tc.id,
                name: tc.name,
                result: tc.result || {},
                isError: tc.isError || false,
              }))
            : undefined;

          await saveMessage(
            env,
            userId,
            dashboardId || null,
            'assistant',
            fullContent,
            toolCalls.length > 0 ? toolCalls : undefined,
            toolResults
          );
        }

        // Send done event
        const doneEvent: ChatStreamEvent = { type: 'done' };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneEvent)}\n\n`));
        controller.close();
      } catch (error) {
        console.error('[chat] Streaming error:', error);
        const errorEvent: ChatStreamEvent = {
          type: 'error',
          error: error instanceof Error ? error.message : 'Streaming failed',
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

/**
 * Get chat history
 *
 * GET /chat/history
 */
export async function getHistory(
  request: Request,
  env: Env,
  userId: string
): Promise<Response> {
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');
  const parsedLimit = parseInt(url.searchParams.get('limit') || '50', 10);
  const cappedLimit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 50;
  const messages = await loadHistory(env, userId, dashboardId, cappedLimit);

  return Response.json({
    messages: messages.filter(m => m.role !== 'tool'),
    hasMore: messages.length === cappedLimit,
  });
}

/**
 * Clear chat history
 *
 * DELETE /chat/history
 */
export async function clearHistory(
  request: Request,
  env: Env,
  userId: string
): Promise<Response> {
  const url = new URL(request.url);
  const dashboardId = url.searchParams.get('dashboard_id');

  if (dashboardId) {
    await env.DB.prepare(
      'DELETE FROM chat_messages WHERE user_id = ? AND dashboard_id = ?'
    ).bind(userId, dashboardId).run();
  } else {
    await env.DB.prepare(
      'DELETE FROM chat_messages WHERE user_id = ? AND dashboard_id IS NULL'
    ).bind(userId).run();
  }

  return Response.json({ success: true });
}
