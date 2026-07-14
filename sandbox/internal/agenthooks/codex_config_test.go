// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package agenthooks

import (
	"strings"
	"testing"
)

// Regression guard for the OrcaBot-managed Codex system config:
//   - `notify` is a TOP-LEVEL key and MUST precede every [table] header
//   - existing [mcp_servers.*] (written by GenerateSettingsForAgent) is PRESERVED
//   - per-dashboard trust accumulates, with exactly one notify line
func TestBuildCodexSystemConfig(t *testing.T) {
	const script = "/etc/codex/orcabot-codex-stop.sh"

	// A config as GenerateSettingsForAgent leaves it: an MCP server table (+ a stray
	// notify that a prior bug nested inside a project table, which must be cleaned up).
	existing := `check_for_updates = false
notify = ["/old/script"]

[mcp_servers.orcabot]
command = "/opt/orcabot/mcp-bridge"
args = ["--session", "s1"]
env = { ORCABOT_MCP_SECRET = "x" }

[projects."/workspace/aaa"]
trust_level = "trusted"
notify = ["/stray/should/be/removed"]
`

	cfg := buildCodexSystemConfig(existing, "/workspace/bbb", script)

	// notify present, single, and references only the global script.
	if got := strings.Count(cfg, "notify = ["); got != 1 {
		t.Fatalf("expected exactly one notify line, got %d:\n%s", got, cfg)
	}
	if !strings.Contains(cfg, script) || strings.Contains(cfg, "/old/script") || strings.Contains(cfg, "/stray/should/be/removed") {
		t.Fatalf("notify must be the single global script, no strays:\n%s", cfg)
	}
	// notify is top-level: before EVERY table header (mcp_servers and projects).
	nIdx := strings.Index(cfg, "notify = [")
	firstTable := strings.Index(cfg, "[")
	if nIdx < 0 || firstTable < 0 || nIdx > firstTable {
		t.Fatalf("notify must precede the first [table]:\n%s", cfg)
	}
	// MCP server section preserved verbatim.
	if !strings.Contains(cfg, "[mcp_servers.orcabot]") ||
		!strings.Contains(cfg, `command = "/opt/orcabot/mcp-bridge"`) ||
		!strings.Contains(cfg, `ORCABOT_MCP_SECRET = "x"`) {
		t.Fatalf("mcp_servers section must be preserved:\n%s", cfg)
	}
	// Both dashboard roots trusted; the stray nested notify is gone.
	for _, root := range []string{`[projects."/workspace/aaa"]`, `[projects."/workspace/bbb"]`} {
		if !strings.Contains(cfg, root) {
			t.Fatalf("missing trust table %s:\n%s", root, cfg)
		}
	}

	// Idempotent + still preserves MCP when re-fed its own output for an existing root.
	cfg2 := buildCodexSystemConfig(cfg, "/workspace/aaa", script)
	if strings.Count(cfg2, `[projects."/workspace/aaa"]`) != 1 {
		t.Fatalf("trust table /workspace/aaa duplicated:\n%s", cfg2)
	}
	if !strings.Contains(cfg2, "[mcp_servers.orcabot]") {
		t.Fatalf("mcp_servers lost on regeneration:\n%s", cfg2)
	}
	if strings.Count(cfg2, "notify = [") != 1 {
		t.Fatalf("notify duplicated on regeneration:\n%s", cfg2)
	}
}
