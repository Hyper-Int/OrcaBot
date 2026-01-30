// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cwd = process.cwd();
const filesToHide = [".env.local", ".dev.vars"];
const moved = new Map();

function moveOut(file) {
  const source = path.join(cwd, file);
  if (!existsSync(source)) return;
  const backup = `${source}.ignore-deploy-${Date.now()}`;
  renameSync(source, backup);
  moved.set(source, backup);
}

function restoreAll() {
  for (const [source, backup] of moved.entries()) {
    if (existsSync(backup)) {
      renameSync(backup, source);
    }
  }
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit", cwd });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 0;
}

let exitCode = 0;
try {
  for (const file of filesToHide) {
    moveOut(file);
  }

  exitCode = run("npm", ["run", "workers:build"]);
  if (exitCode !== 0) {
    throw new Error(`workers:build failed with exit code ${exitCode}`);
  }

  exitCode = run("npx", ["wrangler", "deploy"]);
  if (exitCode !== 0) {
    throw new Error(`wrangler deploy failed with exit code ${exitCode}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  restoreAll();
}

process.exit(exitCode);

