// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const teamsDoc: DocEntry = {
  title: "Microsoft Teams Integration",
  slug: "teams",
  category: "messaging",
  icon: "teams",
  summary: "Connect Microsoft Teams to read, send, and manage messages in Teams channels.",
  quickHelp: [
    "Add a Teams block to your dashboard.",
    "Connect via OAuth (outbound tools) or Bot Framework credentials (outbound + inbound).",
    "Wire the Teams block to a terminal to enable MCP tools.",
    "For inbound messages, use Bot Framework credentials and configure the Azure Bot endpoint.",
  ],
  tags: ["teams", "microsoft", "messaging", "bot", "azure", "channels", "oauth"],
  body: `## Setup Options

### Option 1: OAuth
Click **Connect with Microsoft** and sign in with your Microsoft account. This provides auto-refreshing tokens and access to outbound MCP tools (list teams, list channels, read messages, send messages, etc.). OAuth alone does **not** support inbound message delivery — for that, use Bot Framework credentials.

### Option 2: Bot Framework Credentials (required for inbound)
1. Register a bot in [Azure Bot Service](https://portal.azure.com)
2. Copy the **App ID** and **App Secret** from the bot registration
3. Expand "Or use manual token" and paste both values
4. Subscribe to channels, then set the bot's messaging endpoint in Azure to the webhook URL shown above the channel list (one URL per bot — shared across all subscribed channels)
5. Install the bot in the team/channel via the Teams admin center

This method supports both outbound MCP tools and inbound message delivery.

## Multi-Team Accounts

If your Microsoft account belongs to multiple teams, use the team selector dropdown above the channel list to switch between teams.

## Available MCP Tools

When wired to a terminal, the agent gets access to:
- **teams_list_teams** — List your teams
- **teams_list_channels** — List channels in a team
- **teams_read_messages** — Read messages from a channel
- **teams_send_message** — Send a message to a channel
- **teams_reply_thread** — Reply to a message thread
- **teams_get_member** — Get team member info
- **teams_edit_message** — Edit a message
- **teams_delete_message** — Delete a message

## Inbound Messages

Inbound message delivery requires **Bot Framework credentials** (not OAuth). Subscribe to channels to receive inbound messages. When a message arrives in a subscribed channel, it's delivered to the wired terminal so the agent can respond.

### Webhook Setup
After subscribing to your first channel, a webhook URL appears above the channel list. Configure your Azure Bot's messaging endpoint to this URL. The same URL handles all subscribed channels. The bot must also be installed in the team/channel via the Teams admin center.

## Troubleshooting

### Bot Not Seeing Channels
- The bot must be added to teams/channels via the Teams admin center.
- Only channels where the bot has been installed will appear.

### Token Expired
- OAuth tokens auto-refresh. Bot Framework tokens auto-refresh using the stored App Secret.`,
};
