# OrcaBot Code Review Findings

Generated: 2026-01-15

## Prioritized Issue List

### Priority 1: CRITICAL - Security & Data Safety Issues

| # | Issue | Component | File | Fix Branch |
|---|-------|-----------|------|------------|
| 1 | XSS risk: iframe sandbox allows scripts + same-origin together | Frontend | `frontend/src/components/blocks/BrowserBlock.tsx:179-185` | `fix/browser-block-xss` |
| 2 | Race condition in session creation (INSERT OR IGNORE) | Controlplane | `controlplane/src/sessions/handler.ts:109-132` | `fix/session-creation-race` |
| 3 | ProxyUserID bypass - empty string instead of rejection | Controlplane | `controlplane/src/index.ts:584-586` | `fix/proxy-userid-auth` |
| 4 | Global recipes accessible to any authenticated user | Controlplane | `controlplane/src/recipes/handler.ts:57-59` | `fix/recipe-access-control` |
| 5 | Overly permissive CORS (wildcard origin) | Controlplane | `controlplane/src/index.ts:24-28` | `fix/cors-policy` |

### Priority 2: HIGH - Bugs & Resource Leaks

| # | Issue | Component | File | Fix Branch |
|---|-------|-----------|------|------------|
| 6 | PTY.Done() goroutine leak - new goroutine per call | Sandbox | `sandbox/internal/pty/pty.go:152-162` | `fix/pty-done-goroutine-leak` |
| 7 | Hub.readLoop() goroutine leak on PTY errors | Sandbox | `sandbox/internal/pty/hub.go:122-140` | `fix/hub-readloop-leak` |
| 8 | Memory leak in useTerminal hook cleanup | Frontend | `frontend/src/hooks/useTerminal.ts:79-135` | `fix/terminal-hook-cleanup` |
| 9 | Blob handling missing error catch in WebSocket | Frontend | `frontend/src/lib/ws/BaseWebSocketManager.ts:218-222` | `fix/websocket-blob-error` |
| 10 | Durable Object initialization race condition | Controlplane | `controlplane/src/dashboards/DurableObject.ts:30-49` | `fix/durable-object-init` |

### Priority 3: MEDIUM - Code Quality & Error Handling

| # | Issue | Component | File | Fix Branch |
|---|-------|-----------|------|------------|
| 11 | JSON marshal errors silently ignored | Sandbox | `sandbox/internal/pty/hub.go:388,404,414` | `fix/json-marshal-errors` |
| 12 | Missing error handling in Manager.Shutdown() | Sandbox | `sandbox/internal/sessions/manager.go:107-126` | `fix/manager-shutdown-errors` |
| 13 | Missing validation on JSON fields in recipes | Controlplane | `controlplane/src/recipes/handler.ts:310,410` | `fix/recipe-json-validation` |
| 14 | No Error Boundary for TerminalBlock | Frontend | `frontend/src/components/blocks/TerminalBlock.tsx` | `fix/terminal-error-boundary` |
| 15 | WriteMessage errors not logged in WebSocket client | Sandbox | `sandbox/internal/ws/client.go:165-172` | `fix/ws-write-logging` |

### Priority 4: LOW - Performance & Code Smells

| # | Issue | Component | File | Fix Branch |
|---|-------|-----------|------|------------|
| 16 | N+1 query pattern in getDashboard (5 sequential queries) | Controlplane | `controlplane/src/dashboards/handler.ts:90-134` | `fix/dashboard-n-plus-one` |
| 17 | itemsToNodes not memoized causes re-renders | Frontend | `frontend/src/components/canvas/Canvas.tsx:49-99` | `fix/canvas-memoization` |
| 18 | Duplicate debounce implementation | Frontend | `frontend/src/app/(app)/dashboards/[id]/page.tsx:122-142` | `fix/debounce-dedup` |
| 19 | Complex nested state in TerminalBlock (10+ useState) | Frontend | `frontend/src/components/blocks/TerminalBlock.tsx:101-200` | `fix/terminal-state-refactor` |
| 20 | Inconsistent error response formats | Controlplane | Multiple files | `fix/error-response-format` |

### Priority 5: TEST COVERAGE GAPS (for future sprints)

| Area | Coverage | Priority Files |
|------|----------|----------------|
| Frontend API Client | 0% | `src/lib/api/client.ts`, `src/lib/api/cloudflare/*.ts` |
| Frontend WebSocket | 0% | `src/lib/ws/*.ts` |
| Frontend Components | ~2% | All blocks except TerminalBlock |
| Controlplane OAuth | 0% | `src/integrations/handler.ts` |
| Controlplane Subagents | 0% | `src/subagents/handler.ts` |
| Sandbox Auth | 0% | `internal/auth/auth.go` |
| Sandbox WS Client | 0% | `internal/ws/client.go` |

---

## Detailed Issue Descriptions

### Issue 1: Browser Block XSS Vulnerability

**Location:** `frontend/src/components/blocks/BrowserBlock.tsx:179-185`

The iframe sandbox attribute uses `allow-scripts allow-same-origin` together, which allows the embedded page to:
- Execute JavaScript
- Access cookies and localStorage of the parent domain
- Potentially exfiltrate user data

**Fix:** Remove `allow-same-origin` or implement Content Security Policy headers.

### Issue 2: Session Creation Race Condition

**Location:** `controlplane/src/sessions/handler.ts:109-132`

Multiple concurrent requests can pass `INSERT OR IGNORE` and incorrectly handle sandbox creation. This can lead to duplicate sessions or orphaned records.

**Fix:** Use database transactions or distributed locking.

### Issue 3: ProxyUserID Authentication Bypass

**Location:** `controlplane/src/index.ts:584-586`

Non-owners get an empty string proxy user ID instead of rejection, which bypasses audit logging.

**Fix:** Return 403 Forbidden for non-owners instead of degrading to empty string.

### Issue 4: Global Recipe Access Control

**Location:** `controlplane/src/recipes/handler.ts:57-59`

Recipes without `dashboard_id` are accessible to any authenticated user, creating implicit public recipes without ownership model.

**Fix:** Either enforce `dashboard_id` requirement or add owner_user_id field.

### Issue 5: Overly Permissive CORS

**Location:** `controlplane/src/index.ts:24-28`

Wildcard CORS origin (`*`) with dev-auth headers allows any website to impersonate users.

**Fix:** Restrict to specific origins; validate against allowlist.

### Issue 6: PTY.Done() Goroutine Leak

**Location:** `sandbox/internal/pty/pty.go:152-162`

Creates new goroutine every time `Done()` is called. If returned channel isn't consumed, goroutine blocks forever.

**Fix:** Cache the done channel using `sync.Once`.

### Issue 7: Hub.readLoop() Goroutine Leak

**Location:** `sandbox/internal/pty/hub.go:122-140`

When PTY read errors occur, readLoop exits without signaling the main hub loop, leaving resources uncleaned.

**Fix:** Use WaitGroup or Context to coordinate cleanup.

### Issue 8: useTerminal Hook Memory Leak

**Location:** `frontend/src/hooks/useTerminal.ts:79-135`

If component unmounts while WebSocket is connecting, subscriptions may remain active due to sequential unsubscribe calls.

**Fix:** Use try-finally pattern for cleanup functions.

### Issue 9: WebSocket Blob Error Handling

**Location:** `frontend/src/lib/ws/BaseWebSocketManager.ts:218-222`

Blob-to-ArrayBuffer conversion doesn't catch promise rejections, causing silent message loss.

**Fix:** Add `.catch()` handler with error logging.

### Issue 10: Durable Object Initialization Race

**Location:** `controlplane/src/dashboards/DurableObject.ts:30-49`

Constructor uses `blockConcurrencyWhile` but returns synchronously. Early requests may operate on uninitialized state.

**Fix:** Track initialization promise and await in fetch().

---

## Completed Fixes

All 10 issues have been addressed in separate branches. Here's a summary:

| Branch | Status | Commit |
|--------|--------|--------|
| `fix/browser-block-xss` | Complete | Removed allow-same-origin from iframe sandbox |
| `fix/session-creation-race` | Complete | Used INSERT...ON CONFLICT for atomic upsert |
| `fix/proxy-userid-auth` | Complete | Always pass authenticated user ID |
| `fix/recipe-access-control` | Complete | Required dashboardId for all recipes |
| `fix/cors-policy` | Complete | Added origin validation with ALLOWED_ORIGINS env |
| `fix/pty-done-goroutine-leak` | Complete | Cached Done() channel with sync.Once |
| `fix/hub-readloop-leak` | Complete | Added readLoopDone signal for cleanup |
| `fix/terminal-hook-cleanup` | Complete | Wrapped cleanup in try-catch |
| `fix/websocket-blob-error` | Complete | Added .catch() for Blob conversion |
| `fix/durable-object-init` | Complete | Added explicit await for initPromise |

### To review these branches:

```bash
# List all fix branches
git branch | grep fix/

# Review a specific branch
git log main..fix/browser-block-xss --oneline
git diff main..fix/browser-block-xss

# Merge a branch
git checkout main && git merge fix/browser-block-xss
```

### Recommended merge order:

1. Security fixes first (XSS, auth, CORS, recipe access)
2. Resource leak fixes (PTY, Hub)
3. Error handling fixes (cleanup, blob, init)
