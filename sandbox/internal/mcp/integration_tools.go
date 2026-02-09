// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: integration-tools-v6-all-messaging
package mcp

import (
	"encoding/json"
	"fmt"
	"log"
	"time"
)

func init() {
	log.Printf("[mcp-tools] REVISION: integration-tools-v6-all-messaging loaded at %s", time.Now().Format(time.RFC3339))
}

// IntegrationTool represents an MCP tool definition for an integration
type IntegrationTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
	Provider    string          `json:"-"` // Internal: which integration provider
	Action      string          `json:"-"` // Internal: action to call on gateway
}

// GetToolsForProvider returns the tool definitions for a provider
func GetToolsForProvider(provider string) []IntegrationTool {
	switch provider {
	case "gmail":
		return gmailTools
	case "github":
		return githubTools
	case "google_drive":
		return driveTools
	case "google_calendar":
		return calendarTools
	case "slack":
		return slackTools
	case "discord":
		return discordTools
	case "telegram":
		return telegramTools
	case "whatsapp":
		return whatsappTools
	case "teams":
		return teamsTools
	case "matrix":
		return matrixTools
	case "google_chat":
		return googleChatTools
	default:
		return nil
	}
}

// GetProviderForTool returns the provider for a tool name
func GetProviderForTool(toolName string) string {
	for provider, tools := range allTools {
		for _, tool := range tools {
			if tool.Name == toolName {
				return provider
			}
		}
	}
	return ""
}

// GetActionForTool returns the gateway action for a tool name
func GetActionForTool(toolName string) string {
	for _, tools := range allTools {
		for _, tool := range tools {
			if tool.Name == toolName {
				return tool.Action
			}
		}
	}
	return ""
}

// IsIntegrationTool returns true if the tool is an integration tool (not browser/UI)
func IsIntegrationTool(toolName string) bool {
	return GetProviderForTool(toolName) != ""
}

// allTools maps providers to their tools
var allTools = map[string][]IntegrationTool{
	"gmail":           gmailTools,
	"github":          githubTools,
	"google_drive":    driveTools,
	"google_calendar": calendarTools,
	"slack":           slackTools,
	"discord":         discordTools,
	"telegram":        telegramTools,
	"whatsapp":        whatsappTools,
	"teams":           teamsTools,
	"matrix":          matrixTools,
	"google_chat":     googleChatTools,
}

// ============================================
// Gmail Tools
// ============================================

var gmailTools = []IntegrationTool{
	{
		Name:        "gmail_search",
		Description: "Search emails in Gmail using Gmail query syntax",
		Provider:    "gmail",
		Action:      "gmail.search",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"query": {
					"type": "string",
					"description": "Gmail search query (same syntax as Gmail search box). Examples: 'from:boss@company.com', 'subject:invoice', 'is:unread'"
				},
				"maxResults": {
					"type": "integer",
					"description": "Maximum number of results (default: 10, max: 100)",
					"default": 10
				}
			},
			"required": ["query"]
		}`),
	},
	{
		Name:        "gmail_get",
		Description: "Get a specific email by ID with full details",
		Provider:    "gmail",
		Action:      "gmail.get",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"messageId": {
					"type": "string",
					"description": "The Gmail message ID"
				}
			},
			"required": ["messageId"]
		}`),
	},
	{
		Name:        "gmail_send",
		Description: "Send a new email",
		Provider:    "gmail",
		Action:      "gmail.send",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"to": {
					"type": "array",
					"items": {"type": "string"},
					"description": "Recipient email addresses"
				},
				"subject": {
					"type": "string",
					"description": "Email subject"
				},
				"body": {
					"type": "string",
					"description": "Email body (plain text)"
				},
				"cc": {
					"type": "array",
					"items": {"type": "string"},
					"description": "CC recipients (optional)"
				},
				"bcc": {
					"type": "array",
					"items": {"type": "string"},
					"description": "BCC recipients (optional)"
				},
				"threadId": {
					"type": "string",
					"description": "Thread ID to reply to (optional)"
				}
			},
			"required": ["to", "subject", "body"]
		}`),
	},
	{
		Name:        "gmail_archive",
		Description: "Archive an email (remove from inbox)",
		Provider:    "gmail",
		Action:      "gmail.archive",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"messageId": {
					"type": "string",
					"description": "The Gmail message ID to archive"
				}
			},
			"required": ["messageId"]
		}`),
	},
	{
		Name:        "gmail_trash",
		Description: "Move an email to trash",
		Provider:    "gmail",
		Action:      "gmail.trash",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"messageId": {
					"type": "string",
					"description": "The Gmail message ID to trash"
				}
			},
			"required": ["messageId"]
		}`),
	},
	{
		Name:        "gmail_mark_read",
		Description: "Mark an email as read",
		Provider:    "gmail",
		Action:      "gmail.mark_read",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"messageId": {
					"type": "string",
					"description": "The Gmail message ID"
				}
			},
			"required": ["messageId"]
		}`),
	},
}

// ============================================
// GitHub Tools
// ============================================

var githubTools = []IntegrationTool{
	{
		Name:        "github_list_repos",
		Description: "List repositories the user has access to",
		Provider:    "github",
		Action:      "github.list_repos",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"type": {
					"type": "string",
					"enum": ["all", "owner", "public", "private", "member"],
					"description": "Type of repos to list",
					"default": "all"
				},
				"sort": {
					"type": "string",
					"enum": ["updated", "created", "pushed", "full_name"],
					"default": "updated"
				},
				"perPage": {
					"type": "integer",
					"description": "Results per page (max: 100)",
					"default": 30
				}
			}
		}`),
	},
	{
		Name:        "github_get_repo",
		Description: "Get details about a specific repository",
		Provider:    "github",
		Action:      "github.get_repo",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"owner": {
					"type": "string",
					"description": "Repository owner (user or org)"
				},
				"repo": {
					"type": "string",
					"description": "Repository name"
				}
			},
			"required": ["owner", "repo"]
		}`),
	},
	{
		Name:        "github_list_issues",
		Description: "List issues in a repository",
		Provider:    "github",
		Action:      "github.list_issues",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"owner": {
					"type": "string",
					"description": "Repository owner"
				},
				"repo": {
					"type": "string",
					"description": "Repository name"
				},
				"state": {
					"type": "string",
					"enum": ["open", "closed", "all"],
					"default": "open"
				},
				"perPage": {
					"type": "integer",
					"default": 30
				}
			},
			"required": ["owner", "repo"]
		}`),
	},
	{
		Name:        "github_create_issue",
		Description: "Create a new issue in a repository",
		Provider:    "github",
		Action:      "github.create_issue",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"owner": {
					"type": "string",
					"description": "Repository owner"
				},
				"repo": {
					"type": "string",
					"description": "Repository name"
				},
				"title": {
					"type": "string",
					"description": "Issue title"
				},
				"body": {
					"type": "string",
					"description": "Issue body (markdown)"
				},
				"labels": {
					"type": "array",
					"items": {"type": "string"},
					"description": "Labels to add"
				}
			},
			"required": ["owner", "repo", "title"]
		}`),
	},
	{
		Name:        "github_list_prs",
		Description: "List pull requests in a repository",
		Provider:    "github",
		Action:      "github.list_prs",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"owner": {
					"type": "string",
					"description": "Repository owner"
				},
				"repo": {
					"type": "string",
					"description": "Repository name"
				},
				"state": {
					"type": "string",
					"enum": ["open", "closed", "all"],
					"default": "open"
				}
			},
			"required": ["owner", "repo"]
		}`),
	},
	{
		Name:        "github_create_pr",
		Description: "Create a new pull request",
		Provider:    "github",
		Action:      "github.create_pr",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"owner": {
					"type": "string",
					"description": "Repository owner"
				},
				"repo": {
					"type": "string",
					"description": "Repository name"
				},
				"title": {
					"type": "string",
					"description": "PR title"
				},
				"body": {
					"type": "string",
					"description": "PR description"
				},
				"head": {
					"type": "string",
					"description": "Source branch"
				},
				"base": {
					"type": "string",
					"description": "Target branch (default: main)",
					"default": "main"
				},
				"draft": {
					"type": "boolean",
					"default": false
				}
			},
			"required": ["owner", "repo", "title", "head"]
		}`),
	},
	{
		Name:        "github_get_file",
		Description: "Get contents of a file in a repository",
		Provider:    "github",
		Action:      "github.get_file",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"owner": {
					"type": "string",
					"description": "Repository owner"
				},
				"repo": {
					"type": "string",
					"description": "Repository name"
				},
				"path": {
					"type": "string",
					"description": "File path"
				},
				"ref": {
					"type": "string",
					"description": "Branch/tag/commit (default: default branch)"
				}
			},
			"required": ["owner", "repo", "path"]
		}`),
	},
	{
		Name:        "github_search_code",
		Description: "Search for code in repositories",
		Provider:    "github",
		Action:      "github.search_code",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"query": {
					"type": "string",
					"description": "Search query"
				},
				"owner": {
					"type": "string",
					"description": "Limit to repos owned by this user/org"
				},
				"repo": {
					"type": "string",
					"description": "Limit to a specific repo"
				}
			},
			"required": ["query"]
		}`),
	},
}

// ============================================
// Google Drive Tools
// ============================================

var driveTools = []IntegrationTool{
	{
		Name:        "drive_list",
		Description: "List files in Google Drive",
		Provider:    "google_drive",
		Action:      "drive.list",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"query": {
					"type": "string",
					"description": "Drive query string (e.g., \"name contains 'report'\")"
				},
				"folderId": {
					"type": "string",
					"description": "List files in a specific folder"
				},
				"pageSize": {
					"type": "integer",
					"description": "Results per page (max: 1000)",
					"default": 100
				}
			}
		}`),
	},
	{
		Name:        "drive_get",
		Description: "Get metadata for a specific file",
		Provider:    "google_drive",
		Action:      "drive.get",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"fileId": {
					"type": "string",
					"description": "The Drive file ID"
				}
			},
			"required": ["fileId"]
		}`),
	},
	{
		Name:        "drive_download",
		Description: "Download/read the contents of a file",
		Provider:    "google_drive",
		Action:      "drive.download",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"fileId": {
					"type": "string",
					"description": "The Drive file ID"
				}
			},
			"required": ["fileId"]
		}`),
	},
	{
		Name:        "drive_create",
		Description: "Create a new file in Drive",
		Provider:    "google_drive",
		Action:      "drive.create",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"name": {
					"type": "string",
					"description": "File name"
				},
				"content": {
					"type": "string",
					"description": "File content"
				},
				"mimeType": {
					"type": "string",
					"description": "MIME type (default: text/plain)",
					"default": "text/plain"
				},
				"folderId": {
					"type": "string",
					"description": "Parent folder ID"
				}
			},
			"required": ["name"]
		}`),
	},
	{
		Name:        "drive_update",
		Description: "Update an existing file's content",
		Provider:    "google_drive",
		Action:      "drive.update",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"fileId": {
					"type": "string",
					"description": "The Drive file ID"
				},
				"content": {
					"type": "string",
					"description": "New file content"
				},
				"name": {
					"type": "string",
					"description": "New file name (optional)"
				}
			},
			"required": ["fileId", "content"]
		}`),
	},
	{
		Name:        "drive_delete",
		Description: "Delete a file from Drive",
		Provider:    "google_drive",
		Action:      "drive.delete",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"fileId": {
					"type": "string",
					"description": "The Drive file ID"
				}
			},
			"required": ["fileId"]
		}`),
	},
}

// ============================================
// Google Calendar Tools
// ============================================

var calendarTools = []IntegrationTool{
	{
		Name:        "calendar_list_events",
		Description: "List upcoming events from a calendar",
		Provider:    "google_calendar",
		Action:      "calendar.list_events",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"calendarId": {
					"type": "string",
					"description": "Calendar ID (default: 'primary')",
					"default": "primary"
				},
				"timeMin": {
					"type": "string",
					"description": "Start time (ISO 8601, default: now)"
				},
				"timeMax": {
					"type": "string",
					"description": "End time (ISO 8601)"
				},
				"maxResults": {
					"type": "integer",
					"default": 100
				}
			}
		}`),
	},
	{
		Name:        "calendar_get_event",
		Description: "Get details of a specific event",
		Provider:    "google_calendar",
		Action:      "calendar.get_event",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"calendarId": {
					"type": "string",
					"default": "primary"
				},
				"eventId": {
					"type": "string",
					"description": "The event ID"
				}
			},
			"required": ["eventId"]
		}`),
	},
	{
		Name:        "calendar_create_event",
		Description: "Create a new calendar event",
		Provider:    "google_calendar",
		Action:      "calendar.create_event",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"calendarId": {
					"type": "string",
					"default": "primary"
				},
				"summary": {
					"type": "string",
					"description": "Event title"
				},
				"description": {
					"type": "string",
					"description": "Event description"
				},
				"location": {
					"type": "string"
				},
				"start": {
					"type": "object",
					"description": "Start time: { dateTime: 'ISO8601' } or { date: 'YYYY-MM-DD' }",
					"properties": {
						"dateTime": {"type": "string"},
						"date": {"type": "string"},
						"timeZone": {"type": "string"}
					}
				},
				"end": {
					"type": "object",
					"description": "End time: { dateTime: 'ISO8601' } or { date: 'YYYY-MM-DD' }",
					"properties": {
						"dateTime": {"type": "string"},
						"date": {"type": "string"},
						"timeZone": {"type": "string"}
					}
				},
				"attendees": {
					"type": "array",
					"items": {
						"type": "object",
						"properties": {
							"email": {"type": "string"}
						}
					}
				},
				"sendUpdates": {
					"type": "string",
					"enum": ["all", "externalOnly", "none"],
					"default": "none"
				}
			},
			"required": ["summary", "start", "end"]
		}`),
	},
	{
		Name:        "calendar_update_event",
		Description: "Update an existing calendar event",
		Provider:    "google_calendar",
		Action:      "calendar.update_event",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"calendarId": {
					"type": "string",
					"default": "primary"
				},
				"eventId": {
					"type": "string",
					"description": "The event ID to update"
				},
				"summary": {"type": "string"},
				"description": {"type": "string"},
				"location": {"type": "string"},
				"start": {
					"type": "object",
					"properties": {
						"dateTime": {"type": "string"},
						"date": {"type": "string"}
					}
				},
				"end": {
					"type": "object",
					"properties": {
						"dateTime": {"type": "string"},
						"date": {"type": "string"}
					}
				},
				"sendUpdates": {
					"type": "string",
					"enum": ["all", "externalOnly", "none"],
					"default": "none"
				}
			},
			"required": ["eventId"]
		}`),
	},
	{
		Name:        "calendar_delete_event",
		Description: "Delete a calendar event",
		Provider:    "google_calendar",
		Action:      "calendar.delete_event",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"calendarId": {
					"type": "string",
					"default": "primary"
				},
				"eventId": {
					"type": "string",
					"description": "The event ID to delete"
				},
				"sendUpdates": {
					"type": "string",
					"enum": ["all", "externalOnly", "none"],
					"default": "none"
				}
			},
			"required": ["eventId"]
		}`),
	},
	{
		Name:        "calendar_search_events",
		Description: "Search for events matching a query",
		Provider:    "google_calendar",
		Action:      "calendar.search_events",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"calendarId": {
					"type": "string",
					"default": "primary"
				},
				"query": {
					"type": "string",
					"description": "Text to search for in event titles and descriptions"
				},
				"timeMin": {
					"type": "string",
					"description": "Start of time range (ISO 8601)"
				},
				"timeMax": {
					"type": "string",
					"description": "End of time range (ISO 8601)"
				}
			},
			"required": ["query"]
		}`),
	},
}

// ============================================
// Slack Tools
// ============================================

var slackTools = []IntegrationTool{
	{
		Name:        "slack_list_channels",
		Description: "List Slack channels the bot has access to. Returns a cursor for pagination if more channels exist.",
		Provider:    "slack",
		Action:      "slack.list_channels",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"types": {"type": "string", "description": "Channel types: public_channel,private_channel", "default": "public_channel,private_channel"},
				"limit": {"type": "integer", "description": "Max channels to return (max 1000)", "default": 100},
				"cursor": {"type": "string", "description": "Pagination cursor from a previous response to fetch the next page"}
			}
		}`),
	},
	{
		Name:        "slack_read_messages",
		Description: "Read recent messages from a Slack channel",
		Provider:    "slack",
		Action:      "slack.read_messages",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"channel": {"type": "string", "description": "Channel ID"},
				"limit": {"type": "integer", "description": "Number of messages (max 100)", "default": 20},
				"oldest": {"type": "string", "description": "Only messages after this timestamp"},
				"latest": {"type": "string", "description": "Only messages before this timestamp"}
			},
			"required": ["channel"]
		}`),
	},
	{
		Name:        "slack_send_message",
		Description: "Send a message to a Slack channel",
		Provider:    "slack",
		Action:      "slack.send_message",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"channel": {"type": "string", "description": "Channel ID"},
				"text": {"type": "string", "description": "Message text"}
			},
			"required": ["channel", "text"]
		}`),
	},
	{
		Name:        "slack_reply_thread",
		Description: "Reply to a specific thread in a Slack channel",
		Provider:    "slack",
		Action:      "slack.reply_thread",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"channel": {"type": "string", "description": "Channel ID"},
				"thread_ts": {"type": "string", "description": "Thread timestamp to reply to"},
				"text": {"type": "string", "description": "Reply text"},
				"reply_broadcast": {"type": "boolean", "description": "Also post to channel", "default": false}
			},
			"required": ["channel", "thread_ts", "text"]
		}`),
	},
	{
		Name:        "slack_react",
		Description: "Add an emoji reaction to a message",
		Provider:    "slack",
		Action:      "slack.react",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"channel": {"type": "string", "description": "Channel ID"},
				"timestamp": {"type": "string", "description": "Message timestamp"},
				"name": {"type": "string", "description": "Emoji name (without colons)"}
			},
			"required": ["channel", "timestamp", "name"]
		}`),
	},
	{
		Name:        "slack_get_user_info",
		Description: "Get information about a Slack user",
		Provider:    "slack",
		Action:      "slack.get_user_info",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"user": {"type": "string", "description": "User ID"}
			},
			"required": ["user"]
		}`),
	},
	{
		Name:        "slack_edit_message",
		Description: "Edit a previously sent message in a Slack channel",
		Provider:    "slack",
		Action:      "slack.edit_message",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"channel": {"type": "string", "description": "Channel ID"},
				"ts": {"type": "string", "description": "Timestamp of the message to edit"},
				"text": {"type": "string", "description": "New message text"}
			},
			"required": ["channel", "ts", "text"]
		}`),
	},
	{
		Name:        "slack_delete_message",
		Description: "Delete a message from a Slack channel",
		Provider:    "slack",
		Action:      "slack.delete_message",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"channel": {"type": "string", "description": "Channel ID"},
				"ts": {"type": "string", "description": "Timestamp of the message to delete"}
			},
			"required": ["channel", "ts"]
		}`),
	},
}

// ============================================
// Discord Tools
// ============================================

var discordTools = []IntegrationTool{
	{
		Name:        "discord_list_channels",
		Description: "List text channels in the connected Discord server. The server is automatically determined from the integration connection.",
		Provider:    "discord",
		Action:      "discord.list_channels",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {}
		}`),
	},
	{
		Name:        "discord_read_messages",
		Description: "Read recent messages from a Discord channel",
		Provider:    "discord",
		Action:      "discord.read_messages",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"channel": {"type": "string", "description": "Channel ID"},
				"limit": {"type": "integer", "description": "Number of messages (max 100)", "default": 20},
				"before": {"type": "string", "description": "Get messages before this message ID"},
				"after": {"type": "string", "description": "Get messages after this message ID"}
			},
			"required": ["channel"]
		}`),
	},
	{
		Name:        "discord_send_message",
		Description: "Send a message to a Discord channel",
		Provider:    "discord",
		Action:      "discord.send_message",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"channel": {"type": "string", "description": "Channel ID"},
				"text": {"type": "string", "description": "Message text"}
			},
			"required": ["channel", "text"]
		}`),
	},
	{
		Name:        "discord_reply_thread",
		Description: "Reply to a specific message in a Discord channel (creates a thread reply)",
		Provider:    "discord",
		Action:      "discord.reply_thread",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"channel": {"type": "string", "description": "Channel ID"},
				"message_id": {"type": "string", "description": "Message ID to reply to"},
				"text": {"type": "string", "description": "Reply text"}
			},
			"required": ["channel", "message_id", "text"]
		}`),
	},
	{
		Name:        "discord_react",
		Description: "Add an emoji reaction to a Discord message",
		Provider:    "discord",
		Action:      "discord.react",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"channel": {"type": "string", "description": "Channel ID"},
				"message_id": {"type": "string", "description": "Message ID"},
				"emoji": {"type": "string", "description": "Emoji (unicode character or custom emoji name:id)"}
			},
			"required": ["channel", "message_id", "emoji"]
		}`),
	},
	{
		Name:        "discord_get_user_info",
		Description: "Get information about a Discord user",
		Provider:    "discord",
		Action:      "discord.get_user_info",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"user": {"type": "string", "description": "User ID"}
			},
			"required": ["user"]
		}`),
	},
	{
		Name:        "discord_edit_message",
		Description: "Edit a previously sent message in a Discord channel (bot can only edit its own messages)",
		Provider:    "discord",
		Action:      "discord.edit_message",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"channel": {"type": "string", "description": "Channel ID"},
				"message_id": {"type": "string", "description": "Message ID to edit"},
				"text": {"type": "string", "description": "New message text"}
			},
			"required": ["channel", "message_id", "text"]
		}`),
	},
	{
		Name:        "discord_delete_message",
		Description: "Delete a message from a Discord channel",
		Provider:    "discord",
		Action:      "discord.delete_message",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"channel": {"type": "string", "description": "Channel ID"},
				"message_id": {"type": "string", "description": "Message ID to delete"}
			},
			"required": ["channel", "message_id"]
		}`),
	},
}

// ============================================
// Telegram Tools
// ============================================

var telegramTools = []IntegrationTool{
	{
		Name:        "telegram_get_chats",
		Description: "List chats the Telegram bot has interacted with",
		Provider:    "telegram",
		Action:      "telegram.get_chats",
		InputSchema: json.RawMessage(`{"type": "object", "properties": {}}`),
	},
	{
		Name:        "telegram_read_messages",
		Description: "Read recent messages from a Telegram chat",
		Provider:    "telegram",
		Action:      "telegram.read_messages",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"chat_id": {"type": "string", "description": "Telegram chat ID"},
				"limit": {"type": "integer", "description": "Number of messages (default: 20)", "default": 20}
			},
			"required": ["chat_id"]
		}`),
	},
	{
		Name:        "telegram_send_message",
		Description: "Send a message to a Telegram chat",
		Provider:    "telegram",
		Action:      "telegram.send_message",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"chat_id": {"type": "string", "description": "Telegram chat ID"},
				"text": {"type": "string", "description": "Message text"},
				"parse_mode": {"type": "string", "description": "Parse mode: HTML or Markdown", "enum": ["HTML", "Markdown"]}
			},
			"required": ["chat_id", "text"]
		}`),
	},
	{
		Name:        "telegram_reply_thread",
		Description: "Reply to a specific message in a Telegram chat",
		Provider:    "telegram",
		Action:      "telegram.reply_thread",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"chat_id": {"type": "string", "description": "Telegram chat ID"},
				"message_id": {"type": "string", "description": "Message ID to reply to"},
				"text": {"type": "string", "description": "Reply text"}
			},
			"required": ["chat_id", "message_id", "text"]
		}`),
	},
	{
		Name:        "telegram_get_chat_info",
		Description: "Get information about a Telegram chat",
		Provider:    "telegram",
		Action:      "telegram.get_chat_info",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"chat_id": {"type": "string", "description": "Telegram chat ID"}
			},
			"required": ["chat_id"]
		}`),
	},
	{
		Name:        "telegram_edit_message",
		Description: "Edit a message in a Telegram chat",
		Provider:    "telegram",
		Action:      "telegram.edit_message",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"chat_id": {"type": "string", "description": "Telegram chat ID"},
				"message_id": {"type": "string", "description": "Message ID to edit"},
				"text": {"type": "string", "description": "New message text"}
			},
			"required": ["chat_id", "message_id", "text"]
		}`),
	},
	{
		Name:        "telegram_delete_message",
		Description: "Delete a message in a Telegram chat",
		Provider:    "telegram",
		Action:      "telegram.delete_message",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"chat_id": {"type": "string", "description": "Telegram chat ID"},
				"message_id": {"type": "string", "description": "Message ID to delete"}
			},
			"required": ["chat_id", "message_id"]
		}`),
	},
}

// ============================================
// WhatsApp Tools
// ============================================

var whatsappTools = []IntegrationTool{
	{
		Name:        "whatsapp_send_message",
		Description: "Send a WhatsApp message to a phone number",
		Provider:    "whatsapp",
		Action:      "whatsapp.send_message",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"phone_number_id": {"type": "string", "description": "WhatsApp Business phone number ID"},
				"to": {"type": "string", "description": "Recipient phone number (with country code, e.g. +1234567890)"},
				"text": {"type": "string", "description": "Message text"}
			},
			"required": ["phone_number_id", "to", "text"]
		}`),
	},
	{
		Name:        "whatsapp_send_template",
		Description: "Send a WhatsApp template message",
		Provider:    "whatsapp",
		Action:      "whatsapp.send_template",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"phone_number_id": {"type": "string", "description": "WhatsApp Business phone number ID"},
				"to": {"type": "string", "description": "Recipient phone number"},
				"template_name": {"type": "string", "description": "Template name"},
				"language_code": {"type": "string", "description": "Language code (e.g. en_US)"}
			},
			"required": ["phone_number_id", "to", "template_name", "language_code"]
		}`),
	},
	{
		Name:        "whatsapp_reply_message",
		Description: "Reply to a WhatsApp message",
		Provider:    "whatsapp",
		Action:      "whatsapp.reply_message",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"phone_number_id": {"type": "string", "description": "WhatsApp Business phone number ID"},
				"to": {"type": "string", "description": "Recipient phone number"},
				"text": {"type": "string", "description": "Reply text"},
				"message_id": {"type": "string", "description": "Message ID to reply to"}
			},
			"required": ["phone_number_id", "to", "text", "message_id"]
		}`),
	},
	{
		Name:        "whatsapp_send_reaction",
		Description: "React to a WhatsApp message with an emoji",
		Provider:    "whatsapp",
		Action:      "whatsapp.send_reaction",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"phone_number_id": {"type": "string", "description": "WhatsApp Business phone number ID"},
				"to": {"type": "string", "description": "Recipient phone number"},
				"message_id": {"type": "string", "description": "Message ID to react to"},
				"emoji": {"type": "string", "description": "Emoji to react with"}
			},
			"required": ["phone_number_id", "to", "message_id", "emoji"]
		}`),
	},
	{
		Name:        "whatsapp_get_profile",
		Description: "Get WhatsApp Business profile information",
		Provider:    "whatsapp",
		Action:      "whatsapp.get_profile",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"phone_number_id": {"type": "string", "description": "WhatsApp Business phone number ID"}
			},
			"required": ["phone_number_id"]
		}`),
	},
	{
		Name:        "whatsapp_mark_read",
		Description: "Mark a WhatsApp message as read",
		Provider:    "whatsapp",
		Action:      "whatsapp.mark_read",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"phone_number_id": {"type": "string", "description": "WhatsApp Business phone number ID"},
				"message_id": {"type": "string", "description": "Message ID to mark as read"}
			},
			"required": ["phone_number_id", "message_id"]
		}`),
	},
}

// ============================================
// Teams Tools
// ============================================

var teamsTools = []IntegrationTool{
	{
		Name:        "teams_list_teams",
		Description: "List Microsoft Teams you are a member of",
		Provider:    "teams",
		Action:      "teams.list_teams",
		InputSchema: json.RawMessage(`{"type": "object", "properties": {}}`),
	},
	{
		Name:        "teams_list_channels",
		Description: "List channels in a Microsoft Teams team",
		Provider:    "teams",
		Action:      "teams.list_channels",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"team_id": {"type": "string", "description": "Team ID"}
			},
			"required": ["team_id"]
		}`),
	},
	{
		Name:        "teams_read_messages",
		Description: "Read messages from a Teams channel",
		Provider:    "teams",
		Action:      "teams.read_messages",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"team_id": {"type": "string", "description": "Team ID"},
				"channel_id": {"type": "string", "description": "Channel ID"},
				"limit": {"type": "integer", "description": "Number of messages (default: 20)", "default": 20}
			},
			"required": ["team_id", "channel_id"]
		}`),
	},
	{
		Name:        "teams_send_message",
		Description: "Send a message to a Teams channel",
		Provider:    "teams",
		Action:      "teams.send_message",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"team_id": {"type": "string", "description": "Team ID"},
				"channel_id": {"type": "string", "description": "Channel ID"},
				"text": {"type": "string", "description": "Message text"}
			},
			"required": ["team_id", "channel_id", "text"]
		}`),
	},
	{
		Name:        "teams_reply_thread",
		Description: "Reply to a message thread in Teams",
		Provider:    "teams",
		Action:      "teams.reply_thread",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"team_id": {"type": "string", "description": "Team ID"},
				"channel_id": {"type": "string", "description": "Channel ID"},
				"message_id": {"type": "string", "description": "Message ID to reply to"},
				"text": {"type": "string", "description": "Reply text"}
			},
			"required": ["team_id", "channel_id", "message_id", "text"]
		}`),
	},
	{
		Name:        "teams_get_member",
		Description: "Get information about a Teams member",
		Provider:    "teams",
		Action:      "teams.get_member",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"team_id": {"type": "string", "description": "Team ID"},
				"user_id": {"type": "string", "description": "User ID"}
			},
			"required": ["team_id", "user_id"]
		}`),
	},
	{
		Name:        "teams_edit_message",
		Description: "Edit a message in Teams",
		Provider:    "teams",
		Action:      "teams.edit_message",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"team_id": {"type": "string", "description": "Team ID"},
				"channel_id": {"type": "string", "description": "Channel ID"},
				"message_id": {"type": "string", "description": "Message ID to edit"},
				"text": {"type": "string", "description": "New message text"}
			},
			"required": ["team_id", "channel_id", "message_id", "text"]
		}`),
	},
	{
		Name:        "teams_delete_message",
		Description: "Delete a message in Teams",
		Provider:    "teams",
		Action:      "teams.delete_message",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"team_id": {"type": "string", "description": "Team ID"},
				"channel_id": {"type": "string", "description": "Channel ID"},
				"message_id": {"type": "string", "description": "Message ID to delete"}
			},
			"required": ["team_id", "channel_id", "message_id"]
		}`),
	},
}

// ============================================
// Matrix Tools
// ============================================

var matrixTools = []IntegrationTool{
	{
		Name:        "matrix_list_rooms",
		Description: "List Matrix rooms you have joined",
		Provider:    "matrix",
		Action:      "matrix.list_rooms",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"homeserver": {"type": "string", "description": "Matrix homeserver URL (e.g. https://matrix.org)"}
			},
			"required": ["homeserver"]
		}`),
	},
	{
		Name:        "matrix_read_messages",
		Description: "Read messages from a Matrix room",
		Provider:    "matrix",
		Action:      "matrix.read_messages",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"homeserver": {"type": "string", "description": "Matrix homeserver URL"},
				"room_id": {"type": "string", "description": "Room ID (e.g. !abc123:matrix.org)"},
				"limit": {"type": "integer", "description": "Number of messages (default: 20)", "default": 20}
			},
			"required": ["homeserver", "room_id"]
		}`),
	},
	{
		Name:        "matrix_send_message",
		Description: "Send a message to a Matrix room",
		Provider:    "matrix",
		Action:      "matrix.send_message",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"homeserver": {"type": "string", "description": "Matrix homeserver URL"},
				"room_id": {"type": "string", "description": "Room ID"},
				"text": {"type": "string", "description": "Message text"}
			},
			"required": ["homeserver", "room_id", "text"]
		}`),
	},
	{
		Name:        "matrix_reply_thread",
		Description: "Reply to a message in a Matrix room",
		Provider:    "matrix",
		Action:      "matrix.reply_thread",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"homeserver": {"type": "string", "description": "Matrix homeserver URL"},
				"room_id": {"type": "string", "description": "Room ID"},
				"event_id": {"type": "string", "description": "Event ID to reply to"},
				"text": {"type": "string", "description": "Reply text"}
			},
			"required": ["homeserver", "room_id", "event_id", "text"]
		}`),
	},
	{
		Name:        "matrix_react",
		Description: "React to a message in a Matrix room",
		Provider:    "matrix",
		Action:      "matrix.react",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"homeserver": {"type": "string", "description": "Matrix homeserver URL"},
				"room_id": {"type": "string", "description": "Room ID"},
				"event_id": {"type": "string", "description": "Event ID to react to"},
				"emoji": {"type": "string", "description": "Emoji to react with"}
			},
			"required": ["homeserver", "room_id", "event_id", "emoji"]
		}`),
	},
	{
		Name:        "matrix_get_profile",
		Description: "Get a Matrix user's profile",
		Provider:    "matrix",
		Action:      "matrix.get_profile",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"homeserver": {"type": "string", "description": "Matrix homeserver URL"},
				"user_id": {"type": "string", "description": "User ID (e.g. @user:matrix.org)"}
			},
			"required": ["homeserver", "user_id"]
		}`),
	},
	{
		Name:        "matrix_redact_message",
		Description: "Redact (delete) a message in a Matrix room",
		Provider:    "matrix",
		Action:      "matrix.redact_message",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"homeserver": {"type": "string", "description": "Matrix homeserver URL"},
				"room_id": {"type": "string", "description": "Room ID"},
				"event_id": {"type": "string", "description": "Event ID to redact"},
				"reason": {"type": "string", "description": "Reason for redaction"}
			},
			"required": ["homeserver", "room_id", "event_id"]
		}`),
	},
}

// ============================================
// Google Chat Tools
// ============================================

var googleChatTools = []IntegrationTool{
	{
		Name:        "google_chat_list_spaces",
		Description: "List Google Chat spaces the bot has access to",
		Provider:    "google_chat",
		Action:      "google_chat.list_spaces",
		InputSchema: json.RawMessage(`{"type": "object", "properties": {}}`),
	},
	{
		Name:        "google_chat_read_messages",
		Description: "Read messages from a Google Chat space",
		Provider:    "google_chat",
		Action:      "google_chat.read_messages",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"space": {"type": "string", "description": "Space name (e.g. spaces/abc123)"},
				"limit": {"type": "integer", "description": "Number of messages (default: 20)", "default": 20}
			},
			"required": ["space"]
		}`),
	},
	{
		Name:        "google_chat_send_message",
		Description: "Send a message to a Google Chat space",
		Provider:    "google_chat",
		Action:      "google_chat.send_message",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"space": {"type": "string", "description": "Space name (e.g. spaces/abc123)"},
				"text": {"type": "string", "description": "Message text"}
			},
			"required": ["space", "text"]
		}`),
	},
	{
		Name:        "google_chat_reply_thread",
		Description: "Reply to a thread in Google Chat",
		Provider:    "google_chat",
		Action:      "google_chat.reply_thread",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"space": {"type": "string", "description": "Space name"},
				"thread_key": {"type": "string", "description": "Thread key or thread name to reply to"},
				"text": {"type": "string", "description": "Reply text"}
			},
			"required": ["space", "thread_key", "text"]
		}`),
	},
	{
		Name:        "google_chat_add_reaction",
		Description: "Add a reaction to a Google Chat message",
		Provider:    "google_chat",
		Action:      "google_chat.add_reaction",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"space": {"type": "string", "description": "Space name"},
				"message_id": {"type": "string", "description": "Message name (e.g. spaces/abc/messages/xyz)"},
				"emoji": {"type": "string", "description": "Unicode emoji"}
			},
			"required": ["space", "message_id", "emoji"]
		}`),
	},
	{
		Name:        "google_chat_get_member",
		Description: "Get a Google Chat space member",
		Provider:    "google_chat",
		Action:      "google_chat.get_member",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"space": {"type": "string", "description": "Space name"},
				"member_id": {"type": "string", "description": "Member name (e.g. spaces/abc/members/xyz)"}
			},
			"required": ["space", "member_id"]
		}`),
	},
	{
		Name:        "google_chat_update_message",
		Description: "Update a message in Google Chat",
		Provider:    "google_chat",
		Action:      "google_chat.update_message",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"space": {"type": "string", "description": "Space name"},
				"message_id": {"type": "string", "description": "Message name to update"},
				"text": {"type": "string", "description": "New message text"}
			},
			"required": ["space", "message_id", "text"]
		}`),
	},
	{
		Name:        "google_chat_delete_message",
		Description: "Delete a message in Google Chat",
		Provider:    "google_chat",
		Action:      "google_chat.delete_message",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"space": {"type": "string", "description": "Space name"},
				"message_id": {"type": "string", "description": "Message name to delete"}
			},
			"required": ["space", "message_id"]
		}`),
	},
}

// FormatToolError formats a policy denial or error for MCP response
func FormatToolError(err error) map[string]interface{} {
	return map[string]interface{}{
		"error":   true,
		"message": fmt.Sprintf("Policy enforcement: %v", err),
	}
}
