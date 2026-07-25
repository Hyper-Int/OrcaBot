# Terminal-Bench 2.1 config-phase wizard (Orcabot chat)

Config phase before provisioning the Terminal-Bench dashboard. Uses existing
chat tools: `secrets_create`, `create_terminal`, `create_browser`,
`connect_nodes`.

## Conversation flow

1. **Which agent under test?** `terminus-2` (reference) · `claude-code` ·
   `codex` · `gemini-cli` · `mini-swe-agent` · custom (`--agent-import-path`).
   → `--agent`.
2. **Model + key?** Ask provider/model (LiteLLM `provider/model`); user pastes
   the key into the secrets panel (never chat) → `secrets_create`
   (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`).
3. **Backend?**
   - **Remote** (`--env daytona` / Modal): default; user adds the backend token
     as a secret. No local Docker needed.
   - **Local Docker**: only if a Docker-capable benchmark sandbox is
     provisioned.
4. **Scope?** Single `--task-id` for a smoke test, or the full 2.1 set. Set
   `--n-concurrent` to backend capacity.

## What the wizard does

1. `secrets_create` for the model key (and backend token if remote).
2. `create_terminal` for the **orchestrator** (Claude Code, `boot_command:
   "claude"`, `skipApprovals: true`). Seed its first message to (a) install
   Harbor, (b) run the **oracle** validation, then (c) the real run command with
   the chosen agent/model/backend.
3. `create_browser` → `https://www.tbench.ai/leaderboard/terminal-bench/2.1`
   (leaderboard reference; results are local under `jobs/`).
4. Hand off to the orchestrator runbook.

## Guardrails

- Never accept/echo a raw key — secrets panel only.
- Always start with `--agent oracle` (no key) to prove the environment before
  spending model tokens — and say why.
- Use **Harbor** + the `terminal-bench/terminal-bench-2-1` slug, not legacy
  `tb`. Don't conflate the two.
- Default to the remote backend; only offer local Docker if a DinD sandbox
  exists (the desktop VM can't run it).
