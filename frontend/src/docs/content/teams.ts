// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const teamsDoc: DocEntry = {
  title: "Microsoft Teams Integration",
  slug: "teams",
  category: "messaging",
  icon: "teams",
  summary: "Connect Microsoft Teams to send and receive messages in Teams channels.",
  quickHelp: [
    "Add a Teams block to your dashboard.",
    "Click 'Connect with Microsoft' to sign in via OAuth (recommended), or use a manual bot token.",
    "Subscribe to channels you want the agent to monitor.",
    "Wire the Teams block to a terminal to enable MCP tools.",
    "The agent can now send, receive, read, and reply to messages in Teams channels.",
  ],
  tags: ["teams", "microsoft", "messaging", "bot", "azure", "channels", "oauth"],
  body: `## Setup Options

### Option 1: OAuth (Recommended)
Click **Connect with Microsoft** and sign in with your Microsoft account. This provides auto-refreshing tokens.

### Option 2: Manual Bot Token
1. Register a bot in [Azure Bot Service](https://portal.azure.com)
2. Copy the bot token
3. Expand "Or use manual token" and paste it

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

Subscribe to channels to receive inbound messages. When a message arrives in a subscribed channel, it's delivered to the wired terminal so the agent can respond.

## Troubleshooting

### Bot Not Seeing Channels
- The bot must be added to teams/channels via the Teams admin center.
- Only channels where the bot has been installed will appear.

### Token Expired
- OAuth tokens auto-refresh. If using manual tokens, you may need to re-paste.`,
};
