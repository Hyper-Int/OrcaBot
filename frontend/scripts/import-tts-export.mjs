// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// Turns a TTS benchmark export into the run JSON the page reads, and copies the
// audio in. Written as a script rather than done by hand because the export is
// re-cut whenever the sweep is re-run, and hand-transcribing twenty-seven rows
// of eighteen columns is exactly the sort of thing that silently loses four rows.
//
// benchmark.html is the source, not results.txt: only the HTML carries the
// precomputed data-sort keys, the per-cell tone classes, and the row grouping.
// The two have been seen to disagree (a run where chatterbox-q4's RTF read 1.97
// in one and 2.03 in the other), and the HTML is what the exporter renders from.
//
// Parsing notes, both learned by losing data:
//   - Attributes are parsed as a set, never positionally. Some cells carry
//     `title` before `data-sort`, so a `class="..." data-sort="..."` regex
//     silently yields an empty sort key for exactly the columns that need one.
//   - Rows are matched as `<tr...>`, not `<tr>`. Grouped rows carry a class, and
//     a bare `<tr>` pattern drops every one of them.
// The row count is asserted against the README's own count as a backstop.
//
// Usage:
//   node scripts/import-tts-export.mjs <unzipped-export-dir> [run-id]

import fs from "node:fs";
import path from "node:path";

const [exportDir, runId = "2026-08"] = process.argv.slice(2);
if (!exportDir) {
  console.error("usage: import-tts-export.mjs <unzipped-export-dir> [run-id]");
  process.exit(1);
}

const OUT_JSON = `src/data/benchmarks/open-weight-tts/${runId}.json`;
const OUT_AUDIO = "public/benchmarks/tts";

/** Columns carried by the export that the page does not show.
 *  Passed is the denominator behind the word error rates - methodology, not a
 *  result, and it never separates one engine from another. Frame rate only means
 *  anything for the token-based engines and is blank for most rows. */
const DROP_COLUMNS = new Set(["Frame rate", "Passed"]);

/** Each vendor's own capitalisation. The export uses lowercase run ids; showing
 *  those verbatim misspells every product on the page. Anything not listed falls
 *  back to the raw id, which is visible enough to get noticed and fixed. */
const DISPLAY = {
  "piper": "Piper",
  "bark": "Bark",
  "chatterbox": "Chatterbox",
  "chatterbox-q4": "Chatterbox Q4",
  "chatterbox-q8": "Chatterbox Q8",
  "chatterbox-turbo": "Chatterbox Turbo",
  "cosyvoice3": "CosyVoice3",
  "cosyvoice3-rl": "CosyVoice3 RL",
  "csm": "CSM",
  "f5-tts": "F5-TTS",
  "fastpitch": "FastPitch",
  "kittentts": "KittenTTS",
  "kokoro": "Kokoro",
  "melotts": "MeloTTS",
  "nt-2e-fp32-cpu": "NeuTTS-2E FP32 CPU",
  "nt-2e-fp32-mps": "NeuTTS-2E FP32 MPS",
  "nt-2e-q4-cpu": "NeuTTS-2E Q4 CPU",
  "nt-2e-q4-metal": "NeuTTS-2E Q4 Metal",
  "omnivoice": "OmniVoice",
  "parler-tts": "Parler-TTS",
  "qwen3-tts": "Qwen3-TTS",
  "speecht5": "SpeechT5",
  "styletts2": "StyleTTS2",
  "vibevoice": "VibeVoice",
  "vibevoice-1.5b": "VibeVoice 1.5B",
  "zonos": "Zonos",
  "bananamind-tts": "BananaMind TTS",
};

const html = fs
  .readFileSync(path.join(exportDir, "benchmark.html"), "utf8")
  // Samples are embedded as data URIs. They are megabytes of base64 that make
  // every subsequent pattern quadratic, and the mp3s are on disk anyway.
  .replace(/data:audio\/mpeg;base64,[A-Za-z0-9+/=]+/g, "AUDIO");

/** Attributes as a map, order-independent. */
function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}
const strip = (s) =>
  s
    .replace(/<button\b[^>]*>[\s\S]*?<\/button>/gi, "") // the play control is not cell text
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&middot;/g, "·").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

const thead = html.slice(0, html.indexOf("</thead>"));
const headers = [...thead.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)]
  .map((m) => strip(m[1]))
  .filter(Boolean);

const tbody = html.slice(html.indexOf("<tbody"), html.indexOf("</tbody>"));
const rawRows = [...tbody.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/g)];

// The README states the configuration count in prose; use it as an independent
// check that no rows were dropped by a pattern that looked fine.
const readme = fs.readFileSync(path.join(exportDir, "README.txt"), "utf8");
const claimed = Number(readme.match(/(\d+)\s+configurations/)?.[1] ?? 0);
if (claimed && claimed !== rawRows.length) {
  console.error(`FATAL: README says ${claimed} configurations, parsed ${rawRows.length}`);
  process.exit(1);
}

const keep = headers.map((h) => !DROP_COLUMNS.has(h));
const columns = headers.filter((_, i) => keep[i]);

const audioAvailable = new Set(
  fs.readdirSync(path.join(exportDir, "samples")).filter((f) => f.endsWith(".mp3"))
);

const rows = rawRows.map(([, rowAttrs, inner]) => {
  const tds = [...inner.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/g)].map((m) => {
    const a = attrs(m[0].slice(0, m[0].indexOf(">") + 1));
    const cls = a.class ?? "";
    const tone = ["good", "bad", "warn", "pending"].find((t) => cls.split(/\s+/).includes(t)) ?? "";
    return {
      v: strip(m[2]),
      sort: a["data-sort"] ?? "",
      tone,
      align: cls.split(/\s+/).includes("l") ? "left" : "",
      restricted: cls.split(/\s+/).includes("restricted"),
    };
  });
  if (tds.length !== headers.length) {
    console.error(`FATAL: row "${tds[0]?.v}" has ${tds.length} cells, expected ${headers.length}`);
    process.exit(1);
  }

  const config = tds[0].sort;
  // The name cell can carry a qualifier the id does not, e.g. "zonos (partial)".
  const qualifier = tds[0].v.replace(config, "").trim();
  const display = (DISPLAY[config] ?? config) + (qualifier ? ` ${qualifier}` : "");
  if (!DISPLAY[config]) console.warn(`  ! no display name for "${config}" - using the raw id`);

  const cells = tds.filter((_, i) => keep[i]);
  cells[0] = { ...cells[0], v: display };

  const sample = `${config}.mp3`;
  return {
    config,
    display,
    group: (attrs(`<tr${rowAttrs}>`).class ?? "").trim(),
    sample: audioAvailable.has(sample) ? sample : null,
    cells,
  };
});

const rtfCol = columns.indexOf("RTF");
const rtfOf = (r) => Number(r.cells[rtfCol].sort);
const RTF_CUTOFF = 2.1;

const run = {
  benchmark: "open-weight-tts",
  run: runId,
  label: readme.match(/Exported (\d{4}-\d{2}-\d{2})/)?.[1] ?? runId,
  machine: "Apple M2, macOS",
  corpus: "84 phrases",
  // Kept as data rather than hardcoded in the component: it drives the
  // real-time filter, and where the line sits is an editorial choice.
  rtfCutoff: RTF_CUTOFF,
  caption:
    "Sorted by compute per phrase, fastest first. Every configuration measured is listed, " +
    "including the ones far too slow to keep up with their own speech; the filter above hides " +
    `anything above ${RTF_CUTOFF}x real time.`,
  columns,
  rows,
};

fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(run, null, 2) + "\n");

fs.mkdirSync(OUT_AUDIO, { recursive: true });
let copied = 0;
for (const r of rows) {
  if (!r.sample) { console.warn(`  ! no audio for ${r.config}`); continue; }
  fs.copyFileSync(path.join(exportDir, "samples", r.sample), path.join(OUT_AUDIO, r.sample));
  copied++;
}
// Audio for configurations no longer listed would otherwise accumulate forever.
const wanted = new Set(rows.map((r) => r.sample).filter(Boolean));
for (const f of fs.readdirSync(OUT_AUDIO)) {
  if (f.endsWith(".mp3") && !wanted.has(f)) {
    fs.unlinkSync(path.join(OUT_AUDIO, f));
    console.log(`  - removed stale audio ${f}`);
  }
}

const within = rows.filter((r) => rtfOf(r) <= RTF_CUTOFF).length;
console.log(
  `[import-tts-export] ${rows.length} configurations, ${columns.length} columns ` +
  `(dropped ${[...DROP_COLUMNS].join(", ")}), ${copied} clips\n` +
  `  ${within} within ${RTF_CUTOFF}x real time, ${rows.length - within} above it\n` +
  `  -> ${OUT_JSON}`
);
