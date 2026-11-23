// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: settings-v8-antigravity

package mcp

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestDetectAntigravity(t *testing.T) {
	// PokerBench's seat: the script names other words first; agy on its own lines.
	seat := `MODEL="Gemini 4 Argon (Medium)"
( exec bash /tmp/pokerbench/seat.sh helper antigravity ) &
command -v agy >/dev/null || { echo "not installed"; exec bash; }
exec agy ${MODEL:+--model "$MODEL"} --dangerously-skip-permissions --log-file "$HOME/.gemini/antigravity-cli/log/seat.log"`
	for _, cmd := range []string{"agy", "agy --dangerously-skip-permissions", seat} {
		if got := DetectAgentType(cmd); got != AgentTypeAntigravity {
			t.Errorf("DetectAgentType(%q) = %q, want antigravity", cmd[:min(len(cmd), 40)], got)
		}
	}
	for cmd, want := range map[string]AgentType{"gemini --yolo": AgentTypeGemini, "agyle": AgentTypeUnknown, "claude": AgentTypeClaude} {
		if got := DetectAgentType(cmd); got != want {
			t.Errorf("DetectAgentType(%q) = %q, want %q", cmd, got, want)
		}
	}
}

func TestAntigravitySettingsKeepTheUsersServers(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, ".agents", "mcp_config.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"mcpServers":{"mine":{"command":"node","args":["x.js"]}},"other":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	tools := []MCPTool{{Name: "remote", Transport: "streamable-http", ServerURL: "https://example.com/mcp/"}}
	env := map[string]string{"ORCABOT_PTY_ID": "pty-1", "ORCABOT_MCP_URL": "http://localhost:8081/x", "ORCABOT_MCP_SECRET": "s"}
	if err := GenerateSettingsForAgent(root, AgentTypeAntigravity, tools, env); err != nil {
		t.Fatal(err)
	}
	var cfg struct {
		MCPServers map[string]map[string]interface{} `json:"mcpServers"`
		Other      int                               `json:"other"`
	}
	data, _ := os.ReadFile(path)
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Other != 1 || cfg.MCPServers["mine"]["command"] != "node" {
		t.Errorf("the user's config was not kept: %s", data)
	}
	if cfg.MCPServers["orcabot"]["command"] == nil || cfg.MCPServers["orcabot"]["env"] == nil {
		t.Errorf("no orcabot stdio server: %s", data)
	}
	if cfg.MCPServers["remote"]["serverUrl"] != "https://example.com/mcp/" {
		t.Errorf("remote servers use serverUrl: %s", data)
	}
}
