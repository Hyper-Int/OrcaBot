# Config-phase wizard (Orcabot chat)

This is the **configuration phase** from the original plan: before the
benchmark template is usable, the Orcabot chat (the Gemini-powered assistant in
`controlplane/src/chat/handler.ts`) walks the user through a short back-and-forth
and then provisions the dashboard.

Wire this as an additional system-prompt block the chat loads when the user
picks the "SlopCodeBench Runner" template, or as a standalone "Set up a
benchmark" intent. It uses **only tools the chat already has**: `secrets_create`,
`create_terminal` (with `boot_command`), `create_browser`, `connect_nodes`.

---

## Conversation flow

Ask these in order, one at a time, accepting natural-language answers:

1. **Which CLI should be the agent under test?**
   `claude_code` · `codex` · `gemini`
   → sets `--agent`. (This is the harness being benchmarked, *not* the
   orchestrator — the orchestrator is always Claude Code.)

2. **How should that agent authenticate?**
   - **API key** → ask the user to paste it into the secrets panel (never into
     chat). Store via `secrets_create` under the broker name the provider
     expects (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`,
     `GEMINI_API_KEY`). It stays in the broker; the agent only ever sees a
     placeholder.
   - **Subscription login** (`codex login`, `gemini` OAuth) → note that this
     uses a file-based credential (`~/.codex/auth.json` etc.) that the broker
     does **not** manage, and that the orchestrator will run the login flow in
     its terminal.

3. **What are you benchmarking?**
   - **A model** → ask for `provider/model` (e.g. `anthropic/opus-4.5`,
     `openrouter/…`). → `--model`.
   - **A CLI/harness** → same agent, you'll compare versions; capture
     `version=`.
   - **A skill/plugin** → pick `gsd` · `omc` · `superpowers` · `karpathy`.
     → selects `local-tmux-py-with-<skill>.yaml` +
     `just-solve-with-<skill>-local-trigger.jinja`, and you'll clone the skill
     repo + set `SCB_SKILL_<NAME>_DIR` in the orchestrator's setup.

4. **Which problems / how many?** (default: a small smoke set like
   `file_backup`) → repeated `--problem` flags.

5. **Thinking budget?** `none|low|medium|high` → `thinking=`.

---

## What the wizard then does

1. `secrets_create` for any API key the user supplied (broker-scoped).
2. `create_terminal` for the **orchestrator** (Claude Code), `boot_command:
   "claude"`, working dir `slop-code-bench`, `skipApprovals: true`. Seed its
   first message with the assembled command, e.g.:
   ```
   uv run slop-code run --agent codex --model codex_auth/gpt-5.5 \
     --environment configs/environments/local-tmux-py-with-gsd.yaml \
     --prompt configs/prompts/just-solve-with-gsd-local-trigger.jinja \
     --problem file_backup thinking=high version=0.136.0
   ```
3. `create_browser` pointed at `http://localhost:8050` for results.
4. Hand off: tell the user they can now drive the orchestrator in English
   ("run it", "show me the runs", "stop X", "score and open the dashboard").
   See `orchestrator-runbook.md`.

---

## Guardrails

- **Never** accept or display a raw API key in chat — always route through the
  secrets panel + `secrets_create`.
- Confirm the assembled command back to the user before creating the
  orchestrator terminal.
- If the user picks the skills variant, remember it needs the matching
  `*-local-trigger.jinja` prompt **and** `SCB_SKILL_<NAME>_DIR` — don't run the
  base prompt against a skills env (the skill won't be read).
- Subscription auth (codex/gemini login) bypasses the broker by design; say so
  rather than implying every credential is broker-protected.
