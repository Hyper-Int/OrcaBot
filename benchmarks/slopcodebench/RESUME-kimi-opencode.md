# Resume plan — run a Kimi K2.6 / opencode arm in the desktop VM

Goal: run **one** slop-code-bench arm — model **Kimi K2.6 via OpenRouter**, agent
**opencode** — end-to-end in the Orcabot **desktop VM**, with the API key kept in
the **secrets broker** and the run watchable via the **host-tmux logfile mirror**.
We are one issue away: opencode now authenticates through the broker, but the run
**hangs** at the streamed-response stage. This doc has everything to finish it.

---

## 1. Status at a glance

**Working / validated (don't re-litigate):**
- Broker → Kimi works: a direct broker call returned "PONG" (key never leaves the
  broker; PTY only ever sees a `[BROKERED]` placeholder + `OPENROUTER_BASE_URL`).
- opencode 1.17.9 baked into the sandbox image (`/usr/local/bin/opencode`); VM
  image bumped to 4 GB.
- Official `slop-code run` orchestrates: resolves the catalog problem
  (`file_backup`), auto-downloads the problem catalog to
  `/root/.cache/scbench/problems`, runs the checkpoint loop.
- Host-tmux executor tees each run to a logfile (`…/checkpoint_1/snapshot/.scb_tmux/`).
- **opencode auth through the broker is SOLVED** — no more 401. opencode launches
  `--model=scb-openrouter/moonshotai/kimi-k2.6`, reads `baseURL`+`apiKey` from its
  config, request reaches OpenRouter via the broker.

**The remaining blocker:** the run then **hangs** — `cost=0`, no agent messages,
20+ min, opencode process alive. `stream(timeout=None)` never bails.
**Ruled out:** network — `registry.npmjs.org` and `openrouter.ai` both return 200
in <0.3 s from the VM. So it is NOT an npm-fetch or connectivity hang.

---

## 2. What was fixed, and where (commits)

| Repo / branch | Commit | Change |
|---|---|---|
| fork `feat/host-tmux-executor` | `8956077` | host-tmux executor: tee streamed output to a logfile + tmux mirror (the no-Docker watchable run) |
| fork `feat/host-tmux-executor` | `bfa9aa6` | opencode local-config materialize + apiKey injection; `kimi-k2.6.yaml` `agent_specific.opencode.endpoint: openai` |
| fork `feat/host-tmux-executor` | `0adc65c` | **the auth unlock** — `LocalStreamingRuntime` now applies spawn `env_vars`; opencode uses a synthetic `scb-<provider>` `@ai-sdk/openai-compatible` provider |
| orcabot `feat/benchmark-templates-swe-tbench` | `5bd9360` | re-enable opencode in `sandbox/docker/Dockerfile`; VM image → 4 GB |

Why `0adc65c` was the key: `LocalStreamingRuntime` was **dropping** the agent's
spawn-time `env_vars`, so opencode ran with `HOME=/root` and never read its
generated config (always fell back to the built-in openrouter provider → 401).
And a provider id that matches a built-in (`openrouter`) makes opencode ignore
`options.apiKey`/`baseURL`; a **synthetic** id backed by `@ai-sdk/openai-compatible`
honors both and sends a Bearer header the broker swaps for the real key.

---

## 3. Environment / how to resume the stack

Host paths:
- orcabot repo: `~/work/hyper/orcabot3` (branch `feat/benchmark-templates-swe-tbench`)
- slop fork: `~/work/hyper/slop-code-bench` (branch `feat/host-tmux-executor`)
- `orcabot` CLI: `~/work/hyper/orcabot3/desktop/app/src-tauri/target/release/orcabot`
- host-shared VM workspace: `~/Library/Application Support/com.orcabot.desktop/workspace`
  (maps to the VM's `/workspace`)

In the VM (`/workspace` survives reboots; rootfs does NOT):
- fork: `/workspace/slop-code-bench`
- venv: `/workspace/scb-venv` (uv `--python 3.12`; managed python on
  `/workspace/.uv-python`). Run via `/workspace/scb-venv/bin/slop-code` directly —
  **no uv needed**. (VM has no compiler; deps must be wheels → python 3.12, not 3.14.)
- problem catalog: `/root/.cache/scbench/problems` (auto-downloaded; on rootfs, so
  re-downloads after a reboot — that's fine/automatic).

Bring it up:
```bash
cd ~/work/hyper/orcabot3
OB=desktop/app/src-tauri/target/release/orcabot
$OB up --timeout 240          # control plane :8787 + sandbox VM :8080
$OB exec "command -v opencode && opencode --version"   # sanity: 1.17.9
```
If the venv's `slop-code` errors with "required file not found" after a reboot
(rootfs wiped its uv-managed python), re-link it:
```bash
# reinstall uv + re-sync (deps cached on /workspace; python lands on /workspace)
# (launch detached from a PTY; see §6 launcher pattern, swap the run cmd for:)
#   curl -LsSf https://astral.sh/uv/install.sh | sh
#   UV_PYTHON_INSTALL_DIR=/workspace/.uv-python UV_CACHE_DIR=/workspace/.uv-cache \
#   UV_PROJECT_ENVIRONMENT=/workspace/scb-venv /root/.local/bin/uv sync --python 3.12
```

Broker key: brokered `OPENROUTER_API_KEY` secret on dashboard
`f054e883-ef4e-4d86-ab16-dd90a74e4b9f`. If gone, re-add (user runs it, key never
in chat):
```bash
curl -s -X POST -H "X-User-ID: dev-desktop" -H 'Content-Type: application/json' \
  --data-raw "{\"name\":\"OPENROUTER_API_KEY\",\"value\":\"$OPENROUTER_KEY\",\"type\":\"secret\",\"brokerProtected\":true,\"dashboardId\":\"f054e883-ef4e-4d86-ab16-dd90a74e4b9f\"}" \
  http://127.0.0.1:8787/secrets
```

---

## 4. The plan to resolve the hang (diagnostic-first)

The broker **already streams SSE with flush** (`sandbox/internal/broker/secrets_broker.go:524-540`:
`WriteHeader` then a read+`Flush()` loop for streaming responses). So do **not**
assume the broker buffers — first find *where* the hang is.

### Step 1 — Reproduce + localize (do this first)
From a PTY in the Kimi dashboard (so `$OPENROUTER_BASE_URL` + placeholder key are
in the env), send a **streaming** chat-completion directly through the broker:
```bash
curl -N -s "$OPENROUTER_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"moonshotai/kimi-k2.6","stream":true,
       "messages":[{"role":"user","content":"say PONG"}],"max_tokens":2000}'
```
(The earlier PONG test was **non-streaming** — that's the gap.) Interpret:
- **SSE chunks stream back promptly** → broker streaming is fine; the hang is in
  opencode's consumption → go to Step 3a.
- **Hangs / no data** → broker or upstream streaming is the problem → Step 3b.
- Cross-check the broker's view: the request reaches it at
  `secrets_broker.go:ServeHTTP` (line 291); `client.Do` (line 480) forwards
  upstream. Add temporary logging there if needed.

### Step 2 — Make hangs fail fast (do regardless; small, safe)
In the fork, `src/slop_code/agent_runner/agents/opencode/agent.py` → `run()` calls
`self.runtime.stream(command=command, env={}, timeout=None)` (~line 358). Pass a
real timeout (e.g. 600 s) so a stuck run errors with captured stdout/stderr instead
of hanging forever. This alone turns the silent hang into a diagnosable failure.

### Step 3 — Fix, by what Step 1 shows
- **3a (opencode consumes the stream wrong):** opencode's `@ai-sdk/openai-compatible`
  provider may need the model id without the `provider/` prefix, or a specific SSE
  format. Try: (i) confirm the request opencode sends (broker access log / a tcpdump
  of `localhost:8082`); (ii) try a **non-streaming** opencode path if one exists
  (some opencode/provider configs support non-stream); (iii) check opencode server
  log `/root/.local/share/opencode/log/opencode.log` for a post-`stream` error.
- **3b (broker streaming):** confirm the response writer is an `http.Flusher` in
  this path (line 527); if not, force flush / disable response buffering. Check the
  broker's **client** has no premature read timeout and that it forwards
  `Accept: text/event-stream` + chunked encoding unmodified. Verify
  `WriteTimeout: 180s` (line 633) isn't cutting a long Kimi stream.

### Step 4 — Re-run + confirm success
Success = the run advances past `checkpoint_1` with `cost > 0` and `steps > 0`,
agent messages appear in `…/checkpoint_1/agent/messages.jsonl`, and a solution diff
is produced. Then optionally drop `--no-evaluate` to score it.

---

## 5. Key files

| File | Why |
|---|---|
| `slop-code-bench/src/slop_code/agent_runner/agents/opencode/agent.py` | opencode agent: synthetic provider injection (`_from_config`), config materialize (`_materialize_local_config`), `run()` stream loop (add timeout) |
| `slop-code-bench/src/slop_code/execution/local_streaming.py` | `LocalStreamingRuntime` — now applies spawn env_vars + tmux mirror |
| `slop-code-bench/configs/models/kimi-k2.6.yaml` | `agent_specific.opencode.endpoint: openai` |
| `slop-code-bench/configs/providers.yaml` | openrouter `openai` endpoint `api_base` (rewritten to the broker URL at launch — see launcher) |
| `orcabot3/sandbox/internal/broker/secrets_broker.go` | broker proxy: `ServeHTTP` (291), forward `client.Do` (480), SSE stream+flush (524-540), `WriteTimeout` (633) |
| `orcabot3/sandbox/docker/Dockerfile` | opencode install (re-enabled) |

---

## 6. Exact run launcher (copy-paste)

Create a fresh PTY in the Kimi dashboard, then send this (base64-wrapped so
`$OPENROUTER_*` expand in the PTY, not the host). `DID=f054e883-…`; get the debug
token from `/tmp/vz-console.log` (`grep 'debug-exec] auth token:'`).

The launcher (written to a host temp file via a quoted heredoc, then
`echo <b64> | base64 -d | bash` sent via `orcabot tail --send`):
```bash
setsid bash -c '
export HOME=/root TMPDIR=/workspace/.uvtmp
cd /workspace/slop-code-bench
cp configs/providers.yaml.orig configs/providers.yaml   # restore pristine
python3 - <<PY
import os
p="configs/providers.yaml"; s=open(p).read()
open(p,"w").write(s.replace("api_base: https://openrouter.ai/api/v1","api_base: "+os.environ["OPENROUTER_BASE_URL"]))
PY
/workspace/scb-venv/bin/slop-code run --agent opencode --model openrouter/kimi-k2.6 \
  --environment configs/environments/local-tmux-py.yaml \
  --prompt configs/prompts/just-solve.jinja \
  --problem file_backup --no-evaluate thinking=low 2>&1
echo "RUN_DONE_rc=$?"
' > /workspace/.scb-run.log 2>&1 < /dev/null &
```
Watch: `tail -f /workspace/.scb-run.log` (via `/debug/exec`), and the run dir
`outputs/kimi-k2.6/opencode-*/file_backup/checkpoint_1/agent/{messages.jsonl,stdout.txt}`.
Keep a `.orig` copy of `providers.yaml` so each launch re-patches a clean file with
the current session's broker URL.

---

## 7. Fallbacks if the streaming fix is hard
- **Different agent:** `claude_code` or `codex` are installed and could be pointed
  at OpenRouter via the broker's anthropic/openai-compatible endpoints — but Kimi
  isn't configured for them in the catalog (only `opencode`).
- **Docker env instead of host-tmux:** run opencode in the upstream
  `docker-python3.12-uv.yaml` env (needs Docker-in-VM — the path we avoided).
- **Inference vs eval:** keep `--no-evaluate` until the agent loop works; add eval
  (runs pytest in the local env via `uv init`/`uv add`) once inference is green.
