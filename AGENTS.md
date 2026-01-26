# AGENTS.md

This repo is a monorepo for Orcabot. Each app has its own `CLAUDE.md` with deeper, app-specific guidance.

## Structure
- `frontend` — Next.js dashboard UI
- `controlplane` — Cloudflare Worker control plane
- `sandbox` — Go sandbox server

## App Guides
- Frontend: `frontend/CLAUDE.md`
- Control plane: `controlplane/CLAUDE.md`
- Sandbox: `sandbox/CLAUDE.md`

## Deploy (Prod)
```
cd sandbox && make deploy && cd ../controlplane && wrangler deploy -c wrangler.production.toml && cd ../frontend && npm run workers:deploy && cd ..
```

## Running Locally
Sandbox:
```
docker run --rm -it \
    -p 8080:8080 \
    --cpus=2 --memory=4g \
    -e SANDBOX_INTERNAL_TOKEN=... \
    -e CONTROLPLANE_URL=http://localhost:8787 \
    -e INTERNAL_API_TOKEN=... \
    -e ALLOWED_ORIGINS=http://localhost:8788 \
    -v orcabot-sandbox-workspace:/workspace \
    orcabot-sandbox
```

Control plane:
```
npm run dev
```

Frontend:
```
npx wrangler dev
```

## Auth + Control Plane Notes
- Frontend never talks directly to sandbox; all traffic goes through the control plane.
- Cloudflare control plane uses dev auth via headers/query params when `DEV_AUTH_ENABLED=true`.
- Internal sandbox auth uses `SANDBOX_INTERNAL_TOKEN` (do not reuse Cloudflare API keys).

## OAuth Integrations (Drive/GitHub)
- Control plane provides connect + callback endpoints:
  - `/integrations/google/drive/connect`
  - `/integrations/google/drive/callback`
  - `/integrations/github/connect`
  - `/integrations/github/callback`
- Required env vars on Cloudflare:
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
  - `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
  - `OAUTH_REDIRECT_BASE` (optional; defaults to request origin)
- D1 tables: `oauth_states`, `user_integrations` (run `/init-db` after schema updates).

## Sandbox Behavior
- Sandbox sessions use a shared `/workspace` by default (no per-session folder).
- PTY cwd is set to the session workspace.

## Browser Block
- Browser block checks embeddability via control plane `/embed-check`.
- If embedding is blocked, UI collapses to a small “open in new tab” panel.

## Subagents
- Saved subagents persist per user in control plane.
- Catalog lives in `frontend/src/data/claude-subagents.json`.

## Workspace Sidebar
- File tree is populated via control plane proxy of sandbox filesystem APIs.
- Delete support only; edits to follow.
