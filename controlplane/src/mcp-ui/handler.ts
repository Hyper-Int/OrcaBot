// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * MCP UI Server Handler
 *
 * Implements the MCP (Model Context Protocol) for UI control tools.
 * Allows agents running in terminals to control the dashboard UI.
 *
 * Endpoints:
 * - GET /mcp/ui/tools - List available UI tools
 * - POST /mcp/ui/tools/call - Execute a UI tool
 * - GET /mcp/ui/dashboard/:id/items - List items in a dashboard
 */

import type { Env, UICommand, DashboardItem, DashboardEdge } from '../types';
import { checkDashbоardAccess } from '../auth/access';

// MCP Tool definitions for UI control
export const UI_TOOLS = [
  {
    name: 'create_browser',
    description: 'Create a browser panel on the dashboard to display a web page',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The ID of the dashboard to create the browser in',
        },
        url: {
          type: 'string',
          description: 'The URL to open in the browser',
        },
        position: {
          type: 'object',
          description: 'Position on the canvas (optional, defaults to auto-placement)',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
        },
        size: {
          type: 'object',
          description: 'Size of the browser panel (optional)',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
      },
      required: ['dashboard_id', 'url'],
    },
  },
  {
    name: 'create_todo',
    description: 'Create a todo list panel on the dashboard',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The ID of the dashboard to create the todo in',
        },
        title: {
          type: 'string',
          description: 'Title of the todo list',
        },
        items: {
          type: 'array',
          description: 'Initial todo items (optional)',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              completed: { type: 'boolean' },
            },
            required: ['text'],
          },
        },
        position: {
          type: 'object',
          description: 'Position on the canvas (optional)',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
        },
        size: {
          type: 'object',
          description: 'Size of the todo panel (optional)',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
      },
      required: ['dashboard_id', 'title'],
    },
  },
  {
    name: 'create_note',
    description: 'Create a sticky note on the dashboard',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The ID of the dashboard to create the note in',
        },
        text: {
          type: 'string',
          description: 'Text content of the note',
        },
        color: {
          type: 'string',
          description: 'Color of the note',
          enum: ['yellow', 'blue', 'green', 'pink', 'purple'],
        },
        position: {
          type: 'object',
          description: 'Position on the canvas (optional)',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
        },
        size: {
          type: 'object',
          description: 'Size of the note (optional)',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
      },
      required: ['dashboard_id', 'text'],
    },
  },
  {
    name: 'create_terminal',
    description: 'Create a new terminal panel on the dashboard. Use boot_command and agentic to create agent terminals (e.g. Claude Code, Gemini CLI, Codex) instead of plain shell terminals.',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The ID of the dashboard to create the terminal in',
        },
        name: {
          type: 'string',
          description: 'Name of the terminal (e.g. "Claude Code", "Gemini CLI", "Terminal")',
        },
        boot_command: {
          type: 'string',
          description: 'Command to run on terminal startup. Use "claude" for Claude Code, "gemini" for Gemini CLI, "codex" for Codex. Leave empty for a plain shell terminal.',
        },
        agentic: {
          type: 'boolean',
          description: 'Set to true when creating an AI agent terminal (Claude Code, Gemini CLI, Codex). False for plain shell terminals.',
        },
        position: {
          type: 'object',
          description: 'Position on the canvas (optional)',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
        },
        size: {
          type: 'object',
          description: 'Size of the terminal panel (optional)',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
      },
      required: ['dashboard_id'],
    },
  },
  {
    name: 'update_item',
    description: 'Update an existing item on the dashboard',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The ID of the dashboard containing the item',
        },
        item_id: {
          type: 'string',
          description: 'The ID of the item to update',
        },
        content: {
          type: 'string',
          description: 'New content for the item (JSON string)',
        },
        position: {
          type: 'object',
          description: 'New position (optional)',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
        },
        size: {
          type: 'object',
          description: 'New size (optional)',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
      },
      required: ['dashboard_id', 'item_id'],
    },
  },
  {
    name: 'delete_item',
    description: 'Delete an item from the dashboard',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The ID of the dashboard containing the item',
        },
        item_id: {
          type: 'string',
          description: 'The ID of the item to delete',
        },
      },
      required: ['dashboard_id', 'item_id'],
    },
  },
  {
    name: 'connect_nodes',
    description: 'Connect two items on the dashboard with an edge',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The ID of the dashboard containing the items',
        },
        source_item_id: {
          type: 'string',
          description: 'The ID of the source item',
        },
        target_item_id: {
          type: 'string',
          description: 'The ID of the target item',
        },
        source_handle: {
          type: 'string',
          description: 'Handle on the source item (optional)',
        },
        target_handle: {
          type: 'string',
          description: 'Handle on the target item (optional)',
        },
      },
      required: ['dashboard_id', 'source_item_id', 'target_item_id'],
    },
  },
  {
    name: 'disconnect_nodes',
    description: 'Remove the connection between two items',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The ID of the dashboard containing the items',
        },
        source_item_id: {
          type: 'string',
          description: 'The ID of the source item',
        },
        target_item_id: {
          type: 'string',
          description: 'The ID of the target item',
        },
        source_handle: {
          type: 'string',
          description: 'Handle on the source item (optional, for disambiguating multiple edges)',
        },
        target_handle: {
          type: 'string',
          description: 'Handle on the target item (optional, for disambiguating multiple edges)',
        },
      },
      required: ['dashboard_id', 'source_item_id', 'target_item_id'],
    },
  },
  {
    name: 'navigate_browser',
    description: 'Navigate an existing browser panel to a new URL',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The ID of the dashboard containing the browser',
        },
        item_id: {
          type: 'string',
          description: 'The ID of the browser item',
        },
        url: {
          type: 'string',
          description: 'The new URL to navigate to',
        },
      },
      required: ['dashboard_id', 'item_id', 'url'],
    },
  },
  {
    name: 'add_todo_item',
    description: 'Add an item to an existing todo list',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The ID of the dashboard containing the todo',
        },
        item_id: {
          type: 'string',
          description: 'The ID of the todo block',
        },
        text: {
          type: 'string',
          description: 'The text of the todo item',
        },
        completed: {
          type: 'boolean',
          description: 'Whether the item is completed (defaults to false)',
        },
      },
      required: ['dashboard_id', 'item_id', 'text'],
    },
  },
  {
    name: 'toggle_todo_item',
    description: 'Toggle the completion status of a todo item',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The ID of the dashboard containing the todo',
        },
        item_id: {
          type: 'string',
          description: 'The ID of the todo block',
        },
        todo_item_id: {
          type: 'string',
          description: 'The ID of the todo item to toggle',
        },
      },
      required: ['dashboard_id', 'item_id', 'todo_item_id'],
    },
  },
  {
    name: 'list_items',
    description: 'List all items on a dashboard',
    inputSchema: {
      type: 'object',
      properties: {
        dashboard_id: {
          type: 'string',
          description: 'The ID of the dashboard to list items from',
        },
      },
      required: ['dashboard_id'],
    },
  },
];

/**
 * List available UI tools (MCP tools/list)
 */
export function listTools(): Response {
  return Response.json({
    tools: UI_TOOLS,
  });
}

/**
 * Generate a unique command ID
 */
function generateCommandId(): string {
  return `cmd_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Get the DashboardDO stub for a dashboard
 */
function getDashboardDO(env: Env, dashboardId: string): DurableObjectStub {
  const doId = env.DASHBOARD.idFromName(dashboardId);
  return env.DASHBOARD.get(doId);
}

/**
 * Execute a UI tool call (MCP tools/call)
 */
/**
 * Execute a UI tool call (MCP tools/call)
 *
 * @param env - Environment bindings
 * @param toolName - Name of the tool to call
 * @param args - Tool arguments (must include dashboard_id)
 * @param sourceTerminalId - Optional terminal that issued the command
 * @param userId - User ID for access control (optional for internal calls)
 */
export async function callTool(
  env: Env,
  toolName: string,
  args: Record<string, unknown>,
  sourceTerminalId?: string,
  userId?: string
): Promise<Response> {
  const commandId = generateCommandId();

  // Validate dashboard_id is present
  const dashboardId = args.dashboard_id as string;
  if (!dashboardId) {
    return Response.json(
      { error: 'dashboard_id is required' },
      { status: 400 }
    );
  }

  // Access control: if userId is provided, check dashboard membership
  // Internal calls (from sandbox proxy or schedules) don't pass userId
  if (userId) {
    const { hasAccess } = await checkDashbоardAccess(env, dashboardId, userId, 'editor');
    if (!hasAccess) {
      return Response.json(
        { error: 'E79802: Access denied - you are not a member of this dashboard' },
        { status: 403 }
      );
    }
  }

  // Special case: list_items doesn't send a UI command, it queries state directly
  if (toolName === 'list_items') {
    const dо = getDashboardDO(env, dashboardId);
    const response = await dо.fetch(new Request('http://do/items', { method: 'GET' }));
    const data = await response.json() as { items: DashboardItem[]; edges: DashboardEdge[] };

    return Response.json({
      content: [
        {
          type: 'text',
          text: JSON.stringify(data, null, 2),
        },
      ],
    });
  }

  // Build the UI command based on the tool name
  let command: UICommand;

  switch (toolName) {
    case 'create_browser':
      command = {
        type: 'create_browser',
        command_id: commandId,
        source_terminal_id: sourceTerminalId,
        url: args.url as string,
        position: args.position as { x: number; y: number } | undefined,
        size: args.size as { width: number; height: number } | undefined,
      };
      break;

    case 'create_todo':
      command = {
        type: 'create_todo',
        command_id: commandId,
        source_terminal_id: sourceTerminalId,
        title: args.title as string,
        items: args.items as Array<{ text: string; completed?: boolean }> | undefined,
        position: args.position as { x: number; y: number } | undefined,
        size: args.size as { width: number; height: number } | undefined,
      };
      break;

    case 'create_note':
      command = {
        type: 'create_note',
        command_id: commandId,
        source_terminal_id: sourceTerminalId,
        text: args.text as string,
        color: args.color as 'yellow' | 'blue' | 'green' | 'pink' | 'purple' | undefined,
        position: args.position as { x: number; y: number } | undefined,
        size: args.size as { width: number; height: number } | undefined,
      };
      break;

    case 'create_terminal':
      command = {
        type: 'create_terminal',
        command_id: commandId,
        source_terminal_id: sourceTerminalId,
        name: args.name as string | undefined,
        boot_command: args.boot_command as string | undefined,
        agentic: args.agentic as boolean | undefined,
        position: args.position as { x: number; y: number } | undefined,
        size: args.size as { width: number; height: number } | undefined,
      };
      break;

    case 'update_item':
      command = {
        type: 'update_item',
        command_id: commandId,
        source_terminal_id: sourceTerminalId,
        item_id: args.item_id as string,
        content: args.content as string | undefined,
        position: args.position as { x: number; y: number } | undefined,
        size: args.size as { width: number; height: number } | undefined,
      };
      break;

    case 'delete_item':
      command = {
        type: 'delete_item',
        command_id: commandId,
        source_terminal_id: sourceTerminalId,
        item_id: args.item_id as string,
      };
      break;

    case 'connect_nodes':
      command = {
        type: 'connect_nodes',
        command_id: commandId,
        source_terminal_id: sourceTerminalId,
        source_item_id: args.source_item_id as string,
        target_item_id: args.target_item_id as string,
        source_handle: args.source_handle as string | undefined,
        target_handle: args.target_handle as string | undefined,
      };
      break;

    case 'disconnect_nodes':
      command = {
        type: 'disconnect_nodes',
        command_id: commandId,
        source_terminal_id: sourceTerminalId,
        source_item_id: args.source_item_id as string,
        target_item_id: args.target_item_id as string,
        source_handle: args.source_handle as string | undefined,
        target_handle: args.target_handle as string | undefined,
      };
      break;

    case 'navigate_browser':
      command = {
        type: 'navigate_browser',
        command_id: commandId,
        source_terminal_id: sourceTerminalId,
        item_id: args.item_id as string,
        url: args.url as string,
      };
      break;

    case 'add_todo_item':
      command = {
        type: 'add_todo_item',
        command_id: commandId,
        source_terminal_id: sourceTerminalId,
        item_id: args.item_id as string,
        text: args.text as string,
        completed: args.completed as boolean | undefined,
      };
      break;

    case 'toggle_todo_item':
      command = {
        type: 'toggle_todo_item',
        command_id: commandId,
        source_terminal_id: sourceTerminalId,
        item_id: args.item_id as string,
        todo_item_id: args.todo_item_id as string,
      };
      break;

    default:
      return Response.json(
        { error: `Unknown tool: ${toolName}` },
        { status: 400 }
      );
  }

  // Send the command to the DashboardDO
  const dо = getDashboardDO(env, dashboardId);
  const response = await dо.fetch(
    new Request('http://do/ui-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    })
  );

  if (!response.ok) {
    const error = await response.text();
    return Response.json(
      { error: `Failed to send UI command: ${error}` },
      { status: 500 }
    );
  }

  // Return MCP-style response
  return Response.json({
    content: [
      {
        type: 'text',
        text: `Command sent successfully. Command ID: ${commandId}. The UI will execute this command asynchronously.`,
      },
    ],
  });
}

/**
 * Get items from a dashboard (for the list_items tool)
 */
/**
 * Get items from a dashboard (for the list_items tool)
 *
 * @param env - Environment bindings
 * @param dashboardId - Dashboard ID
 * @param userId - User ID for access control (optional for internal calls)
 */
export async function getItems(env: Env, dashboardId: string, userId?: string): Promise<Response> {
  // Access control: if userId is provided, check dashboard membership
  if (userId) {
    const { hasAccess } = await checkDashbоardAccess(env, dashboardId, userId, 'viewer');
    if (!hasAccess) {
      return Response.json(
        { error: 'E79803: Access denied - you are not a member of this dashboard' },
        { status: 403 }
      );
    }
  }

  const dо = getDashboardDO(env, dashboardId);
  const response = await dо.fetch(new Request('http://do/items', { method: 'GET' }));

  if (!response.ok) {
    return Response.json(
      { error: 'Failed to get dashboard items' },
      { status: 500 }
    );
  }

  return response;
}
