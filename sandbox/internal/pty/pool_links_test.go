// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: pty-pool-v5-uid-for-pty
package pty

import "testing"

func TestUIDForPTY(t *testing.T) {
	p := &Pool{registry: map[int]*SlotEntry{
		2003: {UID: 2003, PTYID: "pty-a", SessionID: "s"},
		2007: {UID: 2007, PTYID: "pty-b", SessionID: "s"},
	}}
	if uid, ok := p.UIDForPTY("pty-b"); !ok || uid != 2007 {
		t.Fatalf("pty-b: got %d %v, want 2007", uid, ok)
	}
	if _, ok := p.UIDForPTY("pty-gone"); ok {
		t.Fatal("a PTY not in the pool must not resolve")
	}
	if _, ok := p.UIDForPTY(""); ok {
		t.Fatal("an empty PTY id (terminal not started) must not resolve")
	}
}
