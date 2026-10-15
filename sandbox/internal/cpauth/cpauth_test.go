// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: cpauth-v5-drop-invalid-backoff

package cpauth

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeToken builds an unsigned JWT-shaped token; the sandbox never verifies signatures.
func fakeToken(dashboardID string, exp time.Time) string {
	enc := base64.RawURLEncoding
	header := enc.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload, _ := json.Marshal(map[string]interface{}{"dashboard_id": dashboardID, "aud": "mcp-ui", "exp": exp.Unix()})
	return header + "." + enc.EncodeToString(payload) + ".sig"
}

// genToken is fakeToken for a given sandbox generation (sbx_gen).
func genToken(dashboardID string, exp time.Time, gen int64) string {
	enc := base64.RawURLEncoding
	header := enc.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload, _ := json.Marshal(map[string]interface{}{"dashboard_id": dashboardID, "aud": "mcp-ui", "exp": exp.Unix(), "sbx_gen": gen})
	return header + "." + enc.EncodeToString(payload) + ".sig"
}

// The control plane only refreshes a token for the dashboard's current
// sandbox. A replacement minted in the same second as the old token has the
// same exp: keeping the old one meant every refresh got E79398 and internal
// calls failed once it expired.
func TestNewestLiveSandboxGenerationWins(t *testing.T) {
	s := newStore()
	exp := time.Now().Add(7 * 24 * time.Hour)
	old, replacement := genToken("d1", exp, 1000), genToken("d1", exp, 2000)
	s.set("sA", "d1", old)
	s.set("sB", "d1", replacement)
	if got := s.get("d1"); got != replacement {
		t.Fatal("same-second replacement for a newer sandbox was discarded")
	}
	// A token for a newer sandbox wins even if it expires sooner.
	newest := genToken("d1", exp.Add(-time.Hour), 3000)
	s.set("sC", "d1", newest)
	if got := s.get("d1"); got != newest {
		t.Fatal("token for the newest sandbox rejected for expiring sooner")
	}
	// A token from before generations existed loses to a generation-bound one.
	s.set("sD", "d1", fakeToken("d1", exp.Add(24*time.Hour)))
	if got := s.get("d1"); got != newest {
		t.Fatal("pre-generation token displaced a generation-bound one")
	}
}

// Desktop: two concurrent provisioning requests each create a session. A wins
// the dashboard_sandboxes claim; B, minted later (newer generation), loses and
// the control plane deletes its session. B's token must not be used: the
// control plane refuses to refresh it (E79398), so internal calls would fail
// once it expired.
func TestLosingProvisioningSessionTokenIsNotUsed(t *testing.T) {
	s := newStore()
	exp := time.Now().Add(7 * 24 * time.Hour)
	winner, loser := genToken("d1", exp, 1000), genToken("d1", exp, 2000)
	s.set("sA", "d1", winner)
	s.set("sB", "d1", loser)
	s.forget("sB")
	if got := s.get("d1"); got != winner {
		t.Fatal("kept the token of the session that lost the provisioning claim")
	}
	// Forgetting the last session drops the dashboard's token entirely.
	s.forget("sA")
	if got := s.get("d1"); got != "" {
		t.Fatal("token outlived every session that brought it")
	}
}

// Two live sessions of the same sandbox share a generation: deleting one
// keeps the token for the other.
func TestForgetKeepsGenerationStillHeld(t *testing.T) {
	s := newStore()
	tok := genToken("d1", time.Now().Add(7*24*time.Hour), 1000)
	s.set("sA", "d1", tok)
	s.set("sB", "d1", tok)
	s.forget("sA")
	if got := s.get("d1"); got != tok {
		t.Fatal("dropped a token another live session still holds")
	}
}

// If the losing session's delete never arrives, its refresh is refused as
// replaced: stop using it and fall back to the winner's token.
func TestReplacedRefreshFallsBackToOlderGeneration(t *testing.T) {
	winner := genToken("d1", time.Now().Add(7*24*time.Hour), 1000)
	loser := genToken("d1", time.Now().Add(-time.Minute), 2000) // expired: get must refresh it
	s, calls := newTestStore(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Dashboard-Token") != loser {
			t.Errorf("unexpected refresh of %q", r.Header.Get("X-Dashboard-Token"))
		}
		http.Error(w, `{"error":"E79398: Token belongs to a sandbox that was replaced"}`, http.StatusUnauthorized)
	})
	s.set("sA", "d1", winner)
	s.set("sB", "d1", loser)
	if got := s.get("d1"); got != winner {
		t.Fatal("did not fall back to the winning sandbox's token")
	}
	if got := s.get("d1"); got != winner {
		t.Fatal("went back to the replaced token")
	}
	if n := atomic.LoadInt32(calls); n != 1 {
		t.Fatalf("refresh calls = %d, want 1", n)
	}
}

// A refused refresh for any other reason keeps the still-valid token.
func TestOtherRefreshRejectionKeepsGeneration(t *testing.T) {
	s, _ := newTestStore(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"E79399: Dashboard has no live sandbox"}`, http.StatusUnauthorized)
	})
	tok := genToken("d1", time.Now().Add(time.Hour), 1000)
	s.set("sA", "d1", tok)
	<-s.startRefresh("d1")
	if got := s.get("d1"); got != tok {
		t.Fatal("dropped a valid token on a non-replacement rejection")
	}
}

// A token minted before generations existed comes back from refresh bound to
// the current sandbox: it stays the session's token.
func TestRefreshBindsLegacyTokenToGeneration(t *testing.T) {
	fresh := genToken("d1", time.Now().Add(7*24*time.Hour), 5000)
	s, _ := newTestStore(t, refreshHandler(t, fresh))
	s.set("sA", "d1", fakeToken("d1", time.Now().Add(-time.Hour)))
	if got := s.get("d1"); got != fresh {
		t.Fatal("refreshed legacy token not used")
	}
	s.forget("sA")
	if got := s.get("d1"); got != "" {
		t.Fatal("refreshed token not released with its session")
	}
}

func newTestStore(t *testing.T, handler http.HandlerFunc) (*store, *int32) {
	t.Helper()
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	s := newStore()
	s.baseURL = func() string { return srv.URL }
	return s, &calls
}

func refreshHandler(t *testing.T, fresh string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/internal/sandbox/dashboard-token/refresh" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("X-Dashboard-Token") == "" {
			t.Errorf("refresh sent without the current token")
		}
		fmt.Fprintf(w, `{"token":%q}`, fresh)
	}
}

func TestSetKeepsLaterExpiry(t *testing.T) {
	s := newStore()
	later := fakeToken("d1", time.Now().Add(7*24*time.Hour))
	earlier := fakeToken("d1", time.Now().Add(5*24*time.Hour))
	s.set("s1", "d1", later)
	s.set("s2", "d1", earlier)
	if got := s.get("d1"); got != later {
		t.Fatalf("older token replaced newer one")
	}
	s.set("s3", "d1", "not-a-jwt")
	if got := s.get("d1"); got != later {
		t.Fatalf("garbage token replaced valid one")
	}
}

func TestFreshTokenNoRefresh(t *testing.T) {
	s, calls := newTestStore(t, refreshHandler(t, "unused"))
	tok := fakeToken("d1", time.Now().Add(7*24*time.Hour))
	s.set("s1", "d1", tok)
	if got := s.get("d1"); got != tok {
		t.Fatalf("get = %q", got)
	}
	time.Sleep(50 * time.Millisecond)
	if n := atomic.LoadInt32(calls); n != 0 {
		t.Fatalf("refresh called %d times for a fresh token", n)
	}
}

func TestNearExpiryRefreshesInBackground(t *testing.T) {
	fresh := fakeToken("d1", time.Now().Add(7*24*time.Hour))
	s, calls := newTestStore(t, refreshHandler(t, fresh))
	old := fakeToken("d1", time.Now().Add(time.Hour))
	s.set("s1", "d1", old)
	if got := s.get("d1"); got != old {
		t.Fatalf("near-expiry get should still return the current token immediately")
	}
	deadline := time.Now().Add(2 * time.Second)
	for s.get("d1") != fresh {
		if time.Now().After(deadline) {
			t.Fatalf("token was not refreshed in the background (calls=%d)", atomic.LoadInt32(calls))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestExpiredRefreshesSynchronously(t *testing.T) {
	fresh := fakeToken("d1", time.Now().Add(7*24*time.Hour))
	s, calls := newTestStore(t, refreshHandler(t, fresh))
	s.set("s1", "d1", fakeToken("d1", time.Now().Add(-time.Hour)))
	if got := s.get("d1"); got != fresh {
		t.Fatalf("expired token should be refreshed before returning")
	}
	if n := atomic.LoadInt32(calls); n != 1 {
		t.Fatalf("refresh calls = %d, want 1", n)
	}
}

func TestRefreshFailureKeepsCurrentToken(t *testing.T) {
	s, _ := newTestStore(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"E79396: Dashboard not found"}`, http.StatusNotFound)
	})
	old := fakeToken("d1", time.Now().Add(time.Hour))
	s.set("s1", "d1", old)
	<-s.startRefresh("d1")
	if got := s.get("d1"); got != old {
		t.Fatalf("failed refresh dropped the still-valid token")
	}
}

func TestApplyPrefersDashboardToken(t *testing.T) {
	t.Setenv("INTERNAL_API_TOKEN", "shared")
	tok := fakeToken("dash-apply", time.Now().Add(7*24*time.Hour))
	SetSessionToken("sess-apply", "dash-apply", tok)

	req := httptest.NewRequest(http.MethodGet, "http://cp/internal/x", nil)
	if err := Apply(req, "dash-apply"); err != nil {
		t.Fatal(err)
	}
	if req.Header.Get("X-Dashboard-Token") != tok || req.Header.Get("X-Internal-Token") != "" {
		t.Fatalf("headers = %v", req.Header)
	}
}

func TestApplyFallsBackToLegacyToken(t *testing.T) {
	t.Setenv("INTERNAL_API_TOKEN", "shared")
	req := httptest.NewRequest(http.MethodGet, "http://cp/internal/x", nil)
	if err := Apply(req, "dash-unknown"); err != nil {
		t.Fatal(err)
	}
	if req.Header.Get("X-Internal-Token") != "shared" {
		t.Fatalf("expected legacy fallback, headers = %v", req.Header)
	}
}

func TestApplyWithoutAnyCredential(t *testing.T) {
	t.Setenv("INTERNAL_API_TOKEN", "")
	req := httptest.NewRequest(http.MethodGet, "http://cp/internal/x", nil)
	if err := Apply(req, "dash-none"); !errors.Is(err, ErrNoCredential) {
		t.Fatalf("err = %v, want ErrNoCredential", err)
	}
	if Available("dash-none") {
		t.Fatalf("Available should be false with no credential")
	}
}

// After a VM wakes past expiry, every concurrent caller must get the refreshed
// token, not just the one that started the refresh. A caller that saw the
// refresh in flight used to return the expired token and get a 401.
func TestConcurrentExpiredCallersWaitForRefresh(t *testing.T) {
	fresh := fakeToken("d1", time.Now().Add(7*24*time.Hour))
	started := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	s, calls := newTestStore(t, func(w http.ResponseWriter, r *http.Request) {
		once.Do(func() { close(started) })
		<-release
		fmt.Fprintf(w, `{"token":%q}`, fresh)
	})
	s.set("s1", "d1", fakeToken("d1", time.Now().Add(-time.Hour)))

	const n = 8
	results := make(chan string, n)
	go func() { results <- s.get("d1") }()
	<-started // the refresh is now in flight and blocked in the handler

	var joined sync.WaitGroup
	for i := 1; i < n; i++ {
		joined.Add(1)
		go func() {
			joined.Done()
			results <- s.get("d1")
		}()
	}
	joined.Wait()
	// Give joiners time to reach the in-flight check; with the old code they
	// would return the expired token here, before release.
	time.Sleep(50 * time.Millisecond)
	select {
	case got := <-results:
		t.Fatalf("a caller returned before the refresh finished (fresh=%t)", got == fresh)
	default:
	}
	close(release)

	for i := 0; i < n; i++ {
		if got := <-results; got != fresh {
			t.Fatalf("caller %d got a stale token", i)
		}
	}
	if c := atomic.LoadInt32(calls); c != 1 {
		t.Fatalf("refresh requests = %d, want 1", c)
	}
}

// A still-valid token must not block on a slow refresh.
func TestNearExpiryCallersDoNotWait(t *testing.T) {
	release := make(chan struct{})
	s, _ := newTestStore(t, func(w http.ResponseWriter, r *http.Request) {
		<-release
		http.Error(w, "slow", http.StatusServiceUnavailable)
	})
	defer close(release)
	old := fakeToken("d1", time.Now().Add(time.Hour))
	s.set("s1", "d1", old)
	done := make(chan string, 2)
	go func() { done <- s.get("d1") }()
	go func() { done <- s.get("d1") }()
	for i := 0; i < 2; i++ {
		select {
		case got := <-done:
			if got != old {
				t.Fatalf("got %q, want current token", got)
			}
		case <-time.After(time.Second):
			t.Fatalf("near-expiry caller blocked on the refresh")
		}
	}
}

// A token the control plane no longer accepts at all (signed under a rotated
// PTY_TOKEN_SECRET → E79395/E79393) is dropped and its session marked, so the
// session doesn't fall back to its own copy; a new token clears that.
func TestPermanentlyInvalidRefreshDropsToken(t *testing.T) {
	for _, body := range []string{
		`{"error":"E79395: A valid dashboard token is required to refresh"}`,
		`{"error":"E79393: Invalid or missing sandbox credential"}`,
	} {
		s, calls := newTestStore(t, func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, body, http.StatusUnauthorized)
		})
		s.set("sA", "d1", genToken("d1", time.Now().Add(-time.Minute), 1000))
		if got := s.get("d1"); got != "" {
			t.Fatalf("%s: kept a token the control plane refuses", body)
		}
		if !s.sessionDropped("sA") {
			t.Fatalf("%s: session not marked dropped", body)
		}
		if n := atomic.LoadInt32(calls); n != 1 {
			t.Fatalf("refresh calls = %d, want 1", n)
		}
		fresh := genToken("d1", time.Now().Add(7*24*time.Hour), 1000)
		s.set("sA", "d1", fresh)
		if got := s.get("d1"); got != fresh || s.sessionDropped("sA") {
			t.Fatalf("%s: fresh token from the next session/PTY creation not used", body)
		}
	}
}

// Transient failures (network, 5xx, E79399) keep the token and don't mark the
// session dropped; repeated expired-token callers are not each blocked on a
// refresh that just failed.
func TestTransientRefreshFailureBacksOff(t *testing.T) {
	s, calls := newTestStore(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "upstream down", http.StatusBadGateway)
	})
	now := time.Now()
	s.now = func() time.Time { return now }
	expired := genToken("d1", now.Add(-time.Minute), 1000)
	s.set("sA", "d1", expired)
	for i := 0; i < 5; i++ {
		if got := s.get("d1"); got != expired {
			t.Fatalf("transient failure dropped the token")
		}
	}
	if n := atomic.LoadInt32(calls); n != 1 {
		t.Fatalf("refresh calls during backoff = %d, want 1", n)
	}
	if s.sessionDropped("sA") {
		t.Fatal("transient failure marked the session dropped")
	}
	now = now.Add(refreshBackoff + time.Second)
	s.get("d1")
	if n := atomic.LoadInt32(calls); n != 2 {
		t.Fatalf("refresh not retried after backoff (calls=%d)", n)
	}
}

func TestSetIgnoresTokenForOtherDashboard(t *testing.T) {
	s := newStore()
	s.set("sA", "d1", genToken("d2", time.Now().Add(time.Hour), 1))
	if got := s.get("d1"); got != "" {
		t.Fatal("accepted a token minted for another dashboard")
	}
}
