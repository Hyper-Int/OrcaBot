// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// Deploy script for dev.orcabot.com deployment.
// Temporarily swaps .env.production with dev values so Next.js
// bakes the correct API URLs into the client bundle.

import { existsSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cwd = process.cwd();
const moved = new Map();

const DEV_ENV = `NEXT_PUBLIC_API_URL=https://api.dev.orcabot.com
NEXT_PUBLIC_SITE_URL=https://dev.orcabot.com
`;

function moveOut(file) {
  const source = path.join(cwd, file);
  if (!existsSync(source)) return;
  const backup = `${source}.ignore-deploy-${Date.now()}`;
  renameSync(source, backup);
  moved.set(source, backup);
}

function restoreAll() {
  // Remove the temporary dev .env.production we wrote
  const envProd = path.join(cwd, ".env.production");
  if (existsSync(envProd) && moved.has(envProd)) {
    unlinkSync(envProd);
  }

  for (const [source, backup] of moved.entries()) {
    if (existsSync(backup)) {
      renameSync(backup, source);
    }
  }
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit", cwd });
  if (result.error) throw result.error;
  return result.status ?? 0;
}

let exitCode = 0;
try {
  // Hide local dev files
  moveOut(".env.local");
  moveOut(".dev.vars");

  // Swap .env.production with dev values
  moveOut(".env.production");
  writeFileSync(path.join(cwd, ".env.production"), DEV_ENV);

  exitCode = run("npm", ["run", "workers:build"]);
  if (exitCode !== 0) throw new Error(`workers:build failed with exit code ${exitCode}`);

  exitCode = run("npx", ["wrangler", "deploy", "-c", "wrangler.dev.toml"]);
  if (exitCode !== 0) throw new Error(`wrangler deploy failed with exit code ${exitCode}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  restoreAll();
}

process.exit(exitCode);
