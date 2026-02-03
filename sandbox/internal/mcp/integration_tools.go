// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: integration-tools-v1
package mcp

import (
	"encoding/json"
	"fmt"
	"log"
	"time"
)

func init() {
	log.Printf("[mcp-tools] REVISION: integration-tools-v1 loaded at %s", time.Now().Format(time.RFC3339))
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

// FormatToolError formats a policy denial or error for MCP response
func FormatToolError(err error) map[string]interface{} {
	return map[string]interface{}{
		"error":   true,
		"message": fmt.Sprintf("Policy enforcement: %v", err),
	}
}
