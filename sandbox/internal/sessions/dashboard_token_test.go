// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: session-v26-no-dropped-token-fallback

package sessions

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/cpauth"
)

func testDashboardToken(dashboardID string, exp time.Time, gen int64) string {
	enc := base64.RawURLEncoding
	payload, _ := json.Marshal(map[string]any{"dashboard_id": dashboardID, "exp": exp.Unix(), "sbx_gen": gen})
	return enc.EncodeToString([]byte(`{"alg":"HS256"}`)) + "." + enc.EncodeToString(payload) + ".sig"
}

// After the control plane refuses a session's token as permanently invalid
// (rotated PTY_TOKEN_SECRET), DashboardToken must not fall back to the
// session's original copy of it; a fresh token from a PTY creation restores it.
func TestDashboardTokenNoFallbackAfterDrop(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"E79395: A valid dashboard token is required to refresh"}`, http.StatusUnauthorized)
	}))
	defer srv.Close()
	t.Setenv("CONTROLPLANE_URL", srv.URL)

	old := testDashboardToken("dash-drop", time.Now().Add(-time.Minute), 7)
	cpauth.SetSessionToken("sess-drop", "dash-drop", old)
	defer cpauth.ForgetSession("sess-drop")
	s := &Session{ID: "sess-drop", DashboardID: "dash-drop", MCPToken: old}

	if got := s.DashboardToken(); got != "" {
		t.Fatalf("fell back to a token cpauth dropped: %q", got)
	}
	fresh := testDashboardToken("dash-drop", time.Now().Add(7*24*time.Hour), 7)
	s.SetDashboardToken(fresh)
	if got := s.DashboardToken(); got != fresh {
		t.Fatalf("fresh token not used: %q", got)
	}
}

// When cpauth never took the session's token, the session's own copy is used.
func TestDashboardTokenFallbackWhenNeverTaken(t *testing.T) {
	s := &Session{ID: "sess-none", DashboardID: "dash-none", MCPToken: "opaque-token"}
	if got := s.DashboardToken(); got != "opaque-token" {
		t.Fatalf("got %q, want the session's own token", got)
	}
}
