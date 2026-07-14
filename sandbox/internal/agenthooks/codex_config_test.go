// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package agenthooks

import (
	"strings"
	"testing"
)

// Regression guard: `notify` is a TOP-LEVEL Codex key and MUST precede every [table]
// header, and trust must accumulate across dashboards with exactly one notify line.
func TestBuildCodexSystemConfig(t *testing.T) {
	const script = "/etc/codex/orcabot-codex-stop.sh"

	cfg := buildCodexSystemConfig("", "/workspace/aaa", script)
	nIdx := strings.Index(cfg, "notify = [")
	tIdx := strings.Index(cfg, "[projects.")
	if nIdx < 0 {
		t.Fatalf("notify missing:\n%s", cfg)
	}
	if tIdx < 0 || nIdx > tIdx {
		t.Fatalf("notify must appear before the first [table] header:\n%s", cfg)
	}
	if !strings.Contains(cfg, `[projects."/workspace/aaa"]`) {
		t.Fatalf("first dashboard root not trusted:\n%s", cfg)
	}

	// Second dashboard: preserve the first's trust, add its own, keep ONE notify.
	cfg2 := buildCodexSystemConfig(cfg, "/workspace/bbb", script)
	if got := strings.Count(cfg2, "notify = ["); got != 1 {
		t.Fatalf("expected exactly one notify line, got %d:\n%s", got, cfg2)
	}
	if strings.Count(cfg2, script) != 1 {
		t.Fatalf("notify should reference the single global script once:\n%s", cfg2)
	}
	for _, root := range []string{`[projects."/workspace/aaa"]`, `[projects."/workspace/bbb"]`} {
		if !strings.Contains(cfg2, root) {
			t.Fatalf("missing trust table %s:\n%s", root, cfg2)
		}
	}
	if strings.Index(cfg2, "notify = [") > strings.Index(cfg2, "[projects.") {
		t.Fatalf("notify must stay top-level after accumulation:\n%s", cfg2)
	}
	// Idempotent: re-running with an already-trusted root doesn't duplicate it.
	cfg3 := buildCodexSystemConfig(cfg2, "/workspace/aaa", script)
	if got := strings.Count(cfg3, `[projects."/workspace/aaa"]`); got != 1 {
		t.Fatalf("trust table for /workspace/aaa duplicated (%d):\n%s", got, cfg3)
	}
}
