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

**The setup guide's job is to stop Orcabot chat from helping.** A `setupGuide` is a
prompt addressed to chat, not documentation for a human. An earlier version of this
one described the dashboard instead of instructing chat, so chat obligingly called
`create_terminal` and `create_browser` — and the reader got two of each, with a second
benchmark writing the same measurement files as the first. The guide now opens by
saying the dashboard is already complete and forbids both calls by name.

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

**ffmpeg.** `make_samples.py` shells out to it for the wav-to-mp3 step and the sandbox
image ships without it. Missing, every number is still correct and only the play
button is lost — which is most of the point of the page.

**Samples come after the run, not before.** `benchmark.py` sweeps and builds the page
but never synthesizes the listening clips the page embeds, and in interactive mode
*which* engines to sample is only known once the reader has chosen. So the boot command
reads the selection back out of `tools/sweep_rerun.json` after the run, synthesizes
clips for exactly those, and rebuilds the page and the export.

**The page has to exist before it can be rebuilt.** `build_benchmark_page.py`
substitutes into an existing page rather than writing one, and `benchmark.py` only
seeds that page on a run it actually completes. Quit the picker with prior
measurements already on disk and the rebuild dies on `FileNotFoundError` with every
clip already synthesized, so the boot command seeds from `tools/page_template.html`
first.

**`TTS_SAMPLE_DIR` is deliberately not set.** The three scripts want different
directories: `make_samples.py` writes mp3s into an `mp3` subdirectory that the page
builder reads and the export builder does not. Each defaults correctly on its own, so
setting one value for all of them is a way to break the export, not fix it.

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
terminal block presents it, and the quit-without-running path was tested separately
because that is the one that exposed the missing-page bug above. The report reaches the
browser block at about 50 KB with the listening clip embedded, and the export zip
carries `samples/piper.mp3` alongside it.

## Seeding

    benchmarks/bin/seed-benchmark-templates talkito-tts

A cloud control plane needs a direct insert instead: `seedStarterTemplates` returns
early unless `SURFACE_TOKEN` is set, and only the desktop app sets it, so the code seed
never runs in production. See [`../README.md`](../README.md).
