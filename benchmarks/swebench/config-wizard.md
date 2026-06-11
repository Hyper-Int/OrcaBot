# SWE-bench config-phase wizard (Orcabot chat)

The configuration phase the Orcabot chat runs before provisioning the SWE-bench
dashboard. Uses only existing chat tools: `secrets_create`, `create_terminal`,
`create_browser`, `connect_nodes`.

## Conversation flow (one question at a time)

1. **Which variant?** `Lite` (default, cheap) · `Verified` (leaderboard) ·
   `Full` · `Multimodal` (inference only). → `--dataset_name`.
2. **Which agent/scaffold for inference?** plain model API
   (`swebench.inference.run_api`) · SWE-agent · Agentless · a CLI harness
   (Claude Code/Codex). → determines the Phase-1 command.
3. **Which model + key?** Ask for the provider/model and have the user paste the
   key into the secrets panel (never chat) → `secrets_create`
   (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`).
4. **Eval backend?**
   - **Modal** (default, no local Docker) → have the user add their Modal token
     (`~/.modal.toml`) as a secret; eval uses `--modal true`.
   - **Docker-in-VM** → only if a Docker-capable benchmark sandbox is
     provisioned; warn this needs an x86 DinD machine and ~120 GB disk.
5. **Subset size?** Default to a handful of `--instance_ids` for a first run,
   not the whole variant.

## What the wizard then does

1. `secrets_create` for the model key (and Modal token if chosen).
2. `create_terminal` for the **orchestrator** (Claude Code, `boot_command:
   "claude"`, working dir `SWE-bench`, `skipApprovals: true`). Seed its first
   message with the assembled two-phase plan (inference command → `preds.jsonl`
   → `run_evaluation` with the chosen backend).
3. `create_browser` pointed at `https://www.swebench.com` (leaderboard +
   reference) — results themselves are local JSON, so also tell the user where
   the report lands.
4. Hand off to the orchestrator runbook.

## Guardrails

- Never accept/echo a raw API key — route through the secrets panel.
- Always run the `--predictions_path gold` sanity check on a new eval backend
  before real inference, and say why (it validates Docker/Modal for free).
- Be explicit that **Full @ `--cache_level instance` ≈ 2 TB** — steer to Lite +
  `env` cache for a first run.
- Multimodal: inference only (private test split) — don't promise a score.
