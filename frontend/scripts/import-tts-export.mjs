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
import crypto from "node:crypto";

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
const DROP_COLUMNS = new Set(["Frame rate", "Passed", "Libs", "Lead-in", "WER med", "Avg audio"]);

/** Configurations the comparison does not show. The NeuTTS-2E CPU builds are
 *  the same weights as the rows that remain, run on a slower path: they tripled
 *  the size of the NeuTTS band while saying nothing about the model, only about
 *  the hardware it was pointed at. Their measurements stay in the raw export. */
const DROP_ROWS = new Set(["nt-2e-fp32-cpu", "nt-2e-q4-cpu", "nt-2e-q8-cpu"]);

/** Shorter headers where the export's are longer than they need to be.
 *  Only one word error rate is shown, so it does not need qualifying: base.en
 *  is the recogniser that completed for every configuration, where medium.en
 *  did not. */
const RENAME_COLUMNS = {
  "Total disk": "Disk",
  "WER base": "WER",
  // x-bar: it is a mean, and "Avg" spent five characters saying so in a column
  // whose values are four wide.
  "Avg synth": "x\u0304 synth",
};

/** Where each project states its own licence: its LICENSE file, or the model
 *  card that declares it. Deliberately not opensource.org and friends - those
 *  explain what MIT is, they do not evidence that this model is under it, which
 *  is the whole point of the link.
 *
 *  Resolved and verified per repo rather than constructed: GitHub's licence API
 *  finds the file whatever it is called, and the Hugging Face repos were probed
 *  for LICENSE before falling back to the card.
 *
 *  Two point at a model card rather than the repo's LICENSE, because the repo
 *  licenses the *code* and this benchmark measures *weights*, and for these two
 *  they differ: F5-TTS is MIT as code and cc-by-nc-4.0 as weights, NeMo is
 *  Apache-2.0 as a framework while the FastPitch checkpoint is cc-by-4.0. The
 *  card is what evidences the licence the table prints.
 *
 *  Three rows have none. Dots-TTS is listed "?" here while its repo declares
 *  Apache-2.0, so there is nothing consistent to point at; OmniVoice has no
 *  upstream card at all; BananaMind TTS has no findable home.
 */
const LICENCE_PROOF_URLS = {
  "bark": "https://github.com/suno-ai/bark/blob/main/LICENSE",
  "chatterbox": "https://github.com/resemble-ai/chatterbox/blob/master/LICENSE",
  "chatterbox-q4": "https://github.com/resemble-ai/chatterbox/blob/master/LICENSE",
  "chatterbox-q8": "https://github.com/resemble-ai/chatterbox/blob/master/LICENSE",
  "chatterbox-turbo": "https://github.com/resemble-ai/chatterbox/blob/master/LICENSE",
  "cosyvoice3": "https://github.com/QwenAudio/CosyVoice/blob/main/LICENSE",
  "cosyvoice3-rl": "https://github.com/QwenAudio/CosyVoice/blob/main/LICENSE",
  "csm": "https://github.com/SesameAILabs/csm/blob/main/LICENSE",
  "f5-tts": "https://huggingface.co/SWivid/F5-TTS",
  "fastpitch": "https://huggingface.co/nvidia/tts_en_fastpitch",
  "kittentts-mini": "https://huggingface.co/KittenML/kitten-tts-mini-0.8/blob/main/README.md",
  "kittentts-micro": "https://huggingface.co/KittenML/kitten-tts-micro-0.8/blob/main/README.md",
  "kittentts-nano": "https://huggingface.co/KittenML/kitten-tts-nano-0.8-fp32/blob/main/README.md",
  "kittentts-nano-int8": "https://huggingface.co/KittenML/kitten-tts-nano-0.8-int8/blob/main/README.md",
  "kokoro": "https://huggingface.co/hexgrad/Kokoro-82M/blob/main/README.md",
  "melotts": "https://github.com/myshell-ai/MeloTTS/blob/main/LICENSE",
  "mms-tts": "https://huggingface.co/facebook/mms-tts/blob/main/README.md",
  "nt-2e-fp32-mps": "https://huggingface.co/neuphonic/neutts-2e/blob/main/LICENSE",
  "nt-2e-q4-metal": "https://huggingface.co/neuphonic/neutts-2e/blob/main/LICENSE",
  "nt-2e-q8-metal": "https://huggingface.co/neuphonic/neutts-2e/blob/main/LICENSE",
  "parler-tts": "https://github.com/huggingface/parler-tts/blob/main/LICENSE",
  "piper": "https://github.com/rhasspy/piper/blob/master/LICENSE.md",
  "qwen3-tts": "https://github.com/QwenLM/Qwen3-TTS/blob/main/LICENSE",
  "speecht5": "https://huggingface.co/microsoft/speecht5_tts/blob/main/README.md",
  "styletts2": "https://github.com/yl4579/StyleTTS2/blob/main/LICENSE",
  "tada-1b": "https://huggingface.co/HumeAI/tada-1b/blob/main/LICENSE",
  "tada-3b": "https://huggingface.co/HumeAI/tada-3b-ml/blob/main/LICENSE",
  "vibevoice": "https://github.com/microsoft/VibeVoice/blob/main/LICENSE",
  "vibevoice-1.5b": "https://huggingface.co/microsoft/VibeVoice-1.5B/blob/main/README.md",
  "xtts": "https://huggingface.co/coqui/XTTS-v2/blob/main/LICENSE.txt",
  "zonos": "https://github.com/Zyphra/Zonos/blob/main/LICENSE",
};

/** Where each model actually lives. Kept here rather than in the export, which
 *  carries no URLs at all. A configuration with no entry renders as plain text:
 *  several of these have no upstream model card to link to (the export says so
 *  outright for OmniVoice), and a plausible-looking wrong link is worse than
 *  none. */
const MODEL_URLS = {
  "piper": "https://github.com/rhasspy/piper",
  "kokoro": "https://huggingface.co/hexgrad/Kokoro-82M",
  "bark": "https://github.com/suno-ai/bark",
  "mms-tts": "https://huggingface.co/facebook/mms-tts",
  "f5-tts": "https://github.com/SWivid/F5-TTS",
  "parler-tts": "https://github.com/huggingface/parler-tts",
  "xtts": "https://huggingface.co/coqui/XTTS-v2",
  "cosyvoice3": "https://github.com/QwenAudio/CosyVoice",
  "cosyvoice3-rl": "https://github.com/QwenAudio/CosyVoice",
  "chatterbox": "https://github.com/resemble-ai/chatterbox",
  "chatterbox-turbo": "https://github.com/resemble-ai/chatterbox",
  "chatterbox-q4": "https://github.com/resemble-ai/chatterbox",
  "chatterbox-q8": "https://github.com/resemble-ai/chatterbox",
  "styletts2": "https://github.com/yl4579/StyleTTS2",
  "melotts": "https://github.com/myshell-ai/MeloTTS",
  "speecht5": "https://huggingface.co/microsoft/speecht5_tts",
  "kittentts-mini": "https://huggingface.co/KittenML/kitten-tts-mini-0.8",
  "kittentts-micro": "https://huggingface.co/KittenML/kitten-tts-micro-0.8",
  "kittentts-nano": "https://huggingface.co/KittenML/kitten-tts-nano-0.8-fp32",
  "kittentts-nano-int8": "https://huggingface.co/KittenML/kitten-tts-nano-0.8-int8",
  "csm": "https://github.com/SesameAILabs/csm",
  "zonos": "https://github.com/Zyphra/Zonos",
  "fastpitch": "https://github.com/NVIDIA-NeMo/Speech",
  "qwen3-tts": "https://github.com/QwenLM/Qwen3-TTS",
  "dots-tts": "https://github.com/rednote-hilab/dots.tts",
  "tada-1b": "https://huggingface.co/HumeAI/tada-1b",
  "tada-3b": "https://huggingface.co/HumeAI/tada-3b-ml",
  // The quantized and device variants are the same upstream weights.
  "nt-2e-fp32-mps": "https://huggingface.co/neuphonic/neutts-2e",
  "nt-2e-q4-metal": "https://huggingface.co/neuphonic/neutts-2e",
  "nt-2e-q8-metal": "https://huggingface.co/neuphonic/neutts-2e",
  // 1.02B "despite a 0.5b filename", per the export - no model page matches it,
  // so this one points at the project rather than a specific checkpoint.
  "vibevoice": "https://github.com/microsoft/VibeVoice",
  "vibevoice-1.5b": "https://huggingface.co/microsoft/VibeVoice-1.5B",
  // Deliberately absent: omnivoice, which the export says has no upstream model
  // card, and bananamind-tts, which nothing findable matches. They render as
  // plain text rather than pointing somewhere plausible but wrong.
};

/** Cell text rewrites, by column. NeuTTS's licence is a sentence rather than an
 *  SPDX id, and spelled out it is the widest cell in the column. */
const REWRITE = {
  // "stoch-ff" was the widest value in a column of six-character codes.
  Class: (v) => (v === "stoch-ff" ? "st-ff" : v),
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
  "kittentts-mini": "KittenTTS Mini",
  "kittentts-micro": "KittenTTS Micro",
  "kittentts-nano": "KittenTTS Nano",
  "kittentts-nano-int8": "KittenTTS Nano INT8",
  "kokoro": "Kokoro",
  "melotts": "MeloTTS",
  "nt-2e-fp32-mps": "NeuTTS-2E FP32",
  "nt-2e-q4-metal": "NeuTTS-2E Q4",
  "nt-2e-q8-metal": "NeuTTS-2E Q8",
  "xtts": "XTTS",
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

const kept = rawRows.filter((r) => !DROP_ROWS.has(r[2].match(/data-sort="([^"]+)"/)?.[1] ?? ""));
if (kept.length !== rawRows.length) {
  console.log(`  i not shown: ${[...DROP_ROWS].join(", ")}`);
}
rawRows.length = 0;
rawRows.push(...kept);

const keep = headers.map((h) => !DROP_COLUMNS.has(h));
const columns = headers.filter((_, i) => keep[i]).map((h) => RENAME_COLUMNS[h] ?? h);

const audioAvailable = new Set(
  fs.readdirSync(path.join(exportDir, "samples")).filter((f) => f.endsWith(".mp3"))
);

const rows = rawRows.map(([, rowAttrs, inner]) => {
  // Resolved up front: the cell mapper below needs it, and it is derived from
  // the first cell rather than from the loop variable.
  const config = (inner.match(/<td class="l name" data-sort="([^"]+)"/) ?? [])[1] ?? "";
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

  // The name cell can carry a qualifier the id does not, e.g. "zonos (partial)".
  const qualifier = tds[0].v.replace(config, "").trim();
  const display = (DISPLAY[config] ?? config) + (qualifier ? ` ${qualifier}` : "");
  if (!DISPLAY[config]) console.warn(`  ! no display name for "${config}" - using the raw id`);

  const cells = tds
    .map((c, i) => {
      const rewrite = REWRITE[headers[i]];
      const cell = rewrite ? { ...c, v: rewrite(c.v) } : c;
      if (headers[i] === "Licence" && LICENCE_PROOF_URLS[config]) {
        return { ...cell, href: LICENCE_PROOF_URLS[config] };
      }
      return cell;
    })
    .filter((_, i) => keep[i]);
  cells[0] = { ...cells[0], v: display, ...(MODEL_URLS[config] ? { href: MODEL_URLS[config] } : {}) };

  const sample = `${config}.mp3`;
  return {
    config,
    display,
    group: (attrs(`<tr${rowAttrs}>`).class ?? "").trim(),
    // Bare filename here; the content hash is appended after the copy below.
    sample: audioAvailable.has(sample) ? sample : null,
    cells,
  };
});

const rtfCol = columns.indexOf("RTF");
const rtfOf = (r) => Number(r.cells[rtfCol].sort);
const RTF_CUTOFF = 2;

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

fs.mkdirSync(OUT_AUDIO, { recursive: true });
const short = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 8);

let copied = 0, changed = 0;
for (const r of rows) {
  if (!r.sample) { console.warn(`  ! no audio for ${r.config}`); continue; }
  const src = path.join(exportDir, "samples", r.sample);
  const dst = path.join(OUT_AUDIO, r.sample);
  const incoming = fs.readFileSync(src);
  const existing = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
  const replaced = !existing || !existing.equals(incoming);
  if (replaced) { fs.writeFileSync(dst, incoming); changed++; }
  copied++;

  // A re-cut clip usually keeps its filename, so browsers and the CDN would go
  // on serving the old audio against a table of new numbers - the sort of wrong
  // that is invisible because everything still plays. Fingerprinting the URL
  // with the content hash makes changed bytes a different URL, while unchanged
  // clips keep theirs and stay cached.
  r.sample = `${r.sample}?v=${short(incoming)}`;
  if (replaced) console.log(`  ~ replaced ${path.basename(dst)}`);
}

// Audio for configurations no longer listed would otherwise accumulate forever.
const wanted = new Set(rows.map((r) => r.sample?.split("?")[0]).filter(Boolean));
for (const f of fs.readdirSync(OUT_AUDIO)) {
  if (f.endsWith(".mp3") && !wanted.has(f)) {
    fs.unlinkSync(path.join(OUT_AUDIO, f));
    console.log(`  - removed stale audio ${f}`);
  }
}

// Written only now: the copy loop above appends each clip's content hash to
// row.sample, and serialising before that ran wrote the rows without their
// version tags - the audio was correctly replaced and every URL still pointed
// at the unversioned name, which is precisely the stale-cache case this exists
// to prevent.
fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(run, null, 2) + "\n");

const within = rows.filter((r) => rtfOf(r) <= RTF_CUTOFF).length;
console.log(
  `[import-tts-export] ${rows.length} configurations, ${columns.length} columns ` +
  `(dropped ${[...DROP_COLUMNS].join(", ")}), ${copied} clips (${changed} changed)\n` +
  `  ${within} within ${RTF_CUTOFF}x real time, ${rows.length - within} above it\n` +
  `  -> ${OUT_JSON}`
);
