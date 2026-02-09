// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: matrix-client-v2-concurrent-room-listing
const MODULE_REVISION = 'matrix-client-v2-concurrent-room-listing';
console.log(`[matrix-client] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Matrix Client-Server API Client
 *
 * Executes Matrix API calls with access token.
 * Token never leaves the control plane.
 * Homeserver URL is passed via args (stored in user_integrations metadata).
 */

const MATRIX_BASE_PATH = '/_matrix/client/v3';

interface MatrixEvent {
  event_id: string;
  type: string;
  sender: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  room_id?: string;
}

interface MatrixRoom {
  id: string;
  name?: string;
  topic?: string;
}

async function matrixFetch(
  homeserver: string,
  endpoint: string,
  accessToken: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
  } = {},
): Promise<unknown> {
  const { method = 'GET', body } = options;

  // Strip trailing slash from homeserver if present
  const base = homeserver.replace(/\/+$/, '');

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${accessToken}`,
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${base}${MATRIX_BASE_PATH}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        'Matrix access token expired or revoked. Please disconnect and reconnect Matrix with a fresh token.'
      );
    }
    const errBody = await response.text().catch(() => '');
    let errorCode = `${response.status}`;
    try {
      const errJson = JSON.parse(errBody) as { errcode?: string; error?: string };
      if (errJson.error) errorCode = errJson.error;
    } catch {
      // use status code
    }
    throw new Error(`Matrix API error: ${errorCode}`);
  }

  // Some endpoints return 204 No Content
  if (response.status === 204) {
    return { ok: true };
  }

  return response.json();
}

/**
 * Execute a Matrix action
 */
export async function executeMatrixAction(
  action: string,
  args: Record<string, unknown>,
  accessToken: string
): Promise<unknown> {
  switch (action) {
    case 'matrix.list_rooms':
      return listRooms(args, accessToken);
    case 'matrix.read_messages':
      return readMessages(args, accessToken);
    case 'matrix.send_message':
      return sendMessage(args, accessToken);
    case 'matrix.reply_thread':
      return replyThread(args, accessToken);
    case 'matrix.react':
      return addReaction(args, accessToken);
    case 'matrix.get_profile':
      return getProfile(args, accessToken);
    case 'matrix.redact_message':
      return redactMessage(args, accessToken);
    default:
      throw new Error(`Unknown Matrix action: ${action}`);
  }
}

async function listRooms(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ rooms: MatrixRoom[] }> {
  const homeserver = args.homeserver as string;
  if (!homeserver) throw new Error('homeserver is required');

  const data = await matrixFetch(
    homeserver,
    '/joined_rooms',
    accessToken,
  ) as { joined_rooms: string[] };

  // Cap to 50 rooms to avoid long-running requests or Worker timeouts.
  // Fetching name+topic requires 2 API calls per room — 50 rooms = 100 calls.
  const MAX_ROOMS = 50;
  const roomIds = data.joined_rooms.slice(0, MAX_ROOMS);

  // Fetch name and topic concurrently for all rooms
  const roomPromises = roomIds.map(async (roomId): Promise<MatrixRoom> => {
    const encodedRoomId = encodeURIComponent(roomId);
    const [nameResult, topicResult] = await Promise.allSettled([
      matrixFetch(homeserver, `/rooms/${encodedRoomId}/state/m.room.name`, accessToken) as Promise<{ name?: string }>,
      matrixFetch(homeserver, `/rooms/${encodedRoomId}/state/m.room.topic`, accessToken) as Promise<{ topic?: string }>,
    ]);
    return {
      id: roomId,
      name: nameResult.status === 'fulfilled' ? nameResult.value.name : undefined,
      topic: topicResult.status === 'fulfilled' ? topicResult.value.topic : undefined,
    };
  });

  const rooms = await Promise.all(roomPromises);
  return { rooms };
}

async function readMessages(
  args: Record<string, unknown>,
  accessToken: string
): Promise<MatrixEvent[]> {
  const homeserver = args.homeserver as string;
  const roomId = args.room_id as string;
  if (!homeserver) throw new Error('homeserver is required');
  if (!roomId) throw new Error('room_id is required');

  const limit = Math.min(args.limit as number || 20, 100);
  const encodedRoomId = encodeURIComponent(roomId);
  const params = new URLSearchParams({
    dir: 'b',
    limit: limit.toString(),
  });

  const data = await matrixFetch(
    homeserver,
    `/rooms/${encodedRoomId}/messages?${params}`,
    accessToken,
  ) as { chunk: MatrixEvent[] };

  return data.chunk;
}

async function sendMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ event_id: string }> {
  const homeserver = args.homeserver as string;
  const roomId = args.room_id as string;
  const text = args.text as string;
  if (!homeserver) throw new Error('homeserver is required');
  if (!roomId) throw new Error('room_id is required');
  if (!text) throw new Error('text is required');

  const encodedRoomId = encodeURIComponent(roomId);
  const txnId = `${Date.now()}${Math.random()}`;
  const encodedTxnId = encodeURIComponent(txnId);

  const data = await matrixFetch(
    homeserver,
    `/rooms/${encodedRoomId}/send/m.room.message/${encodedTxnId}`,
    accessToken,
    {
      method: 'PUT',
      body: {
        msgtype: 'm.text',
        body: text,
      },
    },
  ) as { event_id: string };

  return { event_id: data.event_id };
}

async function replyThread(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ event_id: string }> {
  const homeserver = args.homeserver as string;
  const roomId = args.room_id as string;
  const eventId = args.event_id as string;
  const text = args.text as string;
  if (!homeserver) throw new Error('homeserver is required');
  if (!roomId) throw new Error('room_id is required');
  if (!eventId) throw new Error('event_id is required');
  if (!text) throw new Error('text is required');

  const encodedRoomId = encodeURIComponent(roomId);
  const txnId = `${Date.now()}${Math.random()}`;
  const encodedTxnId = encodeURIComponent(txnId);

  const data = await matrixFetch(
    homeserver,
    `/rooms/${encodedRoomId}/send/m.room.message/${encodedTxnId}`,
    accessToken,
    {
      method: 'PUT',
      body: {
        msgtype: 'm.text',
        body: text,
        'm.relates_to': {
          'm.in_reply_to': {
            event_id: eventId,
          },
        },
      },
    },
  ) as { event_id: string };

  return { event_id: data.event_id };
}

async function addReaction(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ event_id: string }> {
  const homeserver = args.homeserver as string;
  const roomId = args.room_id as string;
  const eventId = args.event_id as string;
  const emoji = args.emoji as string;
  if (!homeserver) throw new Error('homeserver is required');
  if (!roomId) throw new Error('room_id is required');
  if (!eventId) throw new Error('event_id is required');
  if (!emoji) throw new Error('emoji is required');

  const encodedRoomId = encodeURIComponent(roomId);
  const txnId = `${Date.now()}${Math.random()}`;
  const encodedTxnId = encodeURIComponent(txnId);

  const data = await matrixFetch(
    homeserver,
    `/rooms/${encodedRoomId}/send/m.reaction/${encodedTxnId}`,
    accessToken,
    {
      method: 'PUT',
      body: {
        'm.relates_to': {
          rel_type: 'm.annotation',
          event_id: eventId,
          key: emoji,
        },
      },
    },
  ) as { event_id: string };

  return { event_id: data.event_id };
}

async function getProfile(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ displayname?: string; avatar_url?: string }> {
  const homeserver = args.homeserver as string;
  const userId = args.user_id as string;
  if (!homeserver) throw new Error('homeserver is required');
  if (!userId) throw new Error('user_id is required');

  const encodedUserId = encodeURIComponent(userId);

  const data = await matrixFetch(
    homeserver,
    `/profile/${encodedUserId}`,
    accessToken,
  ) as { displayname?: string; avatar_url?: string };

  return { displayname: data.displayname, avatar_url: data.avatar_url };
}

async function redactMessage(
  args: Record<string, unknown>,
  accessToken: string
): Promise<{ event_id: string }> {
  const homeserver = args.homeserver as string;
  const roomId = args.room_id as string;
  const eventId = args.event_id as string;
  const reason = args.reason as string | undefined;
  if (!homeserver) throw new Error('homeserver is required');
  if (!roomId) throw new Error('room_id is required');
  if (!eventId) throw new Error('event_id is required');

  const encodedRoomId = encodeURIComponent(roomId);
  const encodedEventId = encodeURIComponent(eventId);
  const txnId = `${Date.now()}${Math.random()}`;
  const encodedTxnId = encodeURIComponent(txnId);

  const body: Record<string, unknown> = {};
  if (reason) {
    body.reason = reason;
  }

  const data = await matrixFetch(
    homeserver,
    `/rooms/${encodedRoomId}/redact/${encodedEventId}/${encodedTxnId}`,
    accessToken,
    {
      method: 'PUT',
      body,
    },
  ) as { event_id: string };

  return { event_id: data.event_id };
}
