// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: help-docs-v2-all-components

/**
 * Help documentation for Orcabot chat grounding.
 * This content is injected into the system prompt so Orcabot can answer
 * user questions about integrations, features, and setup steps.
 *
 * Keep in sync with frontend/src/docs/content/*.ts
 */

const MODULE_REVISION = "help-docs-v2-all-components";
console.log(`[help-docs] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

export const HELP_DOCS_GROUNDING = `
HELP DOCUMENTATION  - Use this to answer user questions about setup, integrations, and features.
When users ask "how do I..." or "help with..." questions, use this knowledge to give accurate, specific answers.

## X (Twitter) Integration
Let AI agents post tweets, search X, and monitor accounts.

Setup:
1. Create a developer account at developer.x.com (separate from regular X login).
2. Create an App in the developer portal and get the Bearer Token.
3. Paste the Bearer Token into the X block on the dashboard.
4. Wire the X block to a terminal to give the agent X tools.
5. Set a policy on the connection to control what the agent can do.

Key details:
- Requires an X Developer Account (NOT a regular X account).
- Uses an App-only Bearer Token (not OAuth like Gmail/GitHub).
- Free tier: ~100 tweets/month, limited searches. Basic tier: $100/mo for more.
- If "Unauthorized": token may be invalid or revoked  - regenerate at developer.x.com.
- If agent can't use tools: check there's a wire from X block to terminal block.

## Gmail Integration
Let AI agents read, search, and send emails through Gmail.

Setup:
1. Add a Gmail block from the integrations panel.
2. Click Connect  - redirects to Google OAuth (no API keys needed).
3. Grant permissions (read, send, modify).
4. Wire Gmail block to a terminal block.
5. Set a policy (read-only, send-restricted, full access).

Key details:
- Uses Google OAuth  - no developer account or API keys needed.
- OAuth tokens never leave the control plane  - agent never sees them.
- Policies can restrict to read-only or limit sending to specific addresses.
- If "Not Connected" after auth: try disconnect and reconnect.

## GitHub Integration
Clone repos into the workspace and give AI agents access to browse code, manage issues, and review PRs.

There is NO GitHub canvas block. GitHub is accessed two ways:

1. **Workspace sync (clone repos):** Click the GitHub icon in the workspace sidebar → authorize → pick a repo → Import.
2. **Agent tool access:** Open a terminal's integrations panel → attach GitHub → choose Read Only or Full Access.

Key details:
- Uses GitHub OAuth  - no API keys or developer accounts needed.
- Workspace sync auto-attaches GitHub to all active terminals on the dashboard.
- High-risk actions (push, merge PRs, approve PRs, delete repos) each require explicit opt-in.
- Repo access restricted at both GitHub OAuth level AND Orcabot policy level.
- Rate limit: 5,000 requests/hour for authenticated users.
- Update repo access at GitHub Settings → Applications → Orcabot.
- If agent can't see GitHub tools: check the terminal's integrations panel, not the canvas.

## Google Calendar Integration
Let AI agents view, create, and manage calendar events.

Setup:
1. Add a Calendar block from the integrations panel.
2. Click Connect  - sign in with Google OAuth.
3. Wire Calendar block to a terminal block.
4. Set policy (read-only, create events, full access).

Key details:
- Uses Google OAuth  - no API keys needed.
- Some Workspace calendars may restrict third-party event creation.

## Secrets & API Keys
Safely provide API keys to AI agents without exposing them to prompt injection.

Setup:
1. Open Secrets panel (key icon in terminal header).
2. Click Add Secret  - enter name (e.g., ANTHROPIC_API_KEY) and value.
3. Keys are encrypted and broker-protected  - agents never see raw values.
4. Built-in providers (Anthropic, OpenAI, Google) auto-route to correct domains.
5. Custom secrets need domain approval  - user gets a toast when agent tries to use one.

Key details:
- Secrets broker injects keys server-side, not as env vars.
- Agent only sees placeholder values, never real keys.
- If "API Key Not Set": check key name matches what agent expects.
- If key shows warning icon: broker protection is disabled, re-enable it.
- DON'T paste keys directly into terminal  - use the Secrets panel instead.

## Terminals & AI Agents
Run AI coding agents or plain shells in sandboxed terminals.

Agent types:
- Claude Code  - needs ANTHROPIC_API_KEY (from console.anthropic.com)
- Gemini CLI  - needs GEMINI_API_KEY (from aistudio.google.com)
- Codex  - needs OPENAI_API_KEY (from platform.openai.com)
- Plain Shell  - no API key needed

Key details:
- Each dashboard gets its own sandboxed VM.
- Turn-taking: only one user/agent can type at a time.
- Wire integration blocks to terminals to give agents access to external tools.
- Terminal won't start? VM may be booting (10-30s on first use).
- Can't type? Another user/agent may have control  - check header.

## Getting Started
1. Sign in with Google (or dev mode for local development).
2. Create a new dashboard  - this is your collaborative workspace.
3. Add a terminal block and choose an AI agent.
4. Add your API key via the Secrets panel.
5. Start chatting with your AI agent.

Dashboards are persistent documents (like Google Docs). Sandboxes (VMs) are temporary  - files in /workspace are preserved across restarts. Secrets are broker-protected  - even compromised agents can't exfiltrate keys.

## Slack Integration
Connect Slack workspaces for bidirectional messaging.

Setup:
1. Add a Slack block → Click "Connect Slack" → OAuth popup.
2. Toggle channels on to subscribe (bot must be invited to channels first  - use /invite @Orcabot).
3. Wire Slack block to a terminal.

Key details:
- OAuth-based (no API keys needed).
- Bot must be invited to channels before they appear. Channel list is paginated.
- Supports inbound and outbound messaging.

## Discord Integration
Connect Discord servers for messaging.

Setup:
1. Add a Discord block → Click "Add to Server" → OAuth popup.
2. Select Discord server, confirm bot permissions.
3. Toggle channels to subscribe. Wire to terminal.

Key details:
- OAuth-based. Bot needs permissions in target channels.
- Supports inbound and outbound messaging.

## Telegram Integration
Connect a Telegram bot for messaging.

Setup:
1. Create a bot via @BotFather on Telegram → get token.
2. Add Telegram block → paste token → Connect Bot.
3. Add bot to Telegram groups. Refresh block. Toggle chats to subscribe.
4. Wire to terminal.

Key details:
- Uses bot token (NOT OAuth). Token from @BotFather.
- Bot must be manually added to groups in Telegram app.
- If chat not appearing: click Refresh, ensure bot was added to group.

## WhatsApp Integration
Connect WhatsApp (Business API or personal).

Two modes:
1. **Business API:** Enter Meta Cloud API access token + phone number ID.
2. **Personal (QR Code):** Click "Connect via QR" → scan with WhatsApp "Linked Devices."

Key details:
- Hybrid mode: both connections can run simultaneously.
- Personal mode: phone must stay connected to internet.
- Business API credentials from Meta Developer Portal.

## Microsoft Teams Integration
Connect Microsoft Teams for messaging.

Setup options:
1. OAuth: Click "Connect with Microsoft" for outbound MCP tools (read, send, list). Does not support inbound message delivery.
2. Bot Framework credentials: Register bot in Azure Bot Service → paste App ID + App Secret. Supports both outbound tools and inbound message delivery via webhook.

Key details:
- OAuth provides auto-refreshing tokens and outbound MCP tools only.
- Bot Framework credentials enable both outbound tools and inbound webhooks. Tokens auto-refresh using the stored App Secret.
- Inbound delivery requires Bot Framework credentials with Azure Bot messaging endpoint configured.
- Wire the Teams block to a terminal to enable MCP tools.
- Available tools: teams_list_teams, teams_list_channels, teams_read_messages, teams_send_message, teams_reply_thread, teams_get_member, teams_edit_message, teams_delete_message.

## Microsoft Outlook Integration
Connect Outlook to read, search, send, and manage emails via Microsoft Graph API.

Setup: Click "Connect Microsoft Outlook" → sign in with your Microsoft account.

Key details:
- OAuth-based authentication with auto-refreshing tokens.
- No webhooks needed — LLM uses MCP tools to interact with mail.
- Wire the Outlook block to a terminal to enable MCP tools.
- Available tools: outlook_search, outlook_get, outlook_send, outlook_reply, outlook_forward, outlook_archive, outlook_delete, outlook_mark_read, outlook_mark_unread, outlook_list_folders.
- Policy controls: canRead, canSearch, canSend, canReply, canForward, canArchive, canDelete, canMarkRead.
- Sender filter: restrict which senders' emails the LLM can see.
- Send policy: restrict recipient domains for outbound emails.

## Microsoft Outlook Calendar Integration
Connect Outlook Calendar to view, create, and manage calendar events via Microsoft Graph API.

Setup: Click "Connect Outlook Calendar" → sign in with your Microsoft account.

Key details:
- OAuth-based authentication with auto-refreshing tokens.
- Wire the Outlook Calendar block to a terminal to enable MCP tools.
- Available tools: outlook_calendar_list_events, outlook_calendar_get_event, outlook_calendar_create_event, outlook_calendar_update_event, outlook_calendar_delete_event, outlook_calendar_list_calendars, outlook_calendar_search_events.
- Policy controls: canRead, canCreate, canUpdate, canDelete.

## Matrix Integration (Early Stage)
Connect to Matrix decentralized chat.

Setup: Get access token from Element (Settings → Help & About) → enter homeserver URL + token.

Key details:
- Outbound messaging works. Inbound coming soon.
- Room list is read-only. Only joined rooms appear.

## Google Chat Integration (Early Stage)
Connect to Google Chat spaces.

Setup: Get OAuth2 access token from Google Cloud Console → paste.

Key details:
- Outbound messaging works. Inbound coming soon.
- Space list is read-only. Bot must be added to spaces via admin UI.

## Google Sheets Integration
Browse and view spreadsheet data.

Setup:
1. Add Sheets block → Connect Sheets (Google OAuth).
2. Select a spreadsheet from picker.
3. View data (first 100 rows). Switch between sheets.
4. Wire to terminal for agent access.

## Google Forms Integration
View and analyze form responses.

Setup:
1. Add Forms block → Connect Forms (Google OAuth).
2. Select a form. Browse responses in two-pane view.
3. Wire to terminal for agent access.

## Google Contacts Integration
Search and view contacts.

Setup:
1. Add Contacts block → Connect Contacts (Google OAuth).
2. Click "Enable Sync" to import contacts.
3. Search by name, click for details. Wire to terminal.

## Browser Block
Built-in Chromium browser running in the sandbox.

- Starts automatically when block is visible.
- Enter URL to navigate. Use for testing localhost servers.
- Streams via VNC (remote desktop). No clipboard sync between host and browser.
- Multiple browser blocks share one Chromium instance.

## Workspace & File Explorer
Browse sandbox files and connect cloud storage.

- Shows /workspace file tree when terminal is active.
- Connect GitHub, Google Drive, Box, or OneDrive to sync files.
- GitHub: use workspace sidebar GitHub icon → pick repo → Import.
- Files sync on demand (click sync button).

## Notes
Sticky notes with markdown support. 5 colors, 4 font sizes. Click to edit, click outside to render markdown. Connectable to other blocks.

## Todo Lists
Task lists with checkboxes. Add items, check off, delete. Progress badge shows completion (e.g., "3/5"). Connectable  - upstream blocks can add items.

## Link Blocks
Rich URL bookmarks with favicon, title, description. Click to open in new tab.

## Recipes (Workflows)
Multi-step workflows with status tracking. Steps show pending/running/completed/failed. Click "Run Recipe" to execute.

## Schedules (Cron)
Run commands on schedule. Simple mode (every N min/hours) or advanced (full cron). ON/OFF toggle, "Run Now" button, execution history.

## Decision Blocks
Conditional routing (diamond shape). Operators: Contains, Equals, >, <. Routes data to YES/NO output paths.

## Prompt Blocks
Text input that sends to connected blocks. Supports [input] placeholder for data piping, voice input (ASR), "New session" checkbox. Click Go or Cmd+Enter to send.
`;

