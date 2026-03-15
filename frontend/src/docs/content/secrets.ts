// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const secretsDoc: DocEntry = {
  title: "Secrets & API Keys",
  slug: "secrets",
  category: "agents",
  icon: "key",
  summary: "Safely provide API keys to your AI agents without exposing them to prompt injection.",
  quickHelp: [
    "Open the Secrets panel in any terminal block (key icon in the header).",
    "Click 'Add Secret' and enter the key name (e.g., ANTHROPIC_API_KEY) and value.",
    "The key is encrypted and stored securely  - AI agents never see the raw value.",
    "Broker-protected keys are injected server-side when the agent makes API calls.",
    "Custom secrets may need domain approval  - you'll see a toast when the agent tries to use one.",
  ],
  tags: ["secrets", "api keys", "environment variables", "broker", "security", "encryption"],
  body: `## How Secrets Work

Orcabot has a **secrets broker** that protects your API keys from being read by AI agents. This is critical because AI agents could be tricked by prompt injection into sending your keys to an attacker.

### The Problem
If you paste an API key directly into a terminal, the AI agent can see it in the terminal output and could be manipulated into exfiltrating it.

### The Solution
The secrets broker:
1. **Stores keys encrypted** in the control plane (never in the sandbox)
2. **Injects keys server-side** when the agent makes API calls to approved domains
3. **Redacts key values** from terminal output so they never appear on screen
4. The AI agent only sees a placeholder value, never the real key

## Adding Secrets

### Via the Secrets Panel
1. Click the **key icon** in any terminal block header to open the Secrets panel.
2. Click **Add Secret**.
3. Enter the key name (e.g., \`ANTHROPIC_API_KEY\`, \`OPENAI_API_KEY\`).
4. Paste the key value.
5. Choose whether to enable broker protection (recommended).

### Via Orcabot Chat
Ask Orcabot: "Add my Anthropic API key" and it will guide you through the process.

### Built-in Providers
Keys for known providers (Anthropic, OpenAI, Google, ElevenLabs, etc.) are automatically routed to the correct API domains. No extra configuration needed.

### Custom Secrets
For custom API keys, you'll need to approve which domains the key can be sent to:
1. When the agent tries to use a custom secret, you'll see an **approval toast**.
2. Review the domain and choose:
   - **Approve**  - allow the key to be sent to that domain
   - **Deny**  - block the request
3. You can configure the header format (e.g., \`Authorization: Bearer <key>\`).

## Domain Approval (Custom Secrets)

Custom secrets require explicit domain approval. When an AI agent tries to send a custom key to an API:
1. The request is **held** (not sent).
2. A toast notification appears asking for your approval.
3. You choose the header name and format.
4. Approved domains are remembered for that secret.

## Network Egress Proxy

Orcabot also has a network-level egress proxy that intercepts all outbound requests:
- Known safe domains (package registries, CDNs, LLM APIs) are allowed automatically.
- Unknown domains trigger an approval dialog — you can allow once, always allow, or deny.
- Enabled globally by the instance operator via \`EGRESS_PROXY_ENABLED=true\` on the sandbox VM.

## Troubleshooting

### Agent Says "API Key Not Set"
- Check the Secrets panel  - make sure the key is listed.
- The key name must match what the agent expects (e.g., \`ANTHROPIC_API_KEY\` not \`anthropic_key\`).
- Try restarting the terminal after adding a new secret.

### Key Shows as "Exposed" (Warning Icon)
- The key has broker protection disabled. This means the AI agent can read the raw value.
- Re-enable broker protection unless you have a specific reason not to.

### Custom Secret Not Working
- Check that the domain is approved in the Secrets panel.
- Verify the header format matches what the API expects.`,
};
