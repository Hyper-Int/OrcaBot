# CLAUDE.md

## Purpose

This repository implements the **frontend experience layer** for a terminal-first, multiplayer agentic coding platform.

It is responsible for:
- authentication UI
- dashboard selection and navigation
- multiplayer dashboard experience (Figma-like board)
- terminal rendering (xterm.js)
- turn-taking and agent interaction UX
- file explorer UI

It does **not**:
- run terminals or agents
- enforce turn-taking rules
- orchestrate workflows
- manage durable state
- make execution decisions

Claude should act as a **product- and UX-oriented assistant**, helping build clear, predictable interfaces that accurately reflect backend state.

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
- “Continue with Google”
- “Dev mode login” (clearly labeled)

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

Never promise “process continuity”.

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
- Navigation and error states

### Frontend does NOT own
- Execution logic
- Turn-taking enforcement
- Agent lifecycle
- Orchestration
- Scheduling
- Persistence decisions

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
- “How it looks or feels” → frontend
- “What happens or when” → backend

---

## Mental model for users

- Dashboards = shared workspaces
- Boards = shared context
- Terminals = shared machines
- Agents = collaborators
- Templates = starting points
- Sandboxes = temporary engines

---

## Success criteria

This repo is correct if:
- Users understand who is in control
- Collaboration feels natural
- Disconnections are survivable
- Autonomy is visible and interruptible
- The UI never lies about system state
