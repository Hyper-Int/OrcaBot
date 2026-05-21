#!/usr/bin/env node
// REVISION: check-catalogs-v1
// Diffs local static catalogs against their upstream sources and reports drift.
// Run manually via `npm run check-catalogs`, or weekly via GitHub Actions.
// Exits 0 = up to date, 1 = drift detected, 2 = network/source error.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "..", "src", "data");

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const SUBAGENTS_INDEX_URL =
  "https://api.github.com/repos/VoltAgent/awesome-claude-code-subagents/contents/categories";

const RESULTS = {
  upToDate: [],
  drift: [],
  errors: [],
};

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "orcabot-catalog-check" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return res.json();
}

async function checkOpenRouter() {
  const localPath = resolve(DATA_DIR, "openrouter-models.json");
  const local = JSON.parse(readFileSync(localPath, "utf8"));
  const localIds = new Set(local.models.map((m) => m.id));

  let remote;
  try {
    const payload = await fetchJSON(OPENROUTER_MODELS_URL);
    remote = payload.data || payload.models || [];
  } catch (err) {
    RESULTS.errors.push(`openrouter-models: ${err.message}`);
    return;
  }

  const remoteIds = new Set(remote.map((m) => m.id));
  const removed = [...localIds].filter((id) => !remoteIds.has(id));
  const stalePrices = [];

  for (const localModel of local.models) {
    const remoteModel = remote.find((m) => m.id === localModel.id);
    if (!remoteModel || !remoteModel.pricing) continue;
    const remoteInput = Number(remoteModel.pricing.prompt) * 1_000_000;
    const remoteOutput = Number(remoteModel.pricing.completion) * 1_000_000;
    if (!Number.isFinite(remoteInput) || !Number.isFinite(remoteOutput)) continue;
    const driftInput = Math.abs(remoteInput - localModel.pricing.input);
    const driftOutput = Math.abs(remoteOutput - localModel.pricing.output);
    if (driftInput > 0.01 || driftOutput > 0.01) {
      stalePrices.push({
        id: localModel.id,
        local: localModel.pricing,
        remote: { input: remoteInput, output: remoteOutput },
      });
    }
  }

  if (removed.length === 0 && stalePrices.length === 0) {
    RESULTS.upToDate.push(`openrouter-models (${local.models.length} curated)`);
    return;
  }

  if (removed.length) {
    RESULTS.drift.push(
      `openrouter-models: ${removed.length} model(s) removed upstream — ${removed.join(", ")}`
    );
  }
  if (stalePrices.length) {
    const lines = stalePrices
      .map(
        (s) =>
          `  - ${s.id}: local $${s.local.input}/$${s.local.output} vs remote $${s.remote.input.toFixed(2)}/$${s.remote.output.toFixed(2)}`
      )
      .join("\n");
    RESULTS.drift.push(`openrouter-models: ${stalePrices.length} price drift(s):\n${lines}`);
  }
}

async function checkSubagents() {
  const localPath = resolve(DATA_DIR, "claude-subagents.json");
  const local = JSON.parse(readFileSync(localPath, "utf8"));
  const localCategoryIds = new Set(local.categories.map((c) => c.id));

  let remote;
  try {
    remote = await fetchJSON(SUBAGENTS_INDEX_URL);
  } catch (err) {
    RESULTS.errors.push(`claude-subagents: ${err.message}`);
    return;
  }

  const remoteCategories = remote
    .filter((entry) => entry.type === "dir")
    .map((entry) => entry.name);

  const newCategories = remoteCategories.filter((name) => {
    const id = name.split("-")[0];
    return !localCategoryIds.has(id);
  });

  if (newCategories.length === 0) {
    RESULTS.upToDate.push(`claude-subagents (${local.categories.length} categories)`);
    return;
  }

  RESULTS.drift.push(
    `claude-subagents: ${newCategories.length} new categor(y/ies) upstream — ${newCategories.join(", ")}`
  );
}

console.log("Checking catalog freshness...\n");
await Promise.all([checkOpenRouter(), checkSubagents()]);

for (const ok of RESULTS.upToDate) {
  console.log(`  up to date: ${ok}`);
}
for (const drift of RESULTS.drift) {
  console.log(`  DRIFT: ${drift}`);
}
for (const err of RESULTS.errors) {
  console.log(`  ERROR: ${err}`);
}

if (RESULTS.errors.length) {
  console.error(`\nFailed (${RESULTS.errors.length} error(s))`);
  process.exit(2);
}
if (RESULTS.drift.length) {
  console.error(`\nDrift detected (${RESULTS.drift.length} catalog(s) need update)`);
  process.exit(1);
}
console.log("\nAll catalogs current.");
