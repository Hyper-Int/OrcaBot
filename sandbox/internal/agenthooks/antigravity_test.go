// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: hooks-v6-antigravity

package agenthooks

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/mcp"
)

func TestAntigravityStopHook(t *testing.T) {
	root := t.TempDir()
	hooksPath := filepath.Join(root, ".agents", "hooks.json")
	if err := os.MkdirAll(filepath.Dir(hooksPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hooksPath, []byte(`{"my-linter":{"PostToolUse":[{"matcher":"run_command","hooks":[{"command":"./lint.sh"}]}]}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ { // idempotent
		if err := GenerateHooksForAgent(root, mcp.AgentTypeAntigravity, "s", "p"); err != nil {
			t.Fatal(err)
		}
	}
	var hooks map[string]map[string][]map[string]interface{}
	data, _ := os.ReadFile(hooksPath)
	if err := json.Unmarshal(data, &hooks); err != nil {
		t.Fatal(err)
	}
	if _, ok := hooks["my-linter"]; !ok {
		t.Errorf("the user's hook was dropped: %s", data)
	}
	stop := hooks["orcabot-stop"]["Stop"]
	if len(stop) != 1 || !strings.HasSuffix(stop[0]["command"].(string), "/.orcabot/hooks/antigravity-stop.sh") {
		t.Fatalf("want one Stop hook running our script: %s", data)
	}
	script, err := os.ReadFile(stop[0]["command"].(string))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`\"agent\":\"antigravity\"`, "X-MCP-Secret: $SECRET", "modelName", "/agent-stopped"} {
		if !strings.Contains(string(script), want) {
			t.Errorf("hook script lacks %q", want)
		}
	}
}
