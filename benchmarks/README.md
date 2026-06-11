# Orcabot benchmark runners

Templates that turn Orcabot into an English-driven harness for running coding
benchmarks: a Claude Code **orchestrator** terminal you direct in plain language
sets up and runs the benchmark, runs show up as live panes on the canvas, and
results surface in a browser/note block.

## Benchmarks

| Benchmark | Dir | Runnable? | Execution model |
|-----------|-----|-----------|-----------------|
| slop-code-bench | [`slopcodebench/`](slopcodebench/) | ✅ yes | **Host** (no Docker) via the fork's tmux executor |
| SWE-bench (Lite/Verified/Full) | [`swebench/`](swebench/) | ✅ yes | Inference on host + **Docker-per-task** eval (Modal or DinD) |
| SWE-bench Pro (public 731) | [`swebench-pro/`](swebench-pro/) | ✅ yes | Inference on host + **Docker-per-task** eval (`--use_local_docker` or Modal) |
| Terminal-Bench 2.1 | [`terminal-bench/`](terminal-bench/) | ✅ yes | **Harbor** harness; Docker-per-task (or `--env daytona`/Modal remote) |
| FrontierCode (Diamond) | [`frontiercode/`](frontiercode/) | ❌ no | **Closed / submission-only** — no public harness, see the note |

## Two architecture families

**Family A — host-executable.** The agent-under-test runs directly in the
Orcabot sandbox VM; no inner container. The sandbox VM *is* the isolation
boundary. This is slop-code-bench (via the fork's host-tmux executor), where
each run is mirrored into an attachable read-only tmux pane.

**Family B — Docker-per-task.** SWE-bench, SWE-bench Pro, and Terminal-Bench run
each task in its own container — that isolation is core to correctness, so it
can't be dropped. Two backends:

- **Cloud sandbox backend (recommended, Orcabot-friendly):** the harness
  offloads container execution to a remote sandbox — **Modal** for
  SWE-bench/Pro, **Daytona/Modal** for Harbor. The orchestrator stays thin; the
  Orcabot VM never needs a Docker daemon. Needs a provider token as a secret.
- **Docker-in-VM (DinD):** run a Docker daemon inside a **Docker-capable
  benchmark sandbox** (a privileged x86 Fly microVM). Heavier; the desktop VM
  can't do this. Use when you want everything self-contained.

For SWE-bench and SWE-bench Pro the **inference phase** (agent → predictions
JSONL) is host-native and needs neither backend — only the **evaluation phase**
does. The predictions file is the clean handoff boundary.

## Shared pattern (all runnable benchmarks)

1. **Config phase** — the Orcabot chat wizard (`config-wizard.md` in each dir)
   asks agent / model / target / backend, stores keys in the secrets broker,
   and provisions the orchestrator terminal + a results block.
2. **Orchestrator** — a Claude Code terminal you drive in English
   (`orchestrator-runbook.md`), running the benchmark's native CLI.
3. **Viewers** — the orchestrator spawns a read-only viewer pane per run via its
   `create_terminal` MCP tool. The attach command is benchmark-specific:
   `tmux attach -r` (slop-code), `docker logs -f <id>` / `tail -f logs/…`
   (SWE-bench family), `harbor`/Modal log streaming (Terminal-Bench).

## Status

All templates here are **prototypes**. slop-code-bench is validated end-to-end
(see its README). The Family-B templates are grounded in each harness's real
commands but are **not** validated end-to-end from here, because they need a
Docker-capable backend (Modal token or DinD sandbox) + provider keys that aren't
available in this environment. Each dir's README states exactly what's verified
vs pending.
