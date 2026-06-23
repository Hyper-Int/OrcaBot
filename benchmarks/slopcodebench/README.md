# SlopCodeBench Runner for Orcabot

Turn Orcabot into a **1-click, English-driven harness for running
[slop-code-bench](https://github.com/SprocketLab/slop-code-bench)** — a coding
agent you direct in plain language sets up and runs the benchmark, and every
agent-under-test run shows up as a live, read-only pane on the canvas.

This directory is the **orchestration layer**. It pairs with a branch on the
slop-code-bench fork that adds the no-Docker, watchable executor:

| Piece | Where | What |
|-------|-------|------|
| Host (no-Docker) executor + tmux mirror | `robdmac/slop-code-bench` branch `feat/host-tmux-executor` | Runs the agent-under-test directly in the VM and mirrors each run into an attachable tmux window |
| Orchestration layer (this dir) | `orcabot3` branch `feat/benchmark-tmux-viewers` | Orchestrator runbook, read-only viewer convention, results browser, config wizard, importable template |

## Why this shape

slop-code-bench normally spawns a Docker container per problem. Inside Orcabot
the sandbox is *already* an isolated VM, so we drop the inner container and run
on the host — which also sidesteps Docker-in-Docker and works on the desktop
VM. The cost is weaker isolation/reproducibility than the pinned image (fine for
relative comparisons; use the Docker env for leaderboard-exact numbers). See
the fork's `docs/HOST_TMUX_EXECUTOR.md`.

Keeping a Claude Code agent as the **orchestrator** (not a deterministic script)
is deliberate: you can drive stop/start/chaining/interim-analysis/debugging in
English via Remote Control, which is the actual product value here.

## Architecture

```
┌─ Terminal: ORCHESTRATOR ───────────┐        ┌─ Browser block ───────────┐
│  Claude Code, driven in English     │        │  slop-code Dash dashboard │
│  runs: slop-code run (local-tmux)   │        │  http://localhost:8050    │
│  has Orcabot MCP tools              │        └───────────────────────────┘
│  (create_terminal, connect_nodes)   │
└───┬───────────┬───────────┬─────────┘
    │ spawns viewer panes + edges per run
    ▼           ▼           ▼
┌─ ▶ run ──┐ ┌─ ▶ run ──┐ ┌─ ▶ run ──┐   boot_command:
│ tail -F  │ │ tail -F  │ │ tail -F  │   tail -n +1 -F <run-logfile>
└──────────┘ └──────────┘ └──────────┘   (read-only viewers; no inject)
        ▲ per-run logfiles (the executor tees each run to one)
        │
   host-tmux executor in the slop-code-bench fork
```

Viewer panes **tail the per-run logfile**, not the executor's tmux socket — a
separate viewer PTY may run under a different uid, and bridging a tmux *control*
socket across uids would need world-accessibility (read+inject across sessions,
bypassing output redaction). Logfile tail is read-only and reaches only that
run. The executor's tmux session stays private to its own uid (its multiplexing
convenience); `scb-attach` is for same-uid interactive use only.

## Prerequisites

- **tmux** — already in the sandbox image (`sandbox/docker/Dockerfile`), and the
  desktop VM rootfs is `docker export`ed from that same image, so it's present
  on both prod and desktop. No infra change needed.
- The **fork branch** `feat/host-tmux-executor` checked out in the workspace as
  `slop-code-bench`, with `uv sync` run.
- Problems repo `scb-problems` checked out.
- Keys in the Orcabot **secrets broker** for whatever provider you benchmark.

## Quick start

1. **Config phase** — pick the "SlopCodeBench Runner" template (or ask the
   Orcabot chat to "set up a benchmark"). The chat wizard
   (`config-wizard.md`) asks CLI / auth / target / problems, stores keys in the
   broker, and provisions the orchestrator terminal + results browser.
2. **Drive the orchestrator** in English (`orchestrator-runbook.md`):
   - "Run `file_backup` and `execution_server` with claude_code on opus-4.5."
   - "Show me the runs." → it spawns a read-only viewer pane per run.
   - "execution_server looks stuck — stop it."
   - "Score the finished runs and open the dashboard."
3. **Watch** runs in the viewer panes; **read results** in the browser block.

## Files

| File | Purpose |
|------|---------|
| `orchestrator-runbook.md` | System prompt + runbook for the orchestrator agent |
| `config-wizard.md` | Orcabot-chat config phase (Part 1 of the plan) |
| `template.json` | Importable `DashboardTemplateWithData` (orchestrator + note + results browser) |
| `bin/scb-runs` | List active runs + read-only attach commands |
| `bin/scb-attach` | Attach read-only to a run |
| `bin/scb-dashboard` | Serve the Dash results dashboard on :8050 |

## Importing the template

`template.json` matches `DashboardTemplateWithData`
(`frontend/src/types/dashboard.ts`). Templates live in D1, so import it via the
template API / chat `dashboard_create`, not as a code seed — the file is the
portable definition. The viewer panes are intentionally **not** in the
template; the orchestrator creates them per run at runtime.

## Status — prototype

**Validated**
- Host-tmux executor: unit + real-tmux lifecycle tests pass; end-to-end smoke
  run confirms harness output is unchanged while a tmux window mirrors it
  (`feat/host-tmux-executor`).
- `scb-runs` / `scb-attach` against a real tmux session; read-only resolution.
- `template.json` parses; every embedded `content` string is valid.

**Not yet validated end-to-end (needs a live Orcabot VM + keys)**
- A full `slop-code run` of a real problem under `local-tmux-py.yaml` with a
  real agent CLI.
- The orchestrator calling `create_terminal`/`connect_nodes` to spawn viewer
  panes from inside an Orcabot terminal.
- The Dash dashboard rendering in a browser block at :8050.
- Skills-variant copy-in path for OMC / SuperPowers / Karpathy (only GSD has a
  ready-made local env + prompt; others follow the documented pattern).

**Deliberately deferred**
- Docker-env parity path (for leaderboard-exact runs) — orthogonal; the Docker
  configs already exist upstream.
- Per-run cgroup memory caps for safe parallelism — documented, not wired.
