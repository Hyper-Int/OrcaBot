# talkito TTS benchmark

Runs the open-weight TTS benchmark from
[talkito-benchmark](https://github.com/robdmac/talkito-benchmark) inside one Orcabot
terminal and shows the report it produces in a browser block beside it. This is the
runnable version of the published
[Testing open-weight Text To Speech models](https://orcabot.com/benchmarks/open-weight-tts)
table: same harness, same 84-phrase corpus, same page.

The reader chooses which engines to measure. The terminal opens the benchmark's own
checklist — arrows move, space toggles, `n` clears, Enter runs — and everything after
that is automatic.

## Why this one has no orchestrator

Every other template here drives a benchmark through an agent, because those
benchmarks need an agent-under-test, provider keys and per-task containers. This one
needs none of that. The benchmark is a Python program that synthesizes a fixed corpus
and scores it, so the whole run fits in a single boot command and the only moving
parts are a terminal and a browser block.

That also makes it the cheapest template here to run: no LLM calls, no API key, no
tokens. It costs CPU time and nothing else.

**It ships no `setupGuide`, deliberately.** That field is not documentation — it is a
walkthrough brief for Orcabot chat, and its presence has two effects. The dashboards
page sets `orcabot_initial_prompt` to "Walk me through setting up this dashboard.",
which `ChatPanel` auto-sends on mount with the panel expanded. And the control plane
injects the guide into *every* chat message on that dashboard, under a system prompt
reading "Use your tools to do the work (… `create_terminal`/`create_browser` as
needed)".

An earlier version carried a guide that described the dashboard, and chat did as the
wrapper told it: two terminals and two browsers, with a second benchmark writing the
same measurement files as the first. Replacing the text with "do not create anything"
only argued with the instruction wrapped around it. Removing the field removes the
auto-prompt, the walkthrough system prompt, and the reason chat was invoked at all —
so it stays minimised and silent, which is right for a dashboard with no keys, no
provider choice, no config, and a terminal that starts itself.

## Architecture

    terminal block  ──runs──>  tools/benchmark.py   (interactive picker)
           │                            │
           │                            └──> tts-benchmark.html
           └──serves──> python3 -m http.server 8099  <──reads──┘
                                 ▲
    browser block ──opens──> http://localhost:8099/

The terminal starts the web server *before* it starts cloning, serving a placeholder
that refreshes every ten seconds. Without that, the browser block would show a
connection error for the whole run and only become useful at the very end. When the
report is built it is copied over the placeholder and the next refresh picks it up.

## What the sandbox forces

All of these were found by running it, not by reading it, and two of them fail
*quietly* — the run still exits 0 and still publishes a page.

**HTTPS clones, not submodules.** talkito's `.gitmodules` points at
`git@github.com:robdmac/...`, and the sandbox has no SSH key, so
`git clone --recurse-submodules` cannot work. The boot command clones the two public
repos over HTTPS instead and arranges them as

    /workspace/talkito/              talkito
    /workspace/talkito/benchmark/    talkito-benchmark

The harness ships inside talkito-benchmark, so `tests-repo` is not needed.
`tools/paths.py` still wants a talkito **checkout** rather than the installed package
— it looks for `talkito/tts.py` — and `benchmark/` inside `talkito/` is the layout it
resolves via `../..`.

**`TALKITO_AUTO_APPROVE_DOWNLOADS=1`.** talkito refuses to fetch model weights when it
cannot ask a human. The picker is interactive, so it *could* ask — but the prompt would
land in the middle of a sweep the reader has walked away from, so it is answered in
advance. Without it every phrase fails with `Piper model unavailable` and the sweep
still reports `rc=0`, having published a table reading `0/84 phrases, WER 0.0%,
RTF 0.00x`. A green run measuring nothing is the worst failure available here.

**No listening clips, and therefore no ffmpeg.** `make_samples.py` exists to embed one
playable clip per engine, and it shells out to ffmpeg for the wav-to-mp3 step. Audio
does not reach the reader through the browser block, so the clips are not synthesized
at all — which removes ffmpeg, which removes the only `apt-get` this template ran,
which removes an egress approval prompt for `deb.nodesource.com`. The sandbox image
installs Node from NodeSource at build time and leaves the apt source configured, so
*any* `apt-get update` inside the sandbox reaches for it. The table is numbers.

**The published page's encoding is declared upstream now.** It was not: the report
carried no `<meta charset>` and `python3 -m http.server` sends `text/html` with no
charset either, so a browser fell back to its locale default and read valid UTF-8 as
cp1252 — `TTS Engine Benchmark — 24 configurations` arriving with garbage where the em
dash should be. `tools/page_template.html` declares it now, so the boot command simply
copies. It keeps a fallback that prepends the tag when a page lacks one, because the
failure is silent and total, and it writes to the published copy rather than the source
so the export zip stays byte-identical to what the tools wrote.

## Choosing engines

Everything is ticked when the picker opens, and a **full sweep is around eleven
hours** — longer on a first run, because every engine downloads its own weights. Press
`n` to clear, then space to pick a few.

piper is the cheapest complete arm in the table: no torch at all, and scoring runs
through faster-whisper on CPU via CTranslate2, so the install is seconds rather than
gigabytes and the run is about three and a half minutes. Most other engines pull torch.

The picker shows what each engine cost on previous runs, and `?` where it has never
been measured.

## Status

**Validated end to end in the Docker sandbox**, from an empty workspace: clone,
dependency install, weight download, 84-phrase sweep, Whisper scoring, page build and
serving. A piper run finishes

    piper                  82/84  phrases   WER  5.3%   RTF  0.08x

against 4% and 0.04x for the published Apple M2 figures — close, and real-time factor
is wall-clock so a throttled container is expected to read higher.

The picker was driven under a real PTY to confirm it renders and takes input the way a
terminal block presents it, and the quit-without-running path was tested separately.
The report reaches the browser block as a table of numbers with its encoding declared;
nothing is playable, by design.

## Seeding

    benchmarks/bin/seed-benchmark-templates talkito-tts

A cloud control plane needs a direct insert instead: `seedStarterTemplates` returns
early unless `SURFACE_TOKEN` is set, and only the desktop app sets it, so the code seed
never runs in production. See [`../README.md`](../README.md).
