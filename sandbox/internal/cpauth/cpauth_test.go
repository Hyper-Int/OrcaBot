// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

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
	s.set("d1", later)
	s.set("d1", earlier)
	if got := s.get("d1"); got != later {
		t.Fatalf("older token replaced newer one")
	}
	s.set("d1", "not-a-jwt")
	if got := s.get("d1"); got != later {
		t.Fatalf("garbage token replaced valid one")
	}
}

func TestFreshTokenNoRefresh(t *testing.T) {
	s, calls := newTestStore(t, refreshHandler(t, "unused"))
	tok := fakeToken("d1", time.Now().Add(7*24*time.Hour))
	s.set("d1", tok)
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
	s.set("d1", old)
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
	s.set("d1", fakeToken("d1", time.Now().Add(-time.Hour)))
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
	s.set("d1", old)
	<-s.startRefresh("d1")
	if got := s.get("d1"); got != old {
		t.Fatalf("failed refresh dropped the still-valid token")
	}
}

func TestApplyPrefersDashboardToken(t *testing.T) {
	t.Setenv("INTERNAL_API_TOKEN", "shared")
	tok := fakeToken("dash-apply", time.Now().Add(7*24*time.Hour))
	SetDashboardToken("dash-apply", tok)

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
	s.set("d1", fakeToken("d1", time.Now().Add(-time.Hour)))

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
	s.set("d1", old)
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
