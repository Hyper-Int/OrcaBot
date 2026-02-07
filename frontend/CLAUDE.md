# CLAUDE.md

## Purpose

This repository implements the **frontend experience layer** for a Agentic AI Coding Agent Orchestration figma like dashboard on the Web.

It is responsible for:
- authentication UI
- dashboard selection and navigation
- multiplayer dashboard experience (Figma-like board)
- terminal rendering (xterm.js)
- turn-taking and agent interaction UX
- file explorer UI
- environment variables / secrets management UI
- TTS voice configuration
- domain approval workflow for custom secrets

It does **not**:
- run terminals or agents
- enforce turn-taking rules
- orchestrate workflows
- manage durable state
- make execution decisions
- store secrets locally (all in control plane, encrypted)

Claude should act as a **product- and UX-oriented assistant**, helping build clear, predictable interfaces that accurately reflect backend state.

---

## Coding Practices (MANDATORY)

### Revision Markers
**ALWAYS** add revision markers when modifying code. This eliminates "did you deploy?" debugging.

1. **At top of modified file:**
   ```typescript
   // REVISION: feature-v1-desc
   const MODULE_REVISION = "feature-v1-desc";
   console.log(`[module] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
   ```

2. **For page components:** Log on module load (outside component function)

3. **For API functions:** Log when called with timestamp: `console.log(\`[fn] called at ${new Date().toISOString()}\`)`

Never speculate about deployment - add logs that prove what version is running.

---

## Related Repos

  Cloudflare control plane middle layer reference: ../controlplane
  - See CLAUDE.md for architecture

  Backend sandbox reference: ../sandbox
  - See CLAUDE.md for architecture

---

## Page flow (non-negotiable)

### 1. Splash / Login
**Goal:** establish user identity

UI:
- Product name + short value prop
- "Continue with Google"
- "Dev mode login" (clearly labeled)

Rules:
- Dev mode bypasses Google OAuth only
- Dev mode must not change any other system behavior
- No dashboards, terminals, or orchestration logic here

---

### 2. Dashboard Picker
**Goal:** choose what to work on

UI sections:
- **New dashboard**
  - Blank
  - From template
- **Saved dashboards**
  - Owned
  - Shared
  - Recently opened
- **Templates**
  - Agentic coding
  - Automation / orchestration
  - Enterprise / tools-heavy setups

Rules:
- Loading a dashboard does **not** start a sandbox
- This page talks only to the control plane (Cloudflare APIs)

---

### 3. Dashboard (main experience)
**Goal:** shared workspace + optional execution

Dashboards are **documents**, not sessions.

---

## Dashboard mental model

> **A dashboard is a collaborative board.
Execution is optional and attachable.**

Think: Figma + terminals.

---

## Dashboard layout

- Large or infinite canvas
- Pan / zoom
- Grid snapping optional

Board objects (persisted):
- Sticky notes
- Todo lists
- Text blocks
- Links (URLs)
- Recipe / workflow blocks
- Execution buttons
- **Terminal blocks**

All non-terminal blocks represent **structure and intent only**.

---

## Terminal blocks (xterm.js)

Terminal rendering uses [xterm.js](https://xtermjs.org/) — a widely used web terminal emulator.

A terminal is a **block on the board**, not a page.

Creating a terminal:
- User clicks "+ Terminal"
- UI prompts: new sandbox or attach to existing session
- Control plane creates session
- Fly Machine boots
- Terminal connects via WebSocket

Terminal block UI:
- xterm.js terminal
- Header showing:
  - terminal name
  - controller
  - agent status
- Controls:
  - request control
  - stop / pause agent
  - close terminal

Multiple terminal blocks may exist on one dashboard.

---

## Turn-taking UX (critical rules)

- Multiple users may **view** a terminal
- Exactly one user or agent may **type**
- Input authority is explicit and visible

Frontend responsibilities:
- Disable typing unless user is controller
- Show who has control
- Show when agent is running
- Reflect backend events exactly
- Never assume local control is valid

Backend enforcement is authoritative.

---

## Agent UX model

- Agents run remotely inside sandboxes
- Agents may temporarily control terminals
- While agent is running:
  - humans observe
  - typing is disabled
  - Users can:
    - stop
    - pause
    - resume

Frontend displays:
- agent state: running / paused / stopped
- clear intervention controls
- agent output via terminals only

Frontend does NOT:
- decide when agents run
- infer agent state
- bypass backend controls

---

## Secrets & Environment Variables

The frontend provides UI for managing secrets and environment variables.

### Environment Variables Panel (TerminalBlock)
- Lists secrets (broker-protected) and regular env vars
- Shows protection status with visual indicators (lock = protected, warning = exposed)
- Edit/delete functionality

### Domain Approval Flow
- Displays pending approval requests (polled every 30s)
- Approval dialog with header configuration (header name, format)
- Warning about security implications
- Approve/Deny actions

### Protection Toggle
- Dialog explaining risks when disabling broker protection
- Requires explicit confirmation
- Lists troubleshooting steps before disabling

### TTS Configuration
- Voice selection dropdown per provider
- Live status display from WebSocket events

Frontend does NOT:
- Store secrets locally (all in control plane, encrypted)
- Make decisions about which domains are safe
- Decrypt secrets client-side (display only)

---

## Session & recovery UX

- Dashboards can exist with **no active sandboxes**
- Sandboxes may disappear at any time
- Frontend must handle:
  - terminal disconnects
  - session restarts
  - sandbox recreation

Recovery model:
- context (files, notes, recipes) is restored
- execution restarts cleanly
- UI must communicate this clearly

Never promise "process continuity".

---

## API usage philosophy

- Treat APIs as authoritative
- Expect reconnects and restarts
- Do not cache execution state locally
- Prefer explicit user actions over hidden automation

---

## Responsibility boundaries (non-negotiable)

### Frontend owns
- Layout and rendering
- Real-time collaboration UX
- Presence indicators
- Terminal rendering
- Turn-taking UI
- Agent controls UI
- File explorer UI
- Secrets management UI
- Navigation and error states

### Frontend does NOT own
- Execution logic
- Turn-taking enforcement
- Agent lifecycle
- Orchestration
- Scheduling
- Persistence decisions
- Secret storage or encryption

If correctness is involved, it belongs in the backend.

---

## What Claude should NOT do in this repo

- Do not add orchestration logic
- Do not simulate backend behavior
- Do not store durable state locally
- Do not assume a sandbox is alive
- Do not invent execution shortcuts
- Do not bypass turn-taking rules

If something requires backend changes, call it out explicitly.

---

## Guiding principle

> **The frontend explains and visualizes the system — it never *becomes* the system.**

If unsure:
- "How it looks or feels" → frontend
- "What happens or when" → backend

---

## Mental model for users

- Dashboards = shared workspaces
- Boards = shared context
- Terminals = shared machines
- Agents = collaborators
- Templates = starting points
- Sandboxes = temporary engines

---

## Known limitations / TODOs

(No current TODOs)

---

## Success criteria

This repo is correct if:
- Users understand who is in control
- Collaboration feels natural
- Disconnections are survivable
- Autonomy is visible and interruptible
- The UI never lies about system state
