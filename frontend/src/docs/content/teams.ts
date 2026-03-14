// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const teamsDoc: DocEntry = {
  title: "Microsoft Teams Integration",
  slug: "teams",
  category: "messaging",
  icon: "teams",
  summary: "Connect a Microsoft Teams bot to send messages to Teams channels (inbound coming soon).",
  quickHelp: [
    "Register a bot in Azure Bot Service and get the bot token.",
    "Add a Teams block to your dashboard and paste the bot token.",
    "Click 'Connect Bot' to verify.",
    "The block shows channels the bot has access to (read-only for now).",
    "Wire to a terminal  - the agent can send outbound messages. Inbound webhooks are coming soon.",
  ],
  tags: ["teams", "microsoft", "messaging", "bot", "azure", "channels"],
  body: `## What You Need

**A Microsoft Teams Bot** registered in Azure Bot Service. This is an early-stage integration.

## Current Status

- **Outbound messaging:** Working  - agents can send messages to Teams channels.
- **Inbound messaging:** Coming soon  - the agent cannot yet receive messages from Teams.
- **Channel list:** Read-only display (no subscription toggles yet).

## Setup Steps

### 1. Create a Bot in Azure
1. Go to [Azure Bot Service](https://portal.azure.com)
2. Create a new Bot registration
3. Copy the bot token from the app settings

### 2. Add the Teams Block
From the integrations panel, add a Teams block to your dashboard.

### 3. Paste the Token
Enter the bot token and click **Connect Bot**.

### 4. Wire to a Terminal
Draw a connection from the Teams block to a terminal block. The agent can send outbound messages to channels the bot has access to.

## Troubleshooting

### Bot Not Seeing Channels
- The bot must be added to teams/channels via the Teams admin center.
- Only channels where the bot has been installed will appear.`,
};
