// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const outlookDoc: DocEntry = {
  title: "Outlook",
  slug: "outlook",
  category: "integrations",
  icon: "📧",
  summary: "Connect Microsoft Outlook to read, search, send, and manage emails",
  quickHelp: [
    "Add an Outlook block to your dashboard.",
    "Click 'Connect Microsoft Outlook' and sign in with your Microsoft account.",
    "Wire the Outlook block to a terminal using a canvas edge.",
    "The LLM can now search, read, send, reply, forward, and manage your emails.",
    "Use policies to control what actions the LLM can perform.",
  ],
  tags: ["outlook", "email", "microsoft", "office365", "mail"],
  body: `## Setup

**A Microsoft Account** — any Outlook, Hotmail, or Microsoft 365 address works. You'll authorize Orcabot via Microsoft's standard OAuth flow. No API keys or developer accounts needed.

### 1. Add the Outlook Block
From the integrations panel, add an Outlook block to your dashboard.

### 2. Connect Your Account
Click the **Connect Microsoft Outlook** button on the Outlook block. You'll be redirected to Microsoft's authorization page to sign in with your Microsoft account.

### 3. Grant Permissions
Microsoft will ask you to approve access. Orcabot requests:
- Read your emails
- Send emails on your behalf
- Manage folders, archive, and delete

You can revoke access anytime from your Microsoft account settings at [account.microsoft.com](https://account.microsoft.com).

### 4. Wire to a Terminal
Draw a connection from the Outlook block to any terminal block. This gives the agent in that terminal access to your Outlook email.

### 5. Set a Policy (Recommended)
Click the edge between the blocks to configure what the agent can do.

## Available MCP Tools

Once wired, the following MCP tools are available to the agent:

| Tool | Description |
|------|-------------|
| \`outlook_search\` | Search emails by keyword, sender, subject, date range, or folder |
| \`outlook_get\` | Read a specific email by ID, including body and attachments |
| \`outlook_send\` | Compose and send a new email |
| \`outlook_reply\` | Reply to an existing email thread |
| \`outlook_forward\` | Forward an email to another recipient |
| \`outlook_archive\` | Move an email to the archive folder |
| \`outlook_delete\` | Delete an email (move to Deleted Items) |
| \`outlook_mark_read\` | Mark an email as read |
| \`outlook_mark_unread\` | Mark an email as unread |
| \`outlook_list_folders\` | List all mail folders in the account |

## Policy Configuration

Click the edge between the Outlook block and a terminal block to open the policy editor. Policies control exactly what the agent can do with your email.

### Action Permissions

| Policy Field | Default | Description |
|--------------|---------|-------------|
| \`canRead\` | true | Allow the agent to read email content |
| \`canSearch\` | true | Allow the agent to search emails |
| \`canSend\` | false | Allow the agent to send new emails |
| \`canReply\` | false | Allow the agent to reply to emails |
| \`canForward\` | false | Allow the agent to forward emails |
| \`canArchive\` | false | Allow the agent to archive emails |
| \`canDelete\` | false | Allow the agent to delete emails |
| \`canMarkRead\` | true | Allow the agent to mark emails as read/unread |
| \`canManageFolders\` | false | Allow the agent to list and manage mail folders |

### Filtering

- **\`senderFilter\`** — Restrict which senders the agent can see emails from. When set, search and read results are filtered to only include emails from the allowed sender addresses or domains.
- **\`sendPolicy\`** — Restrict who the agent can send emails to. Can be set to specific email addresses or domains (e.g., \`@yourcompany.com\`). Prevents the agent from emailing arbitrary recipients.

### Example Policies

**Read-only:**
- \`canRead\`: true, \`canSearch\`: true — all other actions disabled.

**Reply only (customer support):**
- \`canRead\`: true, \`canSearch\`: true, \`canReply\`: true — agent can read and reply but cannot send new emails or forward.

**Full access with send restrictions:**
- All actions enabled, \`sendPolicy\` set to \`@yourcompany.com\` — agent can do everything but only send to your company domain.

## Security

- Your Microsoft OAuth token **never leaves the control plane** — the AI agent in the sandbox never sees it.
- All API calls go through the control plane gateway, which enforces your policy before making the Microsoft Graph API call.
- Responses are filtered based on your policy before the agent sees them.

## Troubleshooting

### "Not Connected" After Authorization
- Try disconnecting and reconnecting. The OAuth token may have expired.
- Microsoft tokens expire after 1 hour; the control plane automatically refreshes them using the refresh token. If the refresh token has also expired (after 90 days of inactivity), you'll need to re-connect.
- Make sure pop-ups are not blocked during the authorization flow.

### Agent Can't See Outlook Tools
- Check that there's a wire between the Outlook block and the terminal block.
- The terminal may need to be restarted after connecting a new integration.

### "Permission Denied" on Certain Actions
- Check the policy on the connection. It may restrict sending, forwarding, or deleting emails.
- Some Microsoft 365 organizational accounts have admin restrictions that limit third-party app access. Contact your IT administrator.

### Token Refresh Failures
- If you see repeated authentication errors, disconnect the Outlook integration and re-connect by signing in again.
- Microsoft may revoke tokens if your password changed or if your admin updated security policies.`,
};
