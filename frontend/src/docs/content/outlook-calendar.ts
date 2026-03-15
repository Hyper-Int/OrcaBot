// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DocEntry } from "../types";

export const outlookCalendarDoc: DocEntry = {
  title: "Outlook Calendar",
  slug: "outlook-calendar",
  category: "integrations",
  icon: "calendar",
  summary: "Connect Microsoft Outlook Calendar to view, create, and manage calendar events",
  quickHelp: [
    "Add an Outlook Calendar block to your dashboard.",
    "Click 'Connect Outlook Calendar' and sign in with your Microsoft account.",
    "Wire the Outlook Calendar block to a terminal using a canvas edge.",
    "The LLM can now list calendars, search events, create, update, and delete events.",
    "Use policies to control what actions the LLM can perform.",
  ],
  tags: ["outlook", "calendar", "microsoft", "office365", "events", "schedule", "meetings"],
  body: `## Setup

**A Microsoft Account** — any Outlook, Hotmail, or Microsoft 365 address works. You'll authorize Orcabot via Microsoft's standard OAuth flow. No API keys or developer accounts needed.

### 1. Add the Outlook Calendar Block
From the integrations panel, add an Outlook Calendar block to your dashboard.

### 2. Connect Your Account
Click the **Connect Outlook Calendar** button on the block. You'll be redirected to Microsoft's authorization page to sign in with your Microsoft account.

### 3. Grant Permissions
Microsoft will ask you to approve access. Orcabot requests:
- Read your calendar events
- Create and modify events on your behalf
- Delete events

You can revoke access anytime from your Microsoft account settings at [account.microsoft.com](https://account.microsoft.com).

### 4. Wire to a Terminal
Draw a connection from the Outlook Calendar block to any terminal block. This gives the agent in that terminal access to your Outlook Calendar.

### 5. Set a Policy (Recommended)
Click the edge between the blocks to configure what the agent can do.

## Available MCP Tools

Once wired, the following MCP tools are available to the agent:

| Tool | Description |
|------|-------------|
| \`outlook_calendar_list_events\` | List upcoming or past calendar events |
| \`outlook_calendar_get_event\` | Get details of a specific event by ID |
| \`outlook_calendar_create_event\` | Create a new calendar event with title, time, attendees |
| \`outlook_calendar_update_event\` | Update an existing event's details |
| \`outlook_calendar_delete_event\` | Delete a calendar event |
| \`outlook_calendar_list_calendars\` | List all calendars in the account |
| \`outlook_calendar_search_events\` | Search events by subject keyword and/or date range |

## Policy Configuration

Click the edge between the Outlook Calendar block and a terminal block to open the policy editor. Policies control exactly what the agent can do with your calendar.

### Action Permissions

| Policy Field | Default | Description |
|--------------|---------|-------------|
| \`canRead\` | true | Allow the agent to read calendar events |
| \`canCreate\` | false | Allow the agent to create new events |
| \`canUpdate\` | false | Allow the agent to modify existing events |
| \`canDelete\` | false | Allow the agent to delete events |

### Example Policies

**Read-only:**
- \`canRead\`: true — all other actions disabled. Agent can view events but not modify anything.

**Schedule assistant:**
- \`canRead\`: true, \`canCreate\`: true — agent can view your calendar and schedule new events, but cannot modify or delete existing ones.

**Full access:**
- All actions enabled — agent can view, create, update, and delete events.

## Security

- Your Microsoft OAuth token **never leaves the control plane** — the AI agent in the sandbox never sees it.
- All API calls go through the control plane gateway, which enforces your policy before making the Microsoft Graph API call.
- Responses are filtered based on your policy before the agent sees them.

## Troubleshooting

### "Not Connected" After Authorization
- Try disconnecting and reconnecting. The OAuth token may have expired.
- Microsoft tokens expire after 1 hour; the control plane automatically refreshes them using the refresh token. If the refresh token has also expired (after 90 days of inactivity), you'll need to re-connect.
- Make sure pop-ups are not blocked during the authorization flow.

### Agent Can't See Calendar Tools
- Check that there's a wire between the Outlook Calendar block and the terminal block.
- The terminal may need to be restarted after connecting a new integration.

### "Permission Denied" on Certain Actions
- Check the policy on the connection. It may restrict creating, updating, or deleting events.
- Some Microsoft 365 organizational accounts have admin restrictions that limit third-party app access. Contact your IT administrator.

### Token Refresh Failures
- If you see repeated authentication errors, disconnect the Outlook Calendar integration and re-connect by signing in again.
- Microsoft may revoke tokens if your password changed or if your admin updated security policies.`,
};
