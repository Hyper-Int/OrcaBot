# Terminal-Bench 2.1 runner for Orcabot

Run [Terminal-Bench](https://www.tbench.ai) **2.1** from Orcabot — an agent
operating autonomously in a real terminal to complete end-to-end tasks
(compile, train, debug, set up servers, security fixes…).

## ⚠️ 2.x uses Harbor, not `tb`

The original `tb` / `terminal-bench` pip package was the v0.x/1.x line.
**Terminal-Bench 2.0 / 2.1 run on the new Harbor framework** (`harbor` CLI, same
Laude Institute team). Target **Harbor** — do not build against `tb` for 2.1.

## Task + Docker model

Task unit = a Dockerized environment + a verifier. The agent runs **headless
inside the task's container**; a verifier container computes a reward. **Docker
is mandatory by default** (each task = its own container). Prereqs: `uv` +
Docker.

## Harness — install + run

```
uv tool install harbor          # or: pip install harbor

# Validate the env first with the oracle agent (runs reference solutions, NO key):
uv run harbor run --dataset terminal-bench@2.0 --agent oracle --n-concurrent 4

# Terminal-Bench 2.1 with an agent under test:
harbor run --dataset terminal-bench/terminal-bench-2-1 \
   --agent terminus-2 \
   --model anthropic/claude-opus-4-1 \
   --n-concurrent 4
```
Flags: `--dataset`/`-d` (slug `org/dataset@version`), `--agent`/`-a`,
`--model`/`-m` (LiteLLM `provider/model`), `--n-concurrent`, `--env` (runtime
backend), `--task-id` (single task), `--agent-import-path` (custom agent).
Harbor auto-downloads datasets from `hub.harborframework.com`.

## Agent under test

- **Internal:** `terminus` / `terminus-1` / `terminus-2` (reference agent), plus
  `oracle` (runs known-good solution — env check, no key) and `nop`.
- **Installed CLI agents** (run headless *inside* the task container):
  `claude-code`, `codex`, `gemini-cli`, `copilot-cli`, `openhands`, `aider`,
  `goose`, `opencode`, `cursor-cli`, `mini-swe-agent`, `qwen-coder`, …
- **Custom:** implement `BaseAgent` and pass
  `--agent-import-path module:YourAgent`.

Select with `--agent <name> --model <provider/model>`. Keys are passed into the
agent's container via env vars.

## Backends — Docker vs remote (the Orcabot decision)

- **Local Docker** (default): needs a Docker daemon reachable by the harness →
  a **Docker-capable benchmark sandbox** (DinD on an x86 Fly microVM). The
  desktop VM deliberately avoids Docker, so this won't fit there.
- **Remote sandbox** (`--env daytona` / Modal): tasks execute in a cloud
  backend; the orchestrating process needs **no local Docker daemon**. This is
  the most Orcabot-friendly path (works regardless of where the orchestrator
  runs) — needs the backend's token as a secret.

## Keys / env vars

LiteLLM-style: `--model provider/model` + the matching provider key as env var
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`). `oracle`/`nop` need
none.

## Outputs / scoring

Harbor writes `jobs/<job-name>/` with `config.json`, top-level `result.json`
(aggregate accuracy), and per-trial `<trial>/result.json` +
`verifier/reward.txt`. Score = per-task reward → accuracy across the dataset.
Leaderboard: `tbench.ai/leaderboard/terminal-bench/2.1`.

## Files

`orchestrator-runbook.md`, `config-wizard.md`, `template.json`.

## Status — prototype, partially validated

**Verified:** Harbor commands/flags/dataset slug/agent list are from the
Terminal-Bench + Harbor docs; `template.json` parses with valid embedded
content.

**Not validated from here** (needs Docker or a Daytona/Modal token + keys): a
real `harbor run`, the oracle check, remote-backend execution. Validate the env
with `--agent oracle` first (no key needed) before wiring a model.
