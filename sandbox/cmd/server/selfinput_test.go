// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: self-input-v1
package main

import "testing"

func TestSelfInputBytes(t *testing.T) {
	if got := string(selfInputBytes(selfInputRequest{Text: "line 1\nline 2", Paste: true})); got != "\x1b[200~line 1\nline 2\x1b[201~" {
		t.Fatalf("a paste is bracketed so its newlines don't submit: %q", got)
	}
	if got := string(selfInputBytes(selfInputRequest{Text: "/clear"})); got != "/clear" {
		t.Fatalf("typed text goes as is: %q", got)
	}
}
