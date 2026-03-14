// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const discordDoc: DocEntry = {
  title: "Discord Integration",
  slug: "discord",
  category: "messaging",
  icon: "discord",
  summary: "Connect Discord servers so your AI agents can read and send messages in channels.",
  quickHelp: [
    "Add a Discord block to your dashboard from the integrations panel.",
    "Click 'Add to Server'  - select which Discord server to add the Orcabot bot to.",
    "Toggle channels on to subscribe  - the agent receives messages from those channels.",
    "Wire the Discord block to a terminal block.",
    "The agent can read inbound messages and send replies to subscribed channels.",
  ],
  tags: ["discord", "messaging", "chat", "channels", "bot", "server", "guild"],
  body: `## What You Need

**A Discord Server** where you have permission to add bots (Manage Server permission).

## Setup Steps

### 1. Add the Discord Block
From the integrations panel, add a Discord block to your dashboard.

### 2. Add Bot to Server
Click **Add to Server**. A popup opens where you select which Discord server to add the Orcabot bot to and confirm permissions.

### 3. Subscribe to Channels
After connecting, all channels the bot can access are listed. Toggle channels to subscribe  - the agent will receive inbound messages from those channels.

### 4. Wire to a Terminal
Draw a connection from the Discord block to a terminal block.

## What Your Agent Can Do

- **Receive messages** from subscribed channels
- **Send messages** to channels the bot has access to
- **Read channel info**  - name, topic

## Troubleshooting

### Bot Can't See Certain Channels
- The bot needs explicit permission in those channels. Check Discord server settings → Roles → Orcabot bot role → Channel permissions.

### Can't Add Bot
- You need "Manage Server" permission in the Discord server.`,
};
