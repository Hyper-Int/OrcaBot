#!/usr/bin/env node
// REVISION: desktop-drift-v1
//
// Drift detector for the Tauri desktop app.
//
// Compares three inventories:
//   1. env.X references in controlplane/src/**/*.ts  (what the code actually needs)
//   2. bindings declared in workerd.desktop.capnp     (what workerd exposes)
//   3. env vars passed via main.rs / dev.sh           (what the Tauri host plumbs in)
//
// Reports any var that the code uses but desktop doesn't provide. Items on the
// cloud-only allowlist are reported separately as "intentionally skipped" so
// the diff stays meaningful as new cloud-only features land.
//
// Exit codes:
//   0 = no drift (every used var is either provided or allowlisted)
//   1 = drift detected
//   2 = parse error / can't read source files

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const CONTROLPLANE_SRC = join(REPO_ROOT, "controlplane", "src");
const WORKERD_CAPNP = join(REPO_ROOT, "desktop", "workerd", "config", "workerd.desktop.capnp");
const MAIN_RS = join(REPO_ROOT, "desktop", "app", "src-tauri", "src", "main.rs");
const DEV_SH = join(REPO_ROOT, "desktop", "scripts", "dev.sh");
const ALLOWLIST_PATH = join(__dirname, "drift-allowlist.json");

function walk(dir, exts) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      out.push(...walk(p, exts));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(p);
    }
  }
  return out;
}

function readUsedEnvVars() {
  const used = new Map(); // name -> Set of files
  const re = /\benv\.([A-Z][A-Z0-9_]+)\b/g;
  for (const file of walk(CONTROLPLANE_SRC, [".ts"])) {
    const src = readFileSync(file, "utf8");
    let m;
    while ((m = re.exec(src)) !== null) {
      const name = m[1];
      // Skip single-letter false positives ("D", "DB" is fine to keep)
      if (name.length < 2) continue;
      if (!used.has(name)) used.set(name, new Set());
      used.get(name).add(file.replace(REPO_ROOT + "/", ""));
    }
  }
  return used;
}

function readWorkerdBindings() {
  const src = readFileSync(WORKERD_CAPNP, "utf8");
  const bindings = new Set();
  // Match: (name = "FOO", ...
  const re = /\(name\s*=\s*"([A-Z][A-Z0-9_]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    bindings.add(m[1]);
  }
  return bindings;
}

function readMainRsEnv() {
  const src = readFileSync(MAIN_RS, "utf8");
  const provided = new Set();
  // ("FOO", ...) — env var key
  const reTuple = /\(\s*"([A-Z][A-Z0-9_]+)"\s*,/g;
  // .with_env("FOO", ...)
  const reWithEnv = /\.with_env\(\s*"([A-Z][A-Z0-9_]+)"/g;
  // workerd_env.push(("FOO", ...))
  const rePush = /workerd_env\.push\(\(\s*"([A-Z][A-Z0-9_]+)"/g;
  for (const re of [reTuple, reWithEnv, rePush]) {
    let m;
    while ((m = re.exec(src)) !== null) provided.add(m[1]);
  }
  return provided;
}

function readDevShEnv() {
  const src = readFileSync(DEV_SH, "utf8");
  const provided = new Set();
  // export FOO=...  or  FOO=...  or  FOO="..."
  const re = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]+)\s*=/gm;
  let m;
  while ((m = re.exec(src)) !== null) provided.add(m[1]);
  return provided;
}

function readAllowlist() {
  try {
    return JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
  } catch {
    return { cloudOnly: {}, alwaysProvidedByPlatform: [] };
  }
}

const used = readUsedEnvVars();
const workerd = readWorkerdBindings();
const mainRs = readMainRsEnv();
const devSh = readDevShEnv();
const allowlist = readAllowlist();

// Vars that the workerd runtime always provides (not from our config)
const PLATFORM_PROVIDED = new Set(allowlist.alwaysProvidedByPlatform || []);
const cloudOnly = new Map(Object.entries(allowlist.cloudOnly || {}));

const provided = new Set([...workerd, ...mainRs, ...devSh, ...PLATFORM_PROVIDED]);

const missing = [];
const skipped = [];
const ok = [];

for (const [name, refs] of [...used.entries()].sort()) {
  if (provided.has(name)) {
    ok.push({ name, refs });
  } else if (cloudOnly.has(name)) {
    skipped.push({ name, reason: cloudOnly.get(name), refs });
  } else {
    missing.push({ name, refs });
  }
}

// Also flag bindings declared in workerd capnp but not actually used by code.
// Less critical but signals stale config.
const declaredButUnused = [];
for (const name of workerd) {
  if (!used.has(name) && !PLATFORM_PROVIDED.has(name)) {
    declaredButUnused.push(name);
  }
}

console.log(`Desktop drift report\n`);
console.log(`  controlplane code references: ${used.size} env vars`);
console.log(`  workerd.desktop.capnp:        ${workerd.size} bindings`);
console.log(`  main.rs plumbs:               ${mainRs.size} env vars`);
console.log(`  dev.sh exports:               ${devSh.size} env vars`);
console.log(`  cloud-only allowlist:         ${cloudOnly.size} entries\n`);

if (ok.length) {
  console.log(`OK (${ok.length}):`);
  for (const { name } of ok) console.log(`  ✓ ${name}`);
  console.log();
}

if (skipped.length) {
  console.log(`Cloud-only (${skipped.length}):`);
  for (const { name, reason } of skipped) console.log(`  ⚠ ${name}  —  ${reason}`);
  console.log();
}

if (declaredButUnused.length) {
  console.log(`Declared but unused (${declaredButUnused.length}):`);
  for (const name of declaredButUnused) console.log(`  ? ${name}`);
  console.log();
}

if (missing.length) {
  console.log(`MISSING (${missing.length}):`);
  for (const { name, refs } of missing) {
    const sample = [...refs].slice(0, 2).join(", ");
    const more = refs.size > 2 ? ` (+${refs.size - 2} more)` : "";
    console.log(`  ✗ ${name}`);
    console.log(`      used in: ${sample}${more}`);
  }
  console.log();
  console.error(`Drift detected: ${missing.length} env var(s) used by controlplane but not provided by desktop.`);
  console.error(`Either plumb them through main.rs + workerd.desktop.capnp, or add to drift-allowlist.json under "cloudOnly".`);
  process.exit(1);
}

console.log("Desktop config is in sync with controlplane.");
