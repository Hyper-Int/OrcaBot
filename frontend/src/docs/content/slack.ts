// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const slackDoc: DocEntry = {
  title: "Slack Integration",
  slug: "slack",
  category: "messaging",
  icon: "slack",
  summary: "Connect Slack workspaces so your AI agents can read and send messages in channels.",
  quickHelp: [
    "Add a Slack block to your dashboard from the integrations panel.",
    "Click 'Connect Slack'  - you'll authorize the Orcabot app in your Slack workspace via OAuth.",
    "Toggle channels on to subscribe  - the agent will receive messages from those channels.",
    "Wire the Slack block to a terminal block to give the agent messaging tools.",
    "The agent can read inbound messages and send replies to subscribed channels.",
  ],
  tags: ["slack", "messaging", "chat", "channels", "webhook", "oauth"],
  body: `## What You Need

**A Slack Workspace** where you have permission to install apps. Authorization uses Slack's standard OAuth flow.

## Setup Steps

### 1. Add the Slack Block
From the integrations panel (or ask Orcabot), add a Slack block to your dashboard.

### 2. Connect Your Workspace
Click **Connect Slack**. A popup opens for Slack OAuth  - approve the Orcabot app in your workspace.

### 3. Subscribe to Channels
After connecting, the block shows all channels the bot can see. Toggle channels on to subscribe  - the agent will receive inbound messages from those channels.

**Note:** The Orcabot bot must be invited to a channel before it appears in the list. In Slack, type \`/invite @Orcabot\` in the desired channel.

### 4. Wire to a Terminal
Draw a connection from the Slack block to a terminal block. The agent gets MCP tools for reading and sending Slack messages.

## What Your Agent Can Do

- **Receive messages** from subscribed channels (inbound webhooks)
- **Send messages** to channels the bot is in
- **Read channel metadata**  - member count, topic, public/private status

## Troubleshooting

### Channel Not Appearing
- The Orcabot bot must be invited to the channel first. Use \`/invite @Orcabot\` in Slack.
- Click "Load more channels" if you have many channels (list is paginated).

### Messages Not Coming Through
- Check that the channel toggle is switched on (subscribed).
- Make sure there's a wire from the Slack block to your terminal.

### Can't Install the App
- You may need workspace admin permissions to install third-party apps.`,
};
