// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// Package agenthooks generates stop hook configurations for agentic coding tools
// and handles the HTTP callbacks when those hooks fire.
package agenthooks

import "time"

// AgentStoppedEvent is broadcast to WebSocket clients when an agent finishes.
type AgentStoppedEvent struct {
	Type        string `json:"type"`        // Always "agent_stopped"
	Agent       string `json:"agent"`       // Agent identifier (claude-code, gemini, codex, etc.)
	LastMessage string `json:"lastMessage"` // The agent's final response (truncated to 4KB)
	Reason      string `json:"reason"`      // complete, interrupted, error, unknown
	Timestamp   string `json:"timestamp"`   // ISO 8601 timestamp
}

// NewAgentStoppedEvent creates a new event with the current timestamp.
func NewAgentStoppedEvent(agent, lastMessage, reason string) AgentStoppedEvent {
	// Truncate message to 4KB
	if len(lastMessage) > 4096 {
		lastMessage = lastMessage[:4096]
	}

	return AgentStoppedEvent{
		Type:        "agent_stopped",
		Agent:       agent,
		LastMessage: lastMessage,
		Reason:      reason,
		Timestamp:   time.Now().UTC().Format(time.RFC3339),
	}
}

// Agent identifiers used in events
const (
	AgentClaudeCode = "claude-code"
	AgentGemini     = "gemini"
	AgentOpenCode   = "opencode"
	AgentOpenClaw   = "openclaw"
	AgentMoltbot    = "moltbot" // legacy alias
	AgentDroid      = "droid"
	AgentCodex      = "codex"
)

// Stop reasons
const (
	ReasonComplete    = "complete"
	ReasonInterrupted = "interrupted"
	ReasonError       = "error"
	ReasonUnknown     = "unknown"
)
