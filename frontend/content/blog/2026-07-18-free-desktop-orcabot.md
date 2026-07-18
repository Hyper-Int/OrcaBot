---
title: Free Desktop OrcaBot
date: 2026-07-18
description: Announcing free OrcaBot desktop on macOS.
author: Rob
coverImage: /blog/free_orcabot_desktop.png
---

OrcaBot is a virtualized sandbox for securely orchestrating your AI tools.

Its secrets broker keeps credentials hidden from agents. Network egress controls help prevent data exfiltration. The tools and agents themselves run inside an isolated virtual machine.

Until now, OrcaBot has run exclusively in the cloud using Fly.io virtual machines. Those machines cost money to operate, which is why the cloud version of OrcaBot requires a subscription.

**Today, we’re introducing OrcaBot Desktop for macOS.**

OrcaBot Desktop runs the same kind of virtualized sandbox locally on your Mac using Apple’s Virtualization.framework. Because the computing happens on your own hardware, no subscription is required.

The local sandbox provides the same core isolation model as the cloud version. Agents remain confined to their virtual machine and can access only the files and services you explicitly make available to them [^1].

You can also combine OrcaBot Desktop with locally running language models to create a completely local, private agentic toolchain.

## Your local shared Workspace

Inside OrcaBot Desktop, agents work within a single shared directory:

**/workspace**

On macOS, this directory is mounted from the host using VirtioFS. It is the only part of your Mac’s filesystem that the agent can access.

Additional safeguards prevent an agent from using symbolic links to escape /workspace and reach files elsewhere on the host.

This gives you a simple workflow: drag or copy the files you want to work with into the shared workspace, while everything else on your computer remains outside the agent’s reach. Your files stay local unless you explicitly use a tool or model that sends them elsewhere.

## What works the same

Google components (Gmail/Drive/Calendar) and Microsoft (Outlook/OneDrive/Calendar) all work via PKCE (Proof Key for Code Exchange) that lets an app do OAuth securely without holding a client secret. Each sign-in is protected by a fresh, single-use secret that never leaves your machine, so a snooped login can't be replayed to hijack your account.

GitHub via the device flow. You connect GitHub by approving a short code on GitHub's own website — so you never hand the app your password, and nothing sensitive is baked into the app that could be extracted. 


## Limitations

Currently it's packaged for macOS. Support for Linux and Windows is coming soon.

Components that require inbound messaging such as Slack, Discord, WhatsApp are currently limited to OrcaBot's online dashboards.

Some services, including Box and X, require a confidential OAuth client secret. Embedding those secrets in a publicly distributed desktop application would make them vulnerable to extraction, so these integrations are not currently supported in OrcaBot Desktop.

[^1]: We challenged them to escape and none have succeeded. More on this soon.