// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: cpauth-v4-live-session-generation

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

const moduleRevision = "cpauth-v4-live-session-generation"

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
	gen   int64 // sbx_gen: which sandbox the token was minted for (0 = none)
}

// dashboard holds a dashboard's tokens: the best one per sandbox generation,
// and which live session brought which generation. Only generations a live
// session still holds are used.
type dashboard struct {
	gens    map[int64]entry
	holders map[string]int64 // session ID → generation of the token it brought
}

type store struct {
	mu         sync.Mutex
	dashboards map[string]*dashboard
	sessions   map[string]string        // session ID → dashboard ID
	refreshing map[string]chan struct{} // closed when that dashboard's in-flight refresh ends
	client     *http.Client
	now        func() time.Time
	baseURL    func() string
}

func newStore() *store {
	return &store{
		dashboards: make(map[string]*dashboard),
		sessions:   make(map[string]string),
		refreshing: make(map[string]chan struct{}),
		client:     &http.Client{Timeout: 10 * time.Second},
		now:        time.Now,
		baseURL:    func() string { return strings.TrimSuffix(os.Getenv("CONTROLPLANE_URL"), "/") },
	}
}

var defaultStore = newStore()

var fallbackLogged sync.Map

// SetSessionToken records the token the control plane sent with a session.
// The token stays usable while that session lives (see ForgetSession).
func SetSessionToken(sessionID, dashboardID, token string) {
	defaultStore.set(sessionID, dashboardID, token)
}

// ForgetSession drops a deleted session's claim on its token. On desktop the
// control plane deletes the session of a provisioning request that lost the
// race for the dashboard: that session's token is for a sandbox the control
// plane never recorded and will not refresh.
func ForgetSession(sessionID string) {
	defaultStore.forget(sessionID)
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

func (s *store) set(sessionID, dashboardID, token string) {
	if sessionID == "" || dashboardID == "" || token == "" {
		return
	}
	exp, gen, err := tokenClaims(token)
	if err != nil {
		log.Printf("[cpauth] ignoring unparseable token for dashboard %s: %v", dashboardID, err)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.releaseLocked(sessionID) // a session brings one token
	d := s.dashboards[dashboardID]
	if d == nil {
		d = &dashboard{gens: make(map[int64]entry), holders: make(map[string]int64)}
		s.dashboards[dashboardID] = d
	}
	s.sessions[sessionID] = dashboardID
	d.holders[sessionID] = gen
	d.offer(entry{token: token, exp: exp, gen: gen})
}

func (s *store) forget(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.releaseLocked(sessionID)
}

// releaseLocked removes a session's hold, and its generation's token once no
// live session holds it.
func (s *store) releaseLocked(sessionID string) {
	dashboardID, ok := s.sessions[sessionID]
	if !ok {
		return
	}
	delete(s.sessions, sessionID)
	d := s.dashboards[dashboardID]
	if d == nil {
		return
	}
	gen := d.holders[sessionID]
	delete(d.holders, sessionID)
	for _, g := range d.holders {
		if g == gen {
			return
		}
	}
	delete(d.gens, gen)
	if len(d.holders) == 0 {
		delete(s.dashboards, dashboardID)
	}
}

// offer keeps e if it expires later than the token held for its generation.
func (d *dashboard) offer(e entry) {
	if cur, ok := d.gens[e.gen]; ok && !e.exp.After(cur.exp) {
		return
	}
	d.gens[e.gen] = e
}

// current is the token to use: the newest sandbox generation a live session
// holds. The control plane only refreshes a token minted for the dashboard's
// current sandbox, and a newer live session can only come from a later claim.
// A token for a sandbox that lost the provisioning race is never used: its
// session is deleted (ForgetSession), and if that delete never arrives the
// control plane's E79398 on refresh drops it (see refresh).
func (d *dashboard) current() (entry, bool) {
	var best entry
	found := false
	for gen, e := range d.gens {
		if !found || gen > best.gen {
			best, found = e, true
		}
	}
	return best, found
}

func (s *store) currentLocked(dashboardID string) (entry, bool) {
	d := s.dashboards[dashboardID]
	if d == nil {
		return entry{}, false
	}
	return d.current()
}

func (s *store) get(dashboardID string) string {
	if dashboardID == "" {
		return ""
	}
	// Each pass refreshes the current token if it has expired; a refresh
	// rejected as replaced drops that generation, so the next pass falls back
	// to the next one held. Bounded so a stuck refresh can't spin.
	for attempt := 0; attempt < 4; attempt++ {
		s.mu.Lock()
		cur, ok := s.currentLocked(dashboardID)
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
			s.mu.Lock()
			next, ok := s.currentLocked(dashboardID)
			s.mu.Unlock()
			if !ok {
				return ""
			}
			if next.gen == cur.gen {
				return next.token
			}
		case cur.exp.Sub(now) < refreshBefore:
			// Still valid: refresh in the background and carry on with this token.
			s.startRefresh(dashboardID)
			return cur.token
		default:
			return cur.token
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cur, _ := s.currentLocked(dashboardID)
	return cur.token
}

// startRefresh begins swapping the dashboard's current token for a fresh one,
// or joins the refresh already in flight, and returns a channel closed when it
// finishes. Concurrent calls for the same dashboard collapse into one request.
func (s *store) startRefresh(dashboardID string) <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if done, ok := s.refreshing[dashboardID]; ok {
		return done
	}
	done := make(chan struct{})
	cur, ok := s.currentLocked(dashboardID)
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
		s.refresh(dashboardID, cur)
	}()
	return done
}

// refresh exchanges current for a fresh token. Only startRefresh calls it.
func (s *store) refresh(dashboardID string, current entry) {

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
	req.Header.Set("X-Dashboard-Token", current.token)
	resp, err := s.client.Do(req)
	if err != nil {
		log.Printf("[cpauth] token refresh for dashboard %s failed: %v", dashboardID, err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		log.Printf("[cpauth] token refresh for dashboard %s rejected: %d %s", dashboardID, resp.StatusCode, strings.TrimSpace(string(body)))
		if resp.StatusCode == http.StatusUnauthorized && strings.Contains(string(body), "E79398") {
			// The token is for a sandbox the dashboard no longer runs on (e.g. a
			// lost provisioning race whose session delete never arrived): it will
			// never refresh, so stop using it and fall back to the next one held.
			s.dropGeneration(dashboardID, current.gen)
		}
		return
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.Token == "" {
		log.Printf("[cpauth] token refresh for dashboard %s returned no token", dashboardID)
		return
	}
	s.replaceRefreshed(dashboardID, current.gen, out.Token)
	log.Printf("[cpauth] refreshed dashboard token for %s", dashboardID)
}

// replaceRefreshed stores a refresh reply for the token of generation gen. The
// reply normally has the same generation; a token minted before generations
// existed comes back bound to the current sandbox, so every session holding
// the old generation moves to the reply's.
func (s *store) replaceRefreshed(dashboardID string, gen int64, token string) {
	exp, newGen, err := tokenClaims(token)
	if err != nil {
		log.Printf("[cpauth] ignoring unparseable refreshed token for dashboard %s: %v", dashboardID, err)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.dashboards[dashboardID]
	if d == nil {
		return
	}
	if _, ok := d.gens[gen]; !ok {
		return // every session holding it was deleted meanwhile
	}
	if newGen != gen {
		delete(d.gens, gen)
		for id, g := range d.holders {
			if g == gen {
				d.holders[id] = newGen
			}
		}
	}
	d.offer(entry{token: token, exp: exp, gen: newGen})
}

// dropGeneration stops using a generation's token. Its sessions stay live, but
// without a token of their own.
func (s *store) dropGeneration(dashboardID string, gen int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.dashboards[dashboardID]
	if d == nil {
		return
	}
	delete(d.gens, gen)
}

// tokenClaims reads the exp and sbx_gen claims without verifying the
// signature — the sandbox cannot verify it, and the control plane re-verifies
// on every call.
func tokenClaims(token string) (time.Time, int64, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}, 0, errors.New("not a JWT")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}, 0, err
	}
	var claims struct {
		Exp int64 `json:"exp"`
		Gen int64 `json:"sbx_gen"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return time.Time{}, 0, err
	}
	if claims.Exp == 0 {
		return time.Time{}, 0, errors.New("missing exp")
	}
	return time.Unix(claims.Exp, 0), claims.Gen, nil
}
