// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: terminal-links-v1
package main

import (
	"testing"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/agentlink"
)

func TestWithPoolUIDs(t *testing.T) {
	terms := []agentlink.LinkedTerminal{{ItemID: "i1", Name: "Codex", PTYID: "p1"}, {ItemID: "i2", Name: "New", PTYID: ""}}
	out := withPoolUIDs(terms, func(pty string) (int, bool) { return 2042, pty == "p1" })
	if out[0].UID == nil || *out[0].UID != 2042 {
		t.Fatalf("p1 should carry its pool uid: %+v", out[0])
	}
	if out[1].UID != nil {
		t.Fatalf("a terminal that hasn't started has no uid: %+v", out[1])
	}
	if none := withPoolUIDs(terms, nil); none[0].UID != nil {
		t.Fatal("outside pool mode there are no uids")
	}
}
