// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: cpauth-v2-expired-callers-wait

// Package cpauth authenticates sandbox → control plane /internal/* calls.
//
// Every VM is readable by root inside it, so the credential it presents must only
// open its own dashboard. The control plane hands the sandbox a dashboard-scoped
// token (X-Dashboard-Token) with each session; this package keeps the freshest
// token per dashboard, refreshes it before it expires, and attaches it to
// outbound requests.
//
// The shared INTERNAL_API_TOKEN is only used as a fallback while the control
// plane still provisions it (it stops once WITHHOLD_INTERNAL_TOKEN_FROM_SANDBOX
// is set), and only when no dashboard token is known.
package cpauth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const moduleRevision = "cpauth-v2-expired-callers-wait"

func init() {
	log.Printf("[cpauth] REVISION: %s loaded at %s", moduleRevision, time.Now().Format(time.RFC3339))
}

// ErrNoCredential means neither a dashboard token nor the legacy internal token is available.
var ErrNoCredential = errors.New("no control plane credential for dashboard")

// refreshBefore is how long before expiry a token is swapped for a fresh one.
const refreshBefore = 48 * time.Hour

type entry struct {
	token string
	exp   time.Time
}

type store struct {
	mu         sync.Mutex
	tokens     map[string]entry
	refreshing map[string]chan struct{} // closed when that dashboard's in-flight refresh ends
	client     *http.Client
	now        func() time.Time
	baseURL    func() string
}

func newStore() *store {
	return &store{
		tokens:     make(map[string]entry),
		refreshing: make(map[string]chan struct{}),
		client:     &http.Client{Timeout: 10 * time.Second},
		now:        time.Now,
		baseURL:    func() string { return strings.TrimSuffix(os.Getenv("CONTROLPLANE_URL"), "/") },
	}
}

var defaultStore = newStore()

var fallbackLogged sync.Map

// SetDashboardToken records a token for a dashboard, keeping whichever of the
// stored and new tokens expires later.
func SetDashboardToken(dashboardID, token string) {
	defaultStore.set(dashboardID, token)
}

// DashboardToken returns the current token for a dashboard ("" if none),
// refreshing it first if it has already expired and in the background if it
// is close to expiry.
func DashboardToken(dashboardID string) string {
	return defaultStore.get(dashboardID)
}

// Available reports whether Apply can authenticate a request for dashboardID.
func Available(dashboardID string) bool {
	return DashboardToken(dashboardID) != "" || legacyInternalToken() != ""
}

// Apply sets the credential header for a control plane call about dashboardID.
func Apply(req *http.Request, dashboardID string) error {
	if token := DashboardToken(dashboardID); token != "" {
		req.Header.Set("X-Dashboard-Token", token)
		return nil
	}
	if legacy := legacyInternalToken(); legacy != "" {
		if _, seen := fallbackLogged.LoadOrStore(dashboardID, true); !seen {
			log.Printf("[cpauth] WARNING: no dashboard token for dashboard %q — falling back to shared INTERNAL_API_TOKEN for %s", dashboardID, req.URL.Path)
		}
		req.Header.Set("X-Internal-Token", legacy)
		return nil
	}
	return fmt.Errorf("%w %q", ErrNoCredential, dashboardID)
}

func legacyInternalToken() string {
	return strings.TrimSpace(os.Getenv("INTERNAL_API_TOKEN"))
}

func (s *store) set(dashboardID, token string) {
	if dashboardID == "" || token == "" {
		return
	}
	exp, err := tokenExpiry(token)
	if err != nil {
		log.Printf("[cpauth] ignoring unparseable token for dashboard %s: %v", dashboardID, err)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if cur, ok := s.tokens[dashboardID]; ok && !exp.After(cur.exp) {
		return
	}
	s.tokens[dashboardID] = entry{token: token, exp: exp}
}

func (s *store) get(dashboardID string) string {
	if dashboardID == "" {
		return ""
	}
	s.mu.Lock()
	cur, ok := s.tokens[dashboardID]
	s.mu.Unlock()
	if !ok {
		return ""
	}
	now := s.now()
	switch {
	case !now.Before(cur.exp):
		// Expired (e.g. the VM was suspended past the expiry) — the old token is
		// useless, so wait for the refresh, whether this caller started it or
		// joined one already in flight. Bounded by the refresh request timeout.
		<-s.startRefresh(dashboardID)
	case cur.exp.Sub(now) < refreshBefore:
		// Still valid: refresh in the background and carry on with this token.
		s.startRefresh(dashboardID)
		return cur.token
	default:
		return cur.token
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tokens[dashboardID].token
}

// startRefresh begins swapping the dashboard's token for a fresh one, or joins
// the refresh already in flight, and returns a channel closed when it finishes.
// Concurrent calls for the same dashboard collapse into one request.
func (s *store) startRefresh(dashboardID string) <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if done, ok := s.refreshing[dashboardID]; ok {
		return done
	}
	done := make(chan struct{})
	cur, ok := s.tokens[dashboardID]
	if !ok {
		close(done)
		return done
	}
	s.refreshing[dashboardID] = done
	go func() {
		defer func() {
			s.mu.Lock()
			delete(s.refreshing, dashboardID)
			s.mu.Unlock()
			close(done)
		}()
		s.refresh(dashboardID, cur.token)
	}()
	return done
}

// refresh exchanges current for a fresh token. Only startRefresh calls it.
func (s *store) refresh(dashboardID, current string) {

	base := s.baseURL()
	if base == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/internal/sandbox/dashboard-token/refresh", nil)
	if err != nil {
		return
	}
	req.Header.Set("X-Dashboard-Token", current)
	resp, err := s.client.Do(req)
	if err != nil {
		log.Printf("[cpauth] token refresh for dashboard %s failed: %v", dashboardID, err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		log.Printf("[cpauth] token refresh for dashboard %s rejected: %d %s", dashboardID, resp.StatusCode, strings.TrimSpace(string(body)))
		return
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.Token == "" {
		log.Printf("[cpauth] token refresh for dashboard %s returned no token", dashboardID)
		return
	}
	s.set(dashboardID, out.Token)
	log.Printf("[cpauth] refreshed dashboard token for %s", dashboardID)
}

// tokenExpiry reads the exp claim without verifying the signature — the sandbox
// cannot verify it, and the control plane re-verifies on every call.
func tokenExpiry(token string) (time.Time, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}, errors.New("not a JWT")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}, err
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return time.Time{}, err
	}
	if claims.Exp == 0 {
		return time.Time{}, errors.New("missing exp")
	}
	return time.Unix(claims.Exp, 0), nil
}
