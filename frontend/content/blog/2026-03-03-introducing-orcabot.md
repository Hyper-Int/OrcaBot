---
title: Introducing OrcaBot
date: 2026-03-04
description: OrcaBot helps AI agents get to work in a managed sandbox.
author: Rob Macrae
coverImage: /blog/introducing_orcabot.png
---

As agents are getting more capable of autonomous work, we need better tooling to easily configure them and build the workflows where they operate. Whether it's setting up a personal assistant to manage your inbox, or a Slack based autonomous bug-fixing machine, we wanted to build a portal where you can keep them running safely and securely. This requires a sandboxed, always-on, virtual machine running in the cloud. This means focussing on the UI as much as the internals. This is an orchestration layer for all of your bots.

This is OrcaBot.

## The problem with running agents today

Agentic terminals can be difficult to set up in the environments where we need them to do the work. The extra tooling available such as skills, agents, MCPs, LSPs add an extra layer of capabilities but these configurations all need to be managed. Then once that is configured, in order to reach their full hands free potential you need to add workarounds like tmux and tailscale to keep the connection accessible and allow them auto edit permissions or to dangerously skip permissions altogether.

## It gets worse

In order to increase the capabilities of agents, some have been building OpenClaw and its clones that remove guardrails and add open high level access to sensitive data, not just on hard disks, but also in emails and other online services. The combination of access to private data, ability to communicate externally, and processing untrusted content creates the [Lethal Trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) problem.

## Our solution

The OrcaBot dashboard wraps your agent in a managed, sandboxed environment so you get full autonomy without the exposure. It's provider-agnostic running Claude Code, Codex, and Gemini CLI. One persistent, always-on dashboard, accessible from any browser, multiplayer by default. Instead of disabling guardrails, they move to the environment where they are far more robust. Every dashboard runs in a dedicated Linux VM, isolated from your machine. API keys are encrypted and kept off the VM. Outbound traffic is monitored. Integrations like Gmail or GitHub are policy-gated where hard logic defines exactly what the agent can read and do.

No tmux hacks. No dangerously-skip-permissions flags. No dropped sessions. No Mac Mini required.

OpenClaw's 5 principled approach warns, advises, and makes configurable the security.

OrcaBot is secure by default.

More on how we close the Lethal Trifecta in our next post...
