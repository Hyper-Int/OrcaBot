# talkito TTS benchmark

Runs the open-weight TTS benchmark from
[talkito-benchmark](https://github.com/robdmac/talkito-benchmark) inside one Orcabot
terminal and shows the report it produces in a browser block beside it. This is the
runnable version of the published
[Testing open-weight Text To Speech models](https://orcabot.com/benchmarks/open-weight-tts)
table: same harness, same 84-phrase corpus, same page.

## Why this one has no orchestrator

Every other template here drives a benchmark through an agent, because those
benchmarks need an agent-under-test, provider keys and per-task containers. This one
needs none of that. The benchmark is a Python program that synthesizes a fixed corpus
and scores it, so the whole run fits in a single boot command and the only moving
parts are a terminal and a browser block.

That also makes it the cheapest template here to run: no LLM calls, no API key, no
tokens. It costs CPU time and nothing else.

## Architecture

    terminal block  ──runs──>  tools/benchmark.py --only piper
           │                            │
           │                            └──> tts-benchmark.html
           └──serves──> python3 -m http.server 8099  <──reads──┘
                                 ▲
    browser block ──opens──> http://localhost:8099/

The terminal starts the web server *before* it starts cloning, serving a placeholder
that refreshes every ten seconds. Without that, the browser block would show a
connection error for the whole run and only become useful at the very end. When the
report is built it is copied over the placeholder and the next refresh picks it up.

## Four things the sandbox forces

All four were found by running it, not by reading it. Two of them fail *quietly* --
the run still exits 0 and still publishes a page.

**HTTPS clones, not submodules.** talkito's `.gitmodules` points at
`git@github.com:robdmac/...`, and the sandbox has no SSH key, so
`git clone --recurse-submodules` cannot work. The boot command clones the two public
repos over HTTPS instead and arranges them as

    /workspace/talkito/              talkito
    /workspace/talkito/benchmark/    talkito-benchmark

The harness ships inside talkito-benchmark, so `tests-repo` is not needed.
`tools/paths.py` still wants a talkito **checkout** rather than the installed package
-- it looks for `talkito/tts.py` -- and `benchmark/` inside `talkito/` is the layout it
resolves via `../..`.

**`--only`, never the picker.** `tools/benchmark.py` with no arguments opens an
interactive checklist that reads stdin and exits on EOF, so it cannot be driven from a
boot command.

**`TALKITO_AUTO_APPROVE_DOWNLOADS=1`.** talkito refuses to fetch model weights when it
cannot ask a human, and a boot command has no TTY. Without it every phrase fails with
`Piper model unavailable` -- and the sweep still reports `rc=0`, having published a
table reading `0/84 phrases, WER 0.0%, RTF 0.00x`. A green run measuring nothing is
the worst failure available here, so this variable is not optional.

**ffmpeg.** `make_samples.py` shells out to it for the wav-to-mp3 step and the sandbox
image ships without it. Missing, every number is still correct and only the play
button is lost -- which is most of the point of the page.

**`TTS_SAMPLE_DIR` is deliberately not set.** The three scripts want different
directories: `make_samples.py` writes mp3s into an `mp3` subdirectory that the page
builder reads and the export builder does not. Each now defaults correctly on its own,
so setting one value for all of them is a way to break the export, not fix it.

## Running more than piper

`MODELS` is the first line of the boot command and the only thing to change:

    MODELS=piper              # the default
    MODELS=piper,kokoro
    MODELS=piper,kittentts

piper is the default because it is the cheapest complete arm in the table: it uses no
torch at all, and scoring runs through faster-whisper on CPU via CTranslate2, so the
install is seconds rather than gigabytes. Most other engines pull torch and download
their own weights on first use.

There are 73 providers. A **full sweep is around 11 hours**, longer on a first run.
Pointing this template at all of them is not a mistake the boot command should make
easy to make by accident.

## Status

**Validated end to end in the Docker sandbox**, from an empty workspace: clone,
dependency install, weight download, 84-phrase sweep, Whisper scoring, page build and
serving. The run takes about three and a half minutes for piper and finishes

    piper                  82/84  phrases   WER  5.3%   RTF  0.08x

against 4% and 0.04x for the published Apple M2 figures -- close, and real-time factor
is wall-clock so a throttled container is expected to read higher.

The report reaches the browser block at 50 KB with the listening clip embedded, and
the export zip carries `samples/piper.mp3` alongside it.

## Seeding

    benchmarks/bin/seed-benchmark-templates talkito-tts

See [`../README.md`](../README.md) for the general path and the remote/cloud
alternative.
