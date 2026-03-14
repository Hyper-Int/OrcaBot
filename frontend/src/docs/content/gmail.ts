// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const gmailDoc: DocEntry = {
  title: "Gmail Integration",
  slug: "gmail",
  category: "google",
  icon: "gmail",
  summary: "Let your AI agents read, search, and send emails through your Gmail account.",
  quickHelp: [
    "Add a Gmail block to your dashboard from the integrations panel.",
    "Click 'Connect'  - you'll be redirected to Google to authorize access.",
    "Grant the requested permissions (read, send, modify emails).",
    "Draw a wire from the Gmail block to a terminal block.",
    "Set a policy to control what the agent can do (read-only, send to specific people, etc.).",
  ],
  tags: ["gmail", "email", "google", "oauth", "send", "read", "search"],
  body: `## What You Need

**A Google Account**  - any Gmail address works. You'll authorize Orcabot via Google's standard OAuth flow. No API keys or developer accounts needed.

## Setup Steps

### 1. Add the Gmail Block
From the integrations panel (or ask Orcabot in chat), add a Gmail block to your dashboard.

### 2. Connect Your Account
Click the **Connect** button on the Gmail block. You'll be redirected to Google's authorization page.

### 3. Grant Permissions
Google will ask you to approve access. Orcabot requests:
- Read your emails
- Send emails on your behalf
- Modify labels and archive/trash

You can revoke access anytime from your Google account settings.

### 4. Wire to a Terminal
Draw a connection from the Gmail block to any terminal block. This gives the agent in that terminal access to your email.

### 5. Set a Policy (Recommended)
Click the edge between the blocks to configure what the agent can do:
- **Read-only**  - search and read emails, but can't send or modify
- **Send restricted**  - can only send to specific email addresses
- **Full access**  - search, read, send, archive, label

## What Your Agent Can Do

Once wired, the agent can:
- **Search emails**  - find messages by sender, subject, date, labels
- **Read emails**  - view full email content and attachments
- **Send emails**  - compose and send new emails
- **Reply to emails**  - respond to existing threads
- **Manage labels**  - add/remove labels, archive, mark read/unread
- **Trash emails**  - move messages to trash

## Security

- Your Google OAuth token **never leaves the control plane**  - the AI agent in the sandbox never sees it.
- All API calls go through the control plane gateway, which enforces your policy before making the Gmail API call.
- Responses are filtered based on your policy before the agent sees them.

## Troubleshooting

### "Not Connected" After Authorization
- Try disconnecting and reconnecting. The OAuth token may have expired.
- Make sure pop-ups are not blocked during the authorization flow.

### Agent Can't See Gmail Tools
- Check that there's a wire between the Gmail block and the terminal block.
- The terminal may need to be restarted after connecting a new integration.

### "Permission Denied" on Certain Actions
- Check the policy on the connection. It may restrict sending or modifying emails.
- Some Google Workspace accounts have admin restrictions that limit third-party app access.`,
};
