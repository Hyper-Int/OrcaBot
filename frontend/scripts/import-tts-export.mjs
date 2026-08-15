// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// Turns a TTS benchmark export into the run JSON the page reads, and copies the
// audio in. Written as a script rather than done by hand because the export is
// re-cut whenever the sweep is re-run, and hand-transcribing thirty-odd rows of
// eighteen columns is exactly the sort of thing that silently loses four rows.
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
// Two independent checks guard against a row vanishing anyway; see below.
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
 *  anything for the token-based engines and is blank for most rows. Libs is a
 *  packaging detail already folded into Disk. Lead-in is measured on a single
 *  clip, so it is indicative rather than a mean, and it earns its width less
 *  than it costs in a table this wide - the caveat it exists to explain lives in
 *  the methodology instead. */
const DROP_COLUMNS = new Set(["Frame rate", "Passed", "Libs", "Lead-in"]);

/** Shorter headers where the export's are longer than they need to be. */
const RENAME_COLUMNS = { "Total disk": "Disk" };

/** Cell text rewrites, by column. NeuTTS's licence is a sentence rather than an
 *  SPDX id, and spelled out it is the widest cell in the column. */
const REWRITE = {
  // Replacement is a function, not a string: "$5m" as a string literal is a
  // capture-group reference to any future group 5 in that pattern, and would
  // silently start substituting instead of printing.
  Licence: (v) => v.replace(/under \$5M/i, () => "<$5M"),
};

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
  "mms-tts": "MMS-TTS",
  // No verifiable model card for these three (licence reads "?"), so they get
  // conservative title case rather than invented internal capitals.
  "dots-tts": "Dots-TTS",
  "tada-1b": "Tada 1B",
  "tada-3b": "Tada 3B",
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

const readme = fs.readFileSync(path.join(exportDir, "README.txt"), "utf8");

// Two independent checks, because the failure that matters is a row silently
// vanishing, and a plain count cannot tell "the exporter left it out" apart from
// "my pattern missed it".
//
// 1. Did the row pattern match every row the markup contains? Counting bare
//    `<tr` tags is cruder than the full open/close pattern and so fails
//    differently, which is what makes it worth checking against.
const tagCount = (tbody.match(/<tr\b/g) ?? []).length;
if (tagCount !== rawRows.length) {
  console.error(`FATAL: tbody has ${tagCount} <tr> tags but ${rawRows.length} rows matched`);
  process.exit(1);
}

// 2. Is every configuration in the table also in results.txt? The two are
//    generated from the same run, so a name here that is missing there means the
//    parse is producing junk. The reverse is expected and only reported: the
//    exporter leaves failed and sample-less runs out of the comparison while
//    still listing their measurements.
const resultsTxt = fs.readFileSync(path.join(exportDir, "data", "results.txt"), "utf8");
const measured = new Set(
  resultsTxt.split("\n").slice(2)
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((n) => n && !/^-+$/.test(n))
);
const parsedIds = rawRows.map(([, , inner]) => inner.match(/data-sort="([^"]+)"/)?.[1] ?? "");
const unknown = parsedIds.filter((id) => !measured.has(id));
if (unknown.length) {
  console.error(`FATAL: parsed configurations absent from results.txt: ${unknown.join(", ")}`);
  process.exit(1);
}
const excluded = [...measured].filter((id) => !parsedIds.includes(id));
if (excluded.length) {
  console.log(`  i measured but not in the comparison, per the exporter: ${excluded.join(", ")}`);
}
// Prose count is informational only: it counts everything measured, which is
// not the same as everything compared.
const claimed = Number(readme.match(/(\d+)\s+configurations/)?.[1] ?? 0);
if (claimed && claimed !== rawRows.length) {
  console.log(`  i README counts ${claimed} measured; ${rawRows.length} are in the comparison`);
}

const keep = headers.map((h) => !DROP_COLUMNS.has(h));
const columns = headers.filter((_, i) => keep[i]).map((h) => RENAME_COLUMNS[h] ?? h);

const audioAvailable = new Set(
  fs.readdirSync(path.join(exportDir, "samples")).filter((f) => f.endsWith(".mp3"))
);

const rows = rawRows.map(([, rowAttrs, inner]) => {
  const tds = [...inner.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/g)].map((m) => {
    const a = attrs(m[0].slice(0, m[0].indexOf(">") + 1));
    const cls = a.class ?? "";
    const tone = ["good", "bad", "warn", "pending"].find((t) => cls.split(/\s+/).includes(t)) ?? "";
    const v = strip(m[2]);
    // The export gives unmeasured cells a sentinel sort key - -1 for PESQ and
    // Params, 99 for WER med and Lead-in - so that they pile up at one end of a
    // sort. On a page where the reader can sort by any column that is actively
    // wrong: it ranks three engines with no PESQ as the worst-sounding in the
    // table, and thirteen with no medium-model score as the least accurate.
    // Blanking the key lets the table sink them at both ends instead, which is
    // what "not measured" should do. "?" is left alone: on Licence it is a real
    // category meaning the card could not be verified, not a missing number.
    const missing = v === "·" || v === "-" || v === "";
    return {
      v,
      sort: missing ? "" : a["data-sort"] ?? "",
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

  const cells = tds
    .map((c, i) => {
      const rewrite = REWRITE[headers[i]];
      return rewrite ? { ...c, v: rewrite(c.v) } : c;
    })
    .filter((_, i) => keep[i]);
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
