// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const googleChatDoc: DocEntry = {
  title: "Google Chat Integration",
  slug: "google-chat",
  category: "messaging",
  icon: "google-chat",
  summary: "Connect to Google Chat spaces to send messages (inbound coming soon).",
  quickHelp: [
    "Get an OAuth2 access token from Google Cloud Console.",
    "Add a Google Chat block to your dashboard.",
    "Paste the access token and click 'Connect'.",
    "Spaces you're a member of will appear in the list.",
    "Wire to a terminal  - the agent can send outbound messages. Inbound is coming soon.",
  ],
  tags: ["google chat", "messaging", "google", "spaces", "workspace"],
  body: `## What You Need

**A Google Cloud OAuth2 access token** or service account credentials with Google Chat API access.

## Current Status

- **Outbound messaging:** Working  - agents can send messages to Google Chat spaces.
- **Inbound messaging:** Coming soon.
- **Space list:** Read-only display (no subscription toggles yet).

## Setup Steps

### 1. Get an Access Token
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create or select a project with the Google Chat API enabled
3. Create OAuth2 credentials or a service account
4. Generate an access token

### 2. Add the Google Chat Block
From the integrations panel, add a Google Chat block to your dashboard.

### 3. Connect
Paste the access token and click **Connect**. Spaces you belong to will appear.

### 4. Wire to a Terminal
Draw a connection from the Google Chat block to a terminal block.

## Troubleshooting

### Spaces Not Appearing
- The bot/user must be a member of the space in Google Chat.
- Add the bot to spaces via the Google Chat admin UI.

### Token Expired
- OAuth2 access tokens expire. Generate a fresh one from Google Cloud Console.`,
};
