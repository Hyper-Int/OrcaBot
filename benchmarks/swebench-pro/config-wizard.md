# SWE-bench Pro config-phase wizard (Orcabot chat)

Config phase before provisioning the SWE-bench Pro dashboard. Uses existing chat
tools: `secrets_create`, `create_terminal`, `create_browser`, `connect_nodes`.

## Conversation flow

1. **Inference agent?** SWE-agent (bundled) · Claude Code · Codex. → Phase-1
   driver.
2. **Model + key?** Ask provider/model; user pastes the key into the secrets
   panel (never chat) → `secrets_create`. Note: SWE-agent reads provider keys
   per its submodule config — confirm the exact var name.
3. **Eval backend?**
   - **Modal** (default): user adds Modal token (`~/.modal.toml`) as a secret.
   - **Local Docker** (`--use_local_docker`): only if a Docker-capable x86
     benchmark sandbox exists; warn about heavy `jefzda/sweap-images` pulls.
4. **How many instances?** Default to a small subset for the first run, not all
   731.

## What the wizard does

1. `secrets_create` for the model key (and Modal token if chosen).
2. `create_terminal` for the **orchestrator** (Claude Code, `boot_command:
   "claude"`, working dir `SWE-bench_Pro-os`, `skipApprovals: true`), seeded
   with the two-phase plan (inference → `gather_patches.py` → `swe_bench_pro_eval.py`).
3. `create_browser` → `https://labs.scale.com/leaderboard/swe_bench_pro_public`
   (leaderboard reference; actual results are local under `--output_dir`).
4. Hand off to the orchestrator runbook.

## Guardrails

- Never accept/echo a raw key — secrets panel only.
- Prefer Modal; only offer local Docker if a DinD sandbox is provisioned, and
  warn about tens-to-hundreds of GB of image pulls.
- Public set only (731). The private/held-out splits are not accessible — don't
  imply otherwise.
