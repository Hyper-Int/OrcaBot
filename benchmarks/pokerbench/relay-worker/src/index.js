// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: pokerbench-relay-worker-v2-comments
import page from "../../pokerbench/static/spectator.html";
import { handle, Table, WORKER_REVISION } from "./handler.js";

console.log(`[relay-worker] REVISION: ${WORKER_REVISION} loaded at ${new Date().toISOString()}`);

export { Table };
export default {
  fetch: (request, env, ctx) => handle(request, env, page, ctx),
};
