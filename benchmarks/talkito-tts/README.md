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

## Two things the sandbox forces

**HTTPS clones, not submodules.** talkito's `.gitmodules` points at
`git@github.com:robdmac/…` for both submodules. The sandbox has no SSH key, so
`git clone --recurse-submodules` cannot work. The boot command clones the three public
repos over HTTPS instead and arranges them as

    /workspace/talkito/              talkito
    /workspace/talkito/benchmark/    talkito-benchmark
    /workspace/talkito/tests-repo/   talkito-tests

which is the "submodule position" `benchmark/tools/paths.py` resolves via `../..`.
The sandbox image installs the talkito *package* but keeps no checkout
(`sandbox/docker/Dockerfile` clones with `--no-recurse-submodules` and deletes the
tree afterwards), so all three have to be fetched at run time.

**`--only`, never the picker.** `tools/benchmark.py` with no arguments opens an
interactive checklist. It reads from stdin and exits on EOF, so it cannot be driven
from a boot command. `--only` names the models directly and skips it.

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

**Prototype, not yet validated end to end.** The template's own mechanics — clone
layout, dependency install, report serving, browser wiring — are testable and tested.
The benchmark run itself is currently blocked upstream:
`benchmark/tools/paths.py` requires `tests-repo/test_tts_asr_roundtrip.py`, and that
file is not in the public `talkito-tests` repo. Until it is published, a clean clone
fails at import with

    RuntimeError: cannot find talkito. Set TALKITO_ROOT to a checkout containing
    tests-repo/test_tts_asr_roundtrip.py

This affects anyone trying to run the benchmark, not just this template.

## Seeding

    benchmarks/bin/seed-benchmark-templates talkito-tts

See [`../README.md`](../README.md) for the general path and the remote/cloud
alternative.
