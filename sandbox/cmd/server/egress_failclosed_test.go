// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: main-v46-egress-fail-closed

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/pty"
)

// With egress enabled but kernel isolation unavailable, PTY creation must be
// refused (E79770) instead of spawning root shells, and /health must stay up
// and report why.
func TestEgressFailClosedRefusesPTYs(t *testing.T) {
	sm, cleanup := setupTestManager(t)
	defer cleanup()
	server := NewServer(sm)
	session, _ := sm.Create("", "")

	pty.RefuseSpawns("pool egress default-deny failed: test")
	defer pty.RefuseSpawns("")

	req := httptest.NewRequest("POST", "/sessions/"+session.ID+"/ptys", nil)
	setAuthHeader(req)
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "E79770") {
		t.Fatalf("create PTY: %d %s, want 503 E79770", w.Code, w.Body.String())
	}
	// Spawns from any other path are refused too.
	if _, err := session.CreatePTY("", "", ""); err == nil || !strings.Contains(err.Error(), "E79770") {
		t.Fatalf("session.CreatePTY err = %v, want E79770", err)
	}

	req = httptest.NewRequest("GET", "/health", nil)
	w = httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)
	var health map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &health); err != nil || w.Code != http.StatusOK {
		t.Fatalf("health: %d %s", w.Code, w.Body.String())
	}
	if !strings.Contains(health["pty_spawn_refused"], "default-deny") {
		t.Fatalf("health does not report the refusal: %v", health)
	}
}
