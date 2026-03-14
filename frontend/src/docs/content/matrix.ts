// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const matrixDoc: DocEntry = {
  title: "Matrix Integration",
  slug: "matrix",
  category: "messaging",
  icon: "matrix",
  summary: "Connect to the Matrix decentralized chat protocol to send messages (inbound coming soon).",
  quickHelp: [
    "Get your access token from Element (Settings → Help & About → Access Token).",
    "Add a Matrix block to your dashboard.",
    "Enter your homeserver URL (defaults to matrix.org) and paste the access token.",
    "Click 'Connect' to verify. Joined rooms appear in the list.",
    "Wire to a terminal  - the agent can send outbound messages. Inbound is coming soon.",
  ],
  tags: ["matrix", "messaging", "decentralized", "element", "homeserver", "rooms"],
  body: `## What You Need

**A Matrix Account** with an access token. You can get this from the Element client.

## Current Status

- **Outbound messaging:** Working  - agents can send messages to Matrix rooms.
- **Inbound messaging:** Coming soon.
- **Room list:** Read-only display (no subscription toggles yet).

## Setup Steps

### 1. Get Your Access Token
1. Open [Element](https://app.element.io) (or your Matrix client)
2. Go to Settings → Help & About
3. Scroll down and copy your **Access Token**

### 2. Add the Matrix Block
From the integrations panel, add a Matrix block to your dashboard.

### 3. Enter Credentials
- **Homeserver URL:** defaults to \`https://matrix.org\`. Change if you use a different homeserver.
- **Access Token:** paste the token from Element.
- Click **Connect**.

### 4. Wire to a Terminal
Draw a connection from the Matrix block to a terminal block.

## Troubleshooting

### Rooms Not Appearing
- Only rooms you've already joined in Element/Matrix will appear.
- Join rooms in your Matrix client first, then refresh the block.

### Wrong Homeserver
- Make sure the homeserver URL matches your account. If you're on a custom homeserver, enter its full URL (e.g., \`https://matrix.mycompany.com\`).`,
};
