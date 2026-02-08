// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: teams-client-v2-auth-error-detection
const MODULE_REVISION = 'teams-client-v2-auth-error-detection';
console.log(`[teams-client] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Microsoft Teams Graph API Client
 *
 * Executes Microsoft Graph API calls with Bearer token.
 * Token never leaves the control plane.
 */

const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

interface TeamsChannel {
  id: string;
  displayName: string;
  description?: string;
  membershipType?: string;
}

interface TeamsMessage {
  id: string;
  body: { content: string; contentType: string };
  from?: { user?: { id: string; displayName: string } };
  createdDateTime: string;
}

interface TeamsTeam {
  id: string;
  displayName: string;
  description?: string;
}

interface TeamsMember {
  id: string;
  displayName: string;
  email?: string;
  roles?: string[];
}

async function teamsFetch(
  endpoint: string,
  accessToken: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
  } = {},
): Promise<unknown> {
  const { method = 'GET', body } = options;

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${accessToken}`,
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${GRAPH_API_BASE}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        'Teams token expired or revoked. Please disconnect and reconnect Teams with a fresh token.'
      );
    }
    const errBody = await response.text().catch(() => '');
    let errorCode = `${response.status}`;
    try {
      const errJson = JSON.parse(errBody) as { error?: { code?: string; message?: string } };
      if (errJson.error?.message) errorCode = errJson.error.message;
    } catch {
      // use status code
    }
    throw new Error(`Microsoft Graph API error: ${errorCode}`);
  }

  // Some endpoints return 204 No Content
  if (response.status === 204) {
    return { ok: true };
  }

  return response.json();
}

/**
 * Execute a Microsoft Teams action
 */
export async function executeTeamsAction(
  action: string,
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  switch (action) {
    case 'teams.list_channels':
      return listChannels(args, accessToken);
    case 'teams.read_messages':
      return readMessages(args, accessToken);
    case 'teams.send_message':
      return sendMessage(args, accessToken);
    case 'teams.reply_thread':
      return replyThread(args, accessToken);
    case 'teams.get_member':
      return getMember(args, accessToken);
    case 'teams.edit_message':
      return editMessage(args, accessToken);
    case 'teams.delete_message':
      return deleteMessage(args, accessToken);
    case 'teams.list_teams':
      return listTeams(accessToken);
    default:
      throw new Error(`Unknown Teams action: ${action}`);
  }
}

async function listChannels(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ channels: TeamsChannel[] }> {
  const teamId = args.team_id as string;
  if (!teamId) throw new Error('team_id is required');

  const data = await teamsFetch(
    `/teams/${teamId}/channels`,
    accessToken,
  ) as { value: TeamsChannel[] };

  return { channels: data.value };
}

async function readMessages(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ messages: TeamsMessage[] }> {
  const teamId = args.team_id as string;
  const channelId = args.channel_id as string;
  if (!teamId) throw new Error('team_id is required');
  if (!channelId) throw new Error('channel_id is required');

  const limit = Math.min(args.limit as number || 20, 50);
  const params = new URLSearchParams({ '$top': limit.toString() });

  const data = await teamsFetch(
    `/teams/${teamId}/channels/${channelId}/messages?${params}`,
    accessToken,
  ) as { value: TeamsMessage[] };

  return { messages: data.value };
}

async function sendMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ id: string }> {
  const teamId = args.team_id as string;
  const channelId = args.channel_id as string;
  const text = args.text as string;
  if (!teamId) throw new Error('team_id is required');
  if (!channelId) throw new Error('channel_id is required');
  if (!text) throw new Error('text is required');

  const data = await teamsFetch(
    `/teams/${teamId}/channels/${channelId}/messages`,
    accessToken,
    { method: 'POST', body: { body: { content: text, contentType: 'text' } } },
  ) as TeamsMessage;

  return { id: data.id };
}

async function replyThread(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ id: string }> {
  const teamId = args.team_id as string;
  const channelId = args.channel_id as string;
  const messageId = args.message_id as string;
  const text = args.text as string;
  if (!teamId) throw new Error('team_id is required');
  if (!channelId) throw new Error('channel_id is required');
  if (!messageId) throw new Error('message_id is required');
  if (!text) throw new Error('text is required');

  const data = await teamsFetch(
    `/teams/${teamId}/channels/${channelId}/messages/${messageId}/replies`,
    accessToken,
    { method: 'POST', body: { body: { content: text, contentType: 'text' } } },
  ) as TeamsMessage;

  return { id: data.id };
}

async function getMember(
  args: Record<string, unknown>,
  accessToken: string
): Promise<TeamsMember> {
  const teamId = args.team_id as string;
  const userId = args.user_id as string;
  if (!teamId) throw new Error('team_id is required');
  if (!userId) throw new Error('user_id is required');

  const data = await teamsFetch(
    `/teams/${teamId}/members/${userId}`,
    accessToken,
  ) as TeamsMember;

  return data;
}

async function editMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ ok: boolean }> {
  const teamId = args.team_id as string;
  const channelId = args.channel_id as string;
  const messageId = args.message_id as string;
  const text = args.text as string;
  if (!teamId) throw new Error('team_id is required');
  if (!channelId) throw new Error('channel_id is required');
  if (!messageId) throw new Error('message_id is required');
  if (!text) throw new Error('text is required');

  await teamsFetch(
    `/teams/${teamId}/channels/${channelId}/messages/${messageId}`,
    accessToken,
    { method: 'PATCH', body: { body: { content: text, contentType: 'text' } } },
  );

  return { ok: true };
}

async function deleteMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ ok: boolean }> {
  const teamId = args.team_id as string;
  const channelId = args.channel_id as string;
  const messageId = args.message_id as string;
  if (!teamId) throw new Error('team_id is required');
  if (!channelId) throw new Error('channel_id is required');
  if (!messageId) throw new Error('message_id is required');

  await teamsFetch(
    `/teams/${teamId}/channels/${channelId}/messages/${messageId}`,
    accessToken,
    { method: 'DELETE' },
  );

  return { ok: true };
}

async function listTeams(
  accessToken: string
): Promise<{ teams: TeamsTeam[] }> {
  const data = await teamsFetch(
    `/me/joinedTeams`,
    accessToken,
  ) as { value: TeamsTeam[] };

  return { teams: data.value };
}
