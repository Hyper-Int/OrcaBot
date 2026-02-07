// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: task-tools-v4-dashboard-wide-tasks
package mcp

import (
	"encoding/json"
	"log"
	"time"
)

func init() {
	log.Printf("[mcp-task-tools] REVISION: task-tools-v4-dashboard-wide-tasks loaded at %s", time.Now().Format(time.RFC3339))
}

// TaskTool represents an MCP tool definition for task/memory operations
type TaskTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
	Provider    string          `json:"-"` // Internal: "tasks" or "memory"
	Action      string          `json:"-"` // Internal: action to call on gateway
}

// GetTaskTools returns the task management tool definitions
func GetTaskTools() []TaskTool {
	return taskTools
}

// GetMemoryTools returns the memory management tool definitions
func GetMemoryTools() []TaskTool {
	return memoryTools
}

// GetAllAgentStateTools returns all task and memory tools
func GetAllAgentStateTools() []TaskTool {
	all := make([]TaskTool, 0, len(taskTools)+len(memoryTools))
	all = append(all, taskTools...)
	all = append(all, memoryTools...)
	return all
}

// IsAgentStateTool returns true if the tool is a task or memory tool
func IsAgentStateTool(toolName string) bool {
	for _, tool := range taskTools {
		if tool.Name == toolName {
			return true
		}
	}
	for _, tool := range memoryTools {
		if tool.Name == toolName {
			return true
		}
	}
	return false
}

// GetAgentStateToolProvider returns "tasks" or "memory" for a tool name
func GetAgentStateToolProvider(toolName string) string {
	for _, tool := range taskTools {
		if tool.Name == toolName {
			return tool.Provider
		}
	}
	for _, tool := range memoryTools {
		if tool.Name == toolName {
			return tool.Provider
		}
	}
	return ""
}

// GetAgentStateToolAction returns the action for a tool name
func GetAgentStateToolAction(toolName string) string {
	for _, tool := range taskTools {
		if tool.Name == toolName {
			return tool.Action
		}
	}
	for _, tool := range memoryTools {
		if tool.Name == toolName {
			return tool.Action
		}
	}
	return ""
}

// ============================================
// Task Tools
// ============================================

var taskTools = []TaskTool{
	{
		Name:        "task_list",
		Description: "List tasks for this dashboard. Returns pending, in_progress, and blocked tasks by default (excludes completed and cancelled). Use this to see what work is tracked and what needs to be done.",
		Provider:    "tasks",
		Action:      "tasks.list",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"status": {
					"type": "string",
					"enum": ["pending", "in_progress", "blocked", "completed", "cancelled"],
					"description": "Filter by status. If not specified, returns pending, in_progress, and blocked tasks (excludes completed/cancelled)."
				},
				"includeCompleted": {
					"type": "boolean",
					"description": "Include completed and cancelled tasks (default: false)"
				}
			}
		}`),
	},
	{
		Name:        "task_create",
		Description: "Create a new task to track work. Use for TODOs, subtasks, or tracking progress on complex operations. Tasks are dashboard-wide by default and visible to all collaborators.",
		Provider:    "tasks",
		Action:      "tasks.create",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"required": ["subject"],
			"properties": {
				"subject": {
					"type": "string",
					"description": "Brief task title in imperative form (e.g., 'Fix authentication bug', 'Add unit tests for parser')"
				},
				"description": {
					"type": "string",
					"description": "Detailed description of what needs to be done, including context and acceptance criteria"
				},
				"parentId": {
					"type": "string",
					"description": "Parent task ID if this is a subtask"
				},
				"priority": {
					"type": "integer",
					"description": "Priority (higher = more important, default: 0)"
				},
				"blockedBy": {
					"type": "array",
					"items": {"type": "string"},
					"description": "Array of task IDs that must complete before this task can start"
				},
				"sessionScoped": {
					"type": "boolean",
					"description": "If true, task is scoped to the current session only. Default is false (dashboard-wide, visible to all collaborators)."
				}
			}
		}`),
	},
	{
		Name:        "task_update",
		Description: "Update a task's status, description, or dependencies. Use to mark tasks as in_progress when starting, completed when done, or blocked when waiting on dependencies.",
		Provider:    "tasks",
		Action:      "tasks.update",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"required": ["taskId"],
			"properties": {
				"taskId": {
					"type": "string",
					"description": "ID of the task to update"
				},
				"status": {
					"type": "string",
					"enum": ["pending", "in_progress", "blocked", "completed", "cancelled"],
					"description": "New status. Use 'in_progress' when starting work, 'completed' when done, 'blocked' when waiting."
				},
				"subject": {
					"type": "string",
					"description": "Updated task title"
				},
				"description": {
					"type": "string",
					"description": "Updated description"
				},
				"addBlockedBy": {
					"type": "array",
					"items": {"type": "string"},
					"description": "Task IDs to add as blockers"
				},
				"removeBlockedBy": {
					"type": "array",
					"items": {"type": "string"},
					"description": "Task IDs to remove as blockers"
				}
			}
		}`),
	},
	{
		Name:        "task_get",
		Description: "Get full details of a specific task including description, metadata, and dependency information.",
		Provider:    "tasks",
		Action:      "tasks.get",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"required": ["taskId"],
			"properties": {
				"taskId": {
					"type": "string",
					"description": "ID of the task to retrieve"
				}
			}
		}`),
	},
	{
		Name:        "task_delete",
		Description: "Delete a task. Use when a task is no longer needed or was created in error. This will also clean up any dependency relationships.",
		Provider:    "tasks",
		Action:      "tasks.delete",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"required": ["taskId"],
			"properties": {
				"taskId": {
					"type": "string",
					"description": "ID of the task to delete"
				}
			}
		}`),
	},
}

// ============================================
// Memory Tools
// ============================================

var memoryTools = []TaskTool{
	{
		Name:        "memory_get",
		Description: "Retrieve a stored memory by key. Use for recalling facts, context, preferences, or previously saved information. Memories persist across sessions.",
		Provider:    "memory",
		Action:      "memory.get",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"required": ["key"],
			"properties": {
				"key": {
					"type": "string",
					"description": "Memory key to retrieve (e.g., 'project_structure', 'user_preferences', 'last_error', 'coding_conventions')"
				},
				"sessionScoped": {
					"type": "boolean",
					"description": "If true, retrieve session-scoped memory. Default is false (dashboard-wide)."
				}
			}
		}`),
	},
	{
		Name:        "memory_set",
		Description: "Store a memory for later recall. Memories persist across sessions and are scoped to the dashboard by default. Use for facts, context, preferences, or any information that should be remembered.",
		Provider:    "memory",
		Action:      "memory.set",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"required": ["key", "value"],
			"properties": {
				"key": {
					"type": "string",
					"description": "Memory key (use descriptive names like 'project_structure', 'api_endpoints', 'user_preferences')"
				},
				"value": {
					"description": "Value to store (any JSON-serializable value: string, number, boolean, object, or array)"
				},
				"memoryType": {
					"type": "string",
					"enum": ["fact", "context", "preference", "summary", "checkpoint"],
					"description": "Type of memory: 'fact' for static information, 'context' for session-related, 'preference' for user settings, 'summary' for condensed information, 'checkpoint' for save points"
				},
				"tags": {
					"type": "array",
					"items": {"type": "string"},
					"description": "Tags for categorization and filtering (e.g., ['frontend', 'api', 'security'])"
				},
				"expiresIn": {
					"type": "integer",
					"description": "Expiration time in seconds (optional). Memory is automatically deleted after this time."
				},
				"sessionScoped": {
					"type": "boolean",
					"description": "If true, memory is scoped to the current session only. Default is false (dashboard-wide)."
				}
			}
		}`),
	},
	{
		Name:        "memory_list",
		Description: "List stored memories, optionally filtered by type, tags, or key prefix. Use to discover what information has been saved.",
		Provider:    "memory",
		Action:      "memory.list",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"memoryType": {
					"type": "string",
					"enum": ["fact", "context", "preference", "summary", "checkpoint"],
					"description": "Filter by memory type"
				},
				"tags": {
					"type": "array",
					"items": {"type": "string"},
					"description": "Filter by tags (memories must have ALL specified tags)"
				},
				"prefix": {
					"type": "string",
					"description": "Filter by key prefix (e.g., 'project_' to find all project-related memories)"
				}
			}
		}`),
	},
	{
		Name:        "memory_delete",
		Description: "Delete a stored memory by key. Use when information is no longer needed or has become stale.",
		Provider:    "memory",
		Action:      "memory.delete",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"required": ["key"],
			"properties": {
				"key": {
					"type": "string",
					"description": "Memory key to delete"
				},
				"sessionScoped": {
					"type": "boolean",
					"description": "If true, delete session-scoped memory. Default is false (dashboard-wide)."
				}
			}
		}`),
	},
}
