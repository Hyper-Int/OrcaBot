# Resume plan — run a Kimi K2.6 / opencode arm in the desktop VM

Goal: run **one** slop-code-bench arm — model **Kimi K2.6 via OpenRouter**, agent
**opencode** — end-to-end in the Orcabot **desktop VM**, with the API key kept in
the **secrets broker** and the run watchable via the **host-tmux logfile mirror**.

> **RESOLVED 2026-06-23.** The "hang" was an IPv4/IPv6 loopback mismatch, not a
> streaming bug. The broker listens on `127.0.0.1` only; opencode (Node/undici)
> resolves `localhost` to IPv6 `::1` first, can't reach the IPv4 broker, and
> retry-storms into an apparent hang. Fix: hand harnesses `127.0.0.1`, not
> `localhost`. With that, the arm runs end-to-end (`cost>0`, steps advance through
> checkpoints). See §2 + §4. The rest of this doc is kept as the run recipe.

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

**Root cause of the former "hang" (FIXED):** opencode's `@ai-sdk/openai-compatible`
provider could not connect to the broker. opencode debug log
(`--print-logs --log-level DEBUG`) showed `AI_APICallError: Cannot connect to API`
→ `AI_RetryError: Failed after 3 attempts`, repeating with exponential backoff
across the title + build sub-agents — i.e. a retry storm, not a stalled stream.
The broker binds `127.0.0.1:8082` (IPv4 only; `secrets_broker.go:630`), but the
baseURL was `http://localhost:8082/...`. Node/undici tries IPv6 `::1` first →
ECONNREFUSED. curl/Go/Python prefer IPv4, which is why the direct streaming curl
through the broker worked perfectly (chunks in 3 s) and masked the bug.
**Fix:** use `127.0.0.1`, not `localhost`. Two places — see §2.

---

## 2. What was fixed, and where (commits)

| Repo / branch | Commit | Change |
|---|---|---|
| fork `feat/host-tmux-executor` | `8956077` | host-tmux executor: tee streamed output to a logfile + tmux mirror (the no-Docker watchable run) |
| fork `feat/host-tmux-executor` | `bfa9aa6` | opencode local-config materialize + apiKey injection; `kimi-k2.6.yaml` `agent_specific.opencode.endpoint: openai` |
| fork `feat/host-tmux-executor` | `0adc65c` | **the auth unlock** — `LocalStreamingRuntime` now applies spawn `env_vars`; opencode uses a synthetic `scb-<provider>` `@ai-sdk/openai-compatible` provider |
| orcabot `feat/benchmark-templates-swe-tbench` | `5bd9360` | re-enable opencode in `sandbox/docker/Dockerfile` |
| orcabot `feat/benchmark-templates-swe-tbench` | `b3b7751` | default VM image size → 4 GB (5bd9360 only set it via env, not source) |
| orcabot `feat/benchmark-templates-swe-tbench` | `17e7cd4` | **the hang fix** — broker env URLs use `127.0.0.1`, not `localhost` (`sandbox/cmd/server/env.go:138,162`). Product-wide; needs a VM image rebuild to reach the deployed sandbox |

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

## 4. How it was resolved (record)

The diagnosis was done from a PTY in the Kimi dashboard (which has
`$OPENROUTER_BASE_URL` + the `[BROKERED]` placeholder key in env):

1. **Streaming curl through the broker** (`"stream":true`) — returned SSE chunks in
   ~3 s, `http=200`, real cost. So the broker streams fine; the earlier non-stream
   PONG was not the gap. → hang is opencode-side.
2. **Ran opencode standalone** with the same synthetic-provider config + a `timeout`
   so it couldn't hang forever; added `--print-logs --log-level DEBUG`. The log
   showed `AI_APICallError: Cannot connect to API` → `AI_RetryError: Failed after 3
   attempts`, retrying with backoff. Config loaded fine (`scb-openrouter` selected) —
   it simply couldn't open the socket.
3. **Switched the baseURL `localhost` → `127.0.0.1`** and re-ran: the agent loop
   completed instantly (reasoning + text + `step_finish` reason=stop). Root cause =
   IPv4-only broker vs Node/undici's IPv6-first `localhost` resolution.

**Fixes applied:**
- Product source: `sandbox/cmd/server/env.go:138,162` now emits `127.0.0.1`
  (commit `17e7cd4`). Fixes every brokered provider for all Node harnesses; needs a
  VM image rebuild to reach the deployed sandbox.
- Run recipe (works on the *current* image without a rebuild): the launcher rewrites
  `providers.yaml`'s broker `api_base` with `localhost`→`127.0.0.1` (see §6).

Success criterion met: the arm advanced past `checkpoint_1` with `cost=0.01027`
(`steps=1`) into `checkpoint_2`. To score it, drop `--no-evaluate`.

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
python3 - <<'PY'
import os
p="configs/providers.yaml"; s=open(p).read()
# 127.0.0.1, NOT localhost: opencode (Node/undici) resolves localhost to IPv6 ::1
# first and the broker is IPv4-only -> retry-storm hang. (env.go now emits
# 127.0.0.1 too; this swap keeps the recipe working on a not-yet-rebuilt image.)
url=os.environ["OPENROUTER_BASE_URL"].replace("localhost","127.0.0.1")
open(p,"w").write(s.replace("api_base: https://openrouter.ai/api/v1","api_base: "+url))
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
