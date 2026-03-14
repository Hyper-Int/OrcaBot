---
title: Breaking the Lethal Trifecta
date: 2026-03-12
description: How OrcaBot structurally eliminates the three-way security threat that makes AI agents dangerous.
author: Rob Macrae
coverImage: /blog/lethal_trifecta.png
coverVideo: /blog/lethal_trifecta.mp4
---

In our [last post](/blog/introducing-orcabot) we introduced OrcaBot and mentioned the Lethal Trifecta, a term coined by [Simon Willison](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/), for the combination of threats that makes AI agents genuinely dangerous. Today we'll break down what the trifecta is and how OrcaBot breaks it.

## The three legs

The lethal trifecta is the intersection of three capabilities that, when combined, create a real security risk:

1. **Access to private data**: API keys, files, OAuth tokens, emails
2. **Exposure to untrusted content**: prompt injection in emails, web pages, code, chat messages
3. **Exfiltration channels**: the ability to send data out via HTTP requests, emails, API calls

Agents need access to data to be useful, and they will inevitably encounter untrusted content as that's the nature of working with emails, Slack messages, GitHub issues, and the open web. A prompt injection buried in a pull request description or an email body is not a hypothetical; it's an everyday reality.

The trifecta requires all three legs. Break one, and you break the threat. OrcaBot breaks all three.

## Leg 1: Limit private data exposure

Most agent setups put API keys in environment variables where the LLM can trivially read them. OrcaBot never does this.

**Secrets broker**: API keys are injected server-side by a session-local broker. The LLM only sees dummy placeholder values. Even if the agent dumps every environment variable, there's nothing to steal.

**Output redaction**: Any secret value that appears in terminal output is replaced with asterisks before it reaches the WebSocket. The raw values never leave the sandbox.

**OAuth tokens stay encrypted in the DB**: When an agent calls Gmail or GitHub, the OAuth token is never sent to the sandbox. The control plane makes the API call on behalf of the agent, filters the response, and returns only what the policy allows.

**Integration gates**: Only integrations that a user has explicitly wired on the canvas (by drawing an edge from a terminal to an integration block) or intentionally connected via the menu are visible as tools. No connection = no access. An agent can't discover or call an integration it hasn't been granted.

**Session namespacing**: Two terminals in the same VM can't see each other's broker configurations or approved domains. A compromised session can't pivot laterally.

## Leg 2: Reduce the untrusted content surface

You can't stop agents from seeing untrusted content, but you can limit the blast radius.

**Boolean policy enforcement**: Access decisions use only if/else logic. No LLM judgment is involved in determining whether an action is allowed. Policy is loaded from the database, not from the request. This means prompt injection can't talk its way past a policy check.

**Response filtering**: Before the LLM sees data from Gmail, GitHub, or Drive, the control plane strips HTML, decodes base64, extracts headers, and filters by sender allowlists or repo filters. The agent works with clean, structured data - not raw API responses full of injection opportunities.

**Localhost auth**: Every PTY gets a unique `X-MCP-Secret`. A rogue process in the sandbox can't call MCP tools or fake agent events without it.

## Leg 3: Block exfiltration channels

This is where the trifecta breaks. Even if an agent is compromised via prompt injection and can read workspace files, it can't get the data out.

**Network egress proxy**: The kernel forces every outbound HTTP/HTTPS request from a terminal process to pass through a forward proxy inside the sandbox. Known domains such as package registries, git hosting, CDNs, LLM APIs are allowed by default. Everything else is held and the user is given the choice of whether it should be permitted.

**Broker domain allowlisting**: API keys are only forwarded to hardcoded provider domains. A custom secret requires the dashboard owner to explicitly approve each target domain. There's no wildcard, no "send anywhere."

**Fail-closed everywhere**: Proxy timeout means deny. Missing auth token means reject. Proxy crash means connections fail. There is no degraded mode where security is relaxed.

**Audit trail**: Every egress decision is logged before the response is returned. You can see exactly what was allowed, denied, and when.

## Advisory vs. structural security

This is the philosophical difference between OrcaBot and the advisory model used by other projects.

The **advisory approach** says: "Here are 5 principles. Configure your allowlists. Be careful with secrets. We'll warn you if something looks suspicious." Security is opt-in. A user who skips configuration, dismisses a warning, or doesn't understand the threat model runs fully exposed. The agent itself is trusted to decide what's safe.

OrcaBot takes a **structural approach**. Security is the architecture, not a setting:

- You **can't** exfiltrate a key because it was never in the environment to begin with
- You **can't** curl data to an unknown domain because the connection hangs until a human approves
- You **can't** call an integration tool because the edge wasn't drawn on the canvas
- You **can't** forge an agent event because you don't have the per-PTY MCP secret
- You **can't** see another terminal's secrets because the broker is session-namespaced

No amount of prompt injection changes these facts. They're enforced by the proxy, the broker, and the control plane and not by the LLM's judgment or the user's diligence. You don't need to understand the threat model to be protected by it.

## The result

OrcaBot gives agents full autonomy for reading email, writing code, calling APIs while structurally preventing the exfiltration that makes the lethal trifecta lethal.

Others talk about building a sandbox. We built Fort Knox.