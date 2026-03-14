// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const whatsappDoc: DocEntry = {
  title: "WhatsApp Integration",
  slug: "whatsapp",
  category: "messaging",
  icon: "whatsapp",
  summary: "Connect WhatsApp (Business API or personal) so your AI agents can send and receive messages.",
  quickHelp: [
    "Add a WhatsApp block to your dashboard from the integrations panel.",
    "Choose your connection mode: Business API (access token + phone ID) or Personal (QR code scan).",
    "For Business: enter your Meta Cloud API credentials. For Personal: scan the QR code with your phone.",
    "Wire the WhatsApp block to a terminal block.",
    "The agent can send and receive WhatsApp messages.",
  ],
  tags: ["whatsapp", "messaging", "chat", "business api", "qr code", "personal", "meta"],
  body: `## Two Connection Modes

WhatsApp supports two ways to connect:

### Business API (Official)
For businesses using the WhatsApp Cloud API from Meta.
- Requires a Meta developer account and WhatsApp Business API access
- Enter your **Access Token** and **Phone Number ID**
- Supports all WhatsApp Business features

### Personal / Bridge (QR Code)
For personal WhatsApp accounts (development/testing).
- Scan a QR code with your phone (like WhatsApp Web)
- Uses a bridge connection
- Great for prototyping and testing

**Hybrid Mode:** Both connections can run simultaneously for a richer experience.

## Setup Steps

### Business API
1. Get credentials from the [Meta Developer Portal](https://developers.facebook.com)
2. Add a WhatsApp block to your dashboard
3. Enter your **Access Token** and **Phone Number ID**
4. Click **Connect**

### Personal (QR Code)
1. Add a WhatsApp block to your dashboard
2. Click **Connect via QR**
3. Open WhatsApp on your phone → Settings → Linked Devices → Link a Device
4. Scan the QR code shown in the block
5. Wait for connection (the block shows connection status)

### Wire to a Terminal
Draw a connection from the WhatsApp block to a terminal block.

## What Your Agent Can Do

- **Receive messages** from WhatsApp conversations
- **Send messages** to contacts and groups
- **Filter messages**  - toggle between "OrcaBot chat" (filtered) and "Everyone" (all messages)

## Troubleshooting

### QR Code Not Working
- The QR code expires after a short time. If it fails, click **Retry** to generate a new one.
- Make sure you're scanning with WhatsApp's "Link a Device" scanner, not a generic QR scanner.
- If you see "rate limiting" warnings after multiple attempts, wait a few minutes before retrying.

### Business API "Unauthorized"
- Check that your Access Token is valid and not expired.
- Verify the Phone Number ID matches a number registered in your Meta Business account.

### Messages Not Coming Through
- Check that the WhatsApp block is wired to a terminal.
- For Personal mode, make sure the phone stays connected to the internet (like WhatsApp Web).`,
};
