# CLAUDE.md

## Purpose

This repository implements the **control plane** for a terminal-first, multiplayer agentic coding platform.

It is responsible for:
- user authentication
- multiplayer dashboards (Google Docs–style)
- durable state and orchestration
- session and sandbox lifecycle coordination
- schedules, recipes, and agent workflows

It does **not** run terminals, PTYs, shells, or agents.

Claude should act as a **systems-oriented product + orchestration assistant**, helping to build:
- durable coordination logic
- clear APIs to execution sandboxes
- safe, inspectable autonomy

Claude should **not** introduce execution logic, PTYs, Docker, or Fly Machine internals into this repo.

---

## Related Repos

  Backend sandbox reference: ../sandbox
  - See CLAUDE.md for architecture
  - See api/openapi.yaml for API contract (also copied here in api/)

## High-level product model

- **Dashboards are documents** (multiplayer, persistent)
- **Sandboxes are workers** (ephemeral, disposable)
- **Execution is external** (Fly Machines)
- **Orchestration is durable** (Postgres-backed)
- **Humans and agents collaborate** through explicit state, not hidden processes

---

## System architecture overview

### Layers

Browser
├── Dashboard UI
├── Notes / todos / layout
├── Recipes & schedules
└── Terminal attachments (via sandbox URLs)
↓
Cloudflare (this repo)
├── Auth & access control
├── Durable Objects (live collaboration)
├── Orchestrator (workflows, recipes, schedules)
├── Session coordinator
├── Integration adapters (Drive, GitHub, etc.)
└── Postgres (durable state)
↓
Fly.io (execution plane – separate repo)
└── Sandbox (Go server)
    ├── PTYs
    ├── Claude Code / Codex CLI
    ├── Filesystem
    └── Reports results back

---

## Responsibility boundaries (non-negotiable)

### This repo (Cloudflare) owns **intent & coordination**
- Dashboards and multiplayer state
- Notes, todos, links, layouts
- Recipes / workflows / templates
- Agent profiles and sub-agent definitions
- Scheduling (cron / event-based)
- Session creation & teardown
- Mapping dashboards → sandbox sessions
- Durable orchestration state
- Integrations (Drive, GitHub, enterprise tools)

### This repo does NOT own
- PTYs
- Shells
- Agents as running processes
- Filesystem access
- Execution state
- Docker / VM lifecycle details

Execution is delegated.

---

## Durable Objects usage

Durable Objects are used for:
- real-time collaboration
- presence
- conflict-free UI state
- live coordination (who is viewing what)

They are **not** a database.

Rules:
- DOs hold small, hot state
- Postgres is the source of truth
- DO state can be rebuilt from Postgres at any time

---

## Persistence model

### Stored in Postgres
- Users
- Dashboards
- Dashboard items (notes, todos, layout)
- Dashboard membership & permissions
- Recipes / workflows
- Workflow execution state
- Agent profiles / templates
- Schedules
- Integration credentials (encrypted)
- Session metadata (start/end, region, status)
- Artifacts & summaries

### Not stored here
- PTY buffers
- Shell history
- Running process state
- Live agent execution

---

## Orchestration model

This repo implements a **durable orchestrator**.

Concepts:
- **Recipe**: declarative workflow definition
- **Step**: unit of work (run agent, wait, branch, notify)
- **Agent profile**: tools + prompt + policy template
- **Execution**: a specific run of a recipe
- **Artifact**: output produced by execution
- **Schedule**: time/event trigger for execution

The orchestrator:
- persists workflow state
- launches sandboxes when needed
- resumes after failure
- retries deterministically
- allows human intervention at any step

Think: **Beads / Temporal-like, domain-specific**.

---

## Session & sandbox lifecycle

- Dashboards may exist with **zero sandboxes**
- A sandbox is created only when:
  - a terminal is opened
  - a recipe step requires execution
- Each sandbox = one Fly Machine
- Sandboxes are disposable
- Recovery = recreate sandbox + continue workflow

This repo **never assumes a sandbox is alive**.

---

## Schedules & autonomy

- Schedules are durable (cron / events)
- When triggered:
  - orchestrator advances workflow
  - sandbox is launched if needed
  - results are persisted
- Humans may:
  - observe
  - pause
  - modify
  - resume

Autonomy is **inspectable and interruptible**.

---

## API philosophy

This repo exposes APIs for:
- dashboards
- recipes
- schedules
- sessions
- integrations

It does NOT expose:
- PTY APIs
- shell commands
- filesystem operations

Those belong to the sandbox repo.

---

## What Claude should NOT do in this repo

- Do not add PTY logic
- Do not run agents here
- Do not talk directly to sandboxes except via defined APIs
- Do not persist execution state
- Do not bypass Postgres with Durable Object state
- Do not introduce long-running computation in Workers

If a feature requires execution, delegate it.

---

## Guiding principle

> **This layer decides *what should happen* and *when* — never *how it executes*.**

If you’re unsure whether something belongs here or in the sandbox:
- If it’s durable, declarative, or collaborative → here
- If it’s procedural, interactive, or process-bound → sandbox

---

## Mental model

- Dashboards = shared documents
- Recipes = durable plans
- Sandboxes = disposable workers
- Agents = roles, not processes

---

## Success criteria

This repo is correct if:
- Dashboards survive restarts
- Workflows resume after failure
- Sandboxes can be killed at any time without data loss
- Humans can understand and intervene
- Execution remains isolated and replaceable
