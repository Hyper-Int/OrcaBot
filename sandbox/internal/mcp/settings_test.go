// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package mcp

import "testing"

func TestContainsWord(t *testing.T) {
	tests := []struct {
		cmd      string
		word     string
		expected bool
	}{
		// Exact match
		{"claude", "claude", true},
		{"codex", "codex", true},

		// At start with args
		{"claude --help", "claude", true},
		{"codex run", "codex", true},

		// At end with prefix command
		{"talkito codex", "codex", true},
		{"env VAR=x claude", "claude", true},

		// In middle
		{"talkito claude --model opus", "claude", true},
		{"env FOO=bar codex run", "codex", true},

		// Should NOT match substrings
		{"claudette", "claude", false},
		{"codextra", "codex", false},
		{"mygemini", "gemini", false},

		// Edge cases
		{"", "claude", false},
		{"claude", "", false},
		{"  claude  ", "claude", true},
	}

	for _, tc := range tests {
		result := containsWord(tc.cmd, tc.word)
		if result != tc.expected {
			t.Errorf("containsWord(%q, %q) = %v, want %v", tc.cmd, tc.word, result, tc.expected)
		}
	}
}

func TestDetectAgentType(t *testing.T) {
	tests := []struct {
		command  string
		expected AgentType
	}{
		// Direct commands
		{"claude", AgentTypeClaude},
		{"codex", AgentTypeCodex},
		{"gemini", AgentTypeGemini},
		{"droid", AgentTypeDroid},
		{"opencode", AgentTypeOpenCode},
		{"openclaw", AgentTypeMoltbot},
		{"moltbot", AgentTypeMoltbot},

		// With arguments
		{"claude --help", AgentTypeClaude},
		{"codex run", AgentTypeCodex},

		// Wrapped with talkito or other prefixes
		{"talkito codex", AgentTypeCodex},
		{"talkito claude", AgentTypeClaude},
		{"env VAR=x gemini", AgentTypeGemini},
		{"sudo droid", AgentTypeDroid},

		// Complex commands
		{"talkito codex --model gpt-4", AgentTypeCodex},
		{"env FOO=bar talkito claude", AgentTypeClaude},

		// Plain shell - should not match
		{"bash", AgentTypeUnknown},
		{"zsh", AgentTypeUnknown},
		{"/bin/bash", AgentTypeUnknown},

		// Case insensitive
		{"CLAUDE", AgentTypeClaude},
		{"Codex", AgentTypeCodex},
		{"TALKITO CODEX", AgentTypeCodex},

		// Should not match substrings
		{"claudette", AgentTypeUnknown},
		{"codextra", AgentTypeUnknown},
	}

	for _, tc := range tests {
		result := DetectAgentType(tc.command)
		if result != tc.expected {
			t.Errorf("DetectAgentType(%q) = %v, want %v", tc.command, result, tc.expected)
		}
	}
}
