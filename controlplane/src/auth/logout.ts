// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Env } from '../types';
import { buildClearSessionCookie, deleteUserSession, readSessionId } from './sessions';

export async function logout(request: Request, env: Env): Promise<Response> {
  const sessionId = readSessionId(request);
  if (sessionId) {
    await deleteUserSession(env, sessionId);
  }

  return new Response(null, {
    status: 204,
    headers: {
      'Set-Cookie': buildClearSessionCookie(request),
    },
  });
}
