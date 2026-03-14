// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const contactsDoc: DocEntry = {
  title: "Google Contacts Integration",
  slug: "contacts",
  category: "google",
  icon: "contacts",
  summary: "Search and view your Google Contacts from the dashboard.",
  quickHelp: [
    "Add a Contacts block to your dashboard from the integrations panel.",
    "Click 'Connect Contacts'  - sign in with Google OAuth.",
    "Click 'Enable Sync' to import your contacts.",
    "Search contacts by name  - click a contact to see full details.",
    "Wire to a terminal to give agents access to your contact data.",
  ],
  tags: ["contacts", "google contacts", "people", "address book", "google", "oauth"],
  body: `## What You Need

**A Google Account** with Google Contacts. Authorization uses Google's standard OAuth flow.

## Setup Steps

### 1. Add the Contacts Block
From the integrations panel, add a Contacts block to your dashboard.

### 2. Connect Your Account
Click **Connect Contacts** and sign in with Google. Approve contact access.

### 3. Enable Sync
After connecting, click **Enable Sync** to pull your contacts into the block. This is a separate step from connecting.

### 4. Browse and Search
- Use the **search bar** to find contacts by name
- Click a contact to see full details: emails, phone numbers, organization, and notes
- The sync timestamp shows when contacts were last updated

### 5. Wire to a Terminal
Draw a connection from the Contacts block to a terminal to let agents look up contact information.

## Troubleshooting

### No Contacts Showing
- Make sure you clicked **Enable Sync** after connecting.
- Click the **Sync** button to refresh.

### Contact Missing
- Only contacts in your Google Contacts are synced. Contacts only in Gmail's autocomplete may not appear.

### "Token Revoked" Error
- Your Google authorization may have expired. Disconnect and reconnect.`,
};
