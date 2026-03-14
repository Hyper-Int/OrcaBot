// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const telegramDoc: DocEntry = {
  title: "Telegram Integration",
  slug: "telegram",
  category: "messaging",
  icon: "telegram",
  summary: "Connect a Telegram bot so your AI agents can exchange messages in groups and chats.",
  quickHelp: [
    "Create a bot via @BotFather on Telegram  - you'll get a bot token.",
    "Add a Telegram block to your dashboard and paste the bot token.",
    "Click 'Connect Bot' to verify the token.",
    "Add the bot to your Telegram group/channel, then refresh the block to see chats.",
    "Toggle chats on to subscribe, then wire to a terminal block.",
  ],
  tags: ["telegram", "messaging", "chat", "bot", "botfather", "token"],
  body: `## What You Need

**A Telegram Bot Token** from @BotFather. This is different from Slack/Discord which use OAuth  - Telegram requires a bot token that you paste directly.

## Setup Steps

### 1. Create a Bot
Open Telegram and chat with **@BotFather**:
1. Send \`/newbot\`
2. Choose a name and username for your bot
3. BotFather gives you a token (a long string like \`123456:ABC-DEF...\`)
4. Copy the token

### 2. Add the Telegram Block
From the integrations panel, add a Telegram block to your dashboard.

### 3. Paste the Token
Enter the bot token in the password field and click **Connect Bot**. The block will verify your token.

### 4. Add Bot to Groups
In the Telegram app, add your bot to any group or channel where you want it to operate. Then click **Refresh** in the block  - the chat will appear in the list.

### 5. Subscribe to Chats
Toggle on the chats you want the agent to receive messages from.

### 6. Wire to a Terminal
Draw a connection from the Telegram block to a terminal block.

## What Your Agent Can Do

- **Receive messages** from subscribed groups and chats
- **Send messages** to groups and private chats the bot is in
- **Read chat info**  - group name, type (group, supergroup, private, channel)

## Troubleshooting

### Chat Not Appearing After Adding Bot
- Click **Refresh** in the block. New chats only appear after a refresh.
- Make sure the bot was actually added to the group (check in Telegram).

### Invalid Token
- Tokens look like \`123456789:ABCdefGHIjklMNOpqrsTUVwxyz\`. Make sure you copied the full string from @BotFather.
- If the token was revoked, create a new one with \`/token\` in @BotFather.`,
};
