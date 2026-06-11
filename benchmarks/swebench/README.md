# SWE-bench runner for Orcabot

Run [SWE-bench](https://github.com/SWE-bench/SWE-bench) from Orcabot: an
English-driven Claude Code orchestrator generates patches, then scores them.

## The task + variants

Each instance = a real GitHub issue + a repo snapshot. The agent produces a
`model_patch`; the harness applies it and runs the repo's tests. **Resolved** =
designated `FAIL_TO_PASS` tests pass and `PASS_TO_PASS` tests still pass.

| Variant | Dataset (`--dataset_name`) | Size | Use |
|---------|----------------------------|------|-----|
| Lite | `princeton-nlp/SWE-bench_Lite` | ~300 | cheap smoke test |
| Verified | `princeton-nlp/SWE-bench_Verified` | 500 | standard leaderboard target |
| Full | `princeton-nlp/SWE-bench` | ~2294 | full run |
| Multimodal | `princeton-nlp/SWE-bench_Multimodal` | — | visual/JS (test split private) |

## Two phases — this is the key architecture

**1. Inference (host-native, needs model keys, no Docker).** Run an agent
scaffold against each instance to emit a **predictions JSONL**, one object/line:
```json
{"instance_id":"astropy__astropy-12345","model_name_or_path":"my-agent","model_patch":"diff --git ..."}
```
Scaffolds: SWE-agent (canonical agentic), Agentless, plain model API
(`python -m swebench.inference.run_api`), or any harness (Claude Code/Codex)
that can write the JSONL. **Runs anywhere, including the desktop VM.**

**2. Evaluation (Docker-per-task, no model keys).**
```
python -m swebench.harness.run_evaluation \
    --dataset_name princeton-nlp/SWE-bench_Verified \
    --predictions_path preds.jsonl \
    --run_id my-run \
    --max_workers 8 \
    --cache_level env
```
Every instance runs in its own container. **Docker is mandatory — there is no
host/local eval mode.** No model API keys needed for this phase.

## Backends for the eval phase

- **Modal (recommended, no local Docker):** add `--modal true`. Container
  execution runs on Modal's cloud; the Orcabot VM stays thin. Needs a Modal
  token (`~/.modal.toml`) as a secret.
- **Docker-in-VM (DinD):** run a Docker daemon in a **Docker-capable x86 Fly
  microVM** benchmark sandbox, then run eval locally. Heavier; not the desktop
  VM. On arm64 you must pass `--namespace ''` to build images locally (prebuilt
  images are x86_64-only) — slow and partly experimental.

## Resource reality

Minimum ~**120 GB disk, 16 GB RAM, 8 cores** for local eval. `--cache_level
env` (default) ≈ 100 GB; `instance` ≈ 2 TB (avoid). Keep `--max_workers` ≤
`min(0.75·cores, 24)`; ~8 for Lite, ~12 for Full. Start with **Lite** + Modal.

## Sanity check before real runs

```
python -m swebench.harness.run_evaluation \
    --predictions_path gold --max_workers 1 \
    --instance_ids sympy__sympy-20590 --run_id validate-gold
```
`gold` runs the reference patches — confirms your Docker/Modal backend works
before you spend inference tokens.

## Files

| File | Purpose |
|------|---------|
| `orchestrator-runbook.md` | System prompt + runbook for the orchestrator agent |
| `config-wizard.md` | Orcabot-chat config phase |
| `template.json` | Importable dashboard template |

## Status — prototype, partially validated

**Verified:** commands/flags/formats above are from the SWE-bench repo + docs;
`template.json` parses with valid embedded content.

**Not validated from here** (needs Docker/Modal + keys): a real inference run, a
real `run_evaluation` (local or Modal), arm64 local-build path. Treat the
runbook as grounded instructions, not a turnkey-verified pipeline.
