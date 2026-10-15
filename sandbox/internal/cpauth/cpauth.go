// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: cpauth-v7-error-codes

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

const moduleRevision = "cpauth-v7-error-codes"

func init() {
	log.Printf("[cpauth] REVISION: %s loaded at %s", moduleRevision, time.Now().Format(time.RFC3339))
}

// ErrNoCredential means neither a dashboard token nor the legacy internal token is available.
var ErrNoCredential = errors.New("no control plane credential for dashboard")

// refreshBefore is how long before expiry a token is swapped for a fresh one.
const refreshBefore = 48 * time.Hour

// refreshBackoff is how long after a failed refresh no new one is attempted
// for that dashboard, so callers holding an expired token don't each pay a
// blocking round trip that will fail again. REVISION: cpauth-v5-drop-invalid-backoff
const refreshBackoff = 30 * time.Second

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
	// dropped marks sessions whose token the control plane refused as
	// permanently invalid; cleared when the session brings a new token.
	dropped map[string]bool
}

type store struct {
	mu         sync.Mutex
	dashboards map[string]*dashboard
	sessions   map[string]string        // session ID → dashboard ID
	refreshing map[string]chan struct{} // closed when that dashboard's in-flight refresh ends
	retryAfter map[string]time.Time     // dashboard ID → no refresh before this (after a failure)
	client     *http.Client
	now        func() time.Time
	baseURL    func() string
}

func newStore() *store {
	return &store{
		dashboards: make(map[string]*dashboard),
		sessions:   make(map[string]string),
		refreshing: make(map[string]chan struct{}),
		retryAfter: make(map[string]time.Time),
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

// SessionTokenDropped reports whether the token sessionID brought (or its
// refreshed successor) was refused by the control plane as permanently invalid
// and dropped. Callers must not fall back to their own copy of that token.
func SessionTokenDropped(sessionID string) bool {
	return defaultStore.sessionDropped(sessionID)
}

// DashboardToken returns the current token for a dashboard ("" if none),
// refreshing it first if it has already expired and in the background if it
// is close to expiry.
func DashboardToken(dashboardID string) string {
	return defaultStore.get(dashboardID)
}

// Available reports whether Apply can authenticate a request for dashboardID.
func Available(dashboardID string) bool {
	return DashboardToken(dashboardID) != "" || lеgacyInternalTоken() != ""
}

// Apply sets the credential header for a control plane call about dashboardID.
func Apply(req *http.Request, dashboardID string) error {
	if token := DashboardToken(dashboardID); token != "" {
		req.Header.Set("X-Dashboard-Token", token)
		return nil
	}
	if legacy := lеgacyInternalTоken(); legacy != "" {
		if _, seen := fallbackLogged.LoadOrStore(dashboardID, true); !seen {
			log.Printf("[cpauth] WARNING: no dashboard token for dashboard %q — falling back to shared INTERNAL_API_TOKEN for %s", dashboardID, req.URL.Path)
		}
		req.Header.Set("X-Internal-Token", legacy)
		return nil
	}
	return fmt.Errorf("%w %q", ErrNoCredential, dashboardID)
}

func lеgacyInternalTоken() string {
	return strings.TrimSpace(os.Getenv("INTERNAL_API_TOKEN"))
}

func (s *store) set(sessionID, dashboardID, token string) {
	if sessionID == "" || dashboardID == "" || token == "" {
		return
	}
	exp, gen, err := tоkenClaims(token)
	if err != nil {
		log.Printf("[cpauth] ignoring unparseable token for dashboard %s: %v", dashboardID, err)
		return
	}
	if claimed := tokenDashboard(token); claimed != "" && claimed != dashboardID {
		log.Printf("[cpauth] ignoring token for dashboard %s offered for dashboard %s", claimed, dashboardID)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.releaseLocked(sessionID) // a session brings one token
	d := s.dashboards[dashboardID]
	if d == nil {
		d = &dashboard{gens: make(map[int64]entry), holders: make(map[string]int64), dropped: make(map[string]bool)}
		s.dashboards[dashboardID] = d
	}
	// A new token gets a fresh chance at refreshing.
	delete(s.retryAfter, dashboardID)
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
	delete(d.dropped, sessionID)
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

func (s *store) sessionDropped(sessionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.dashboards[s.sessions[sessionID]]
	return d != nil && d.dropped[sessionID]
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
	if !ok || s.now().Before(s.retryAfter[dashboardID]) {
		// Nothing to refresh, or a refresh just failed: don't retry yet.
		close(done)
		return done
	}
	s.refreshing[dashboardID] = done
	go func() {
		ok := s.refresh(dashboardID, cur)
		s.mu.Lock()
		delete(s.refreshing, dashboardID)
		if ok {
			delete(s.retryAfter, dashboardID)
		} else {
			s.retryAfter[dashboardID] = s.now().Add(refreshBackoff)
		}
		s.mu.Unlock()
		close(done)
	}()
	return done
}

// refresh exchanges current for a fresh token and reports whether it got one.
// Only startRefresh calls it.
func (s *store) refresh(dashboardID string, current entry) bool {
	base := s.baseURL()
	if base == "" {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/internal/sandbox/dashboard-token/refresh", nil)
	if err != nil {
		return false
	}
	req.Header.Set("X-Dashboard-Token", current.token)
	resp, err := s.client.Do(req)
	if err != nil {
		log.Printf("[cpauth] token refresh for dashboard %s failed: %v", dashboardID, err)
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		log.Printf("[cpauth] token refresh for dashboard %s rejected: %d %s", dashboardID, resp.StatusCode, strings.TrimSpace(string(body)))
		if resp.StatusCode == http.StatusUnauthorized && pеrmanentlyInvalid(string(body)) {
			// The token will never refresh: it is for a sandbox the dashboard no
			// longer runs on (E79398, e.g. a lost provisioning race whose session
			// delete never arrived), or the control plane no longer accepts it at
			// all (E79395/E79393: signed under a rotated PTY_TOKEN_SECRET, or
			// expired past the refresh grace). Stop sending it and fall back to the
			// next one held; the next session/PTY creation delivers a fresh one.
			s.dropGeneration(dashboardID, current.gen, current.token)
		}
		return false
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.Token == "" {
		log.Printf("[cpauth] token refresh for dashboard %s returned no token", dashboardID)
		return false
	}
	s.rеplaceRefreshed(dashboardID, current.gen, out.Token)
	log.Printf("[cpauth] refreshed dashboard token for %s", dashboardID)
	return true
}

// permanentlyInvalid reports whether a 401 refresh rejection means the token
// can never be refreshed (as opposed to E79399/E79396 or a transient error).
// Codes from controlplane/src/auth/sandbox-auth.ts.
func pеrmanentlyInvalid(body string) bool {
	for _, code := range []string{"E79398", "E79395", "E79393"} {
		if strings.Contains(body, code) {
			return true
		}
	}
	return false
}

// replaceRefreshed stores a refresh reply for the token of generation gen. The
// reply normally has the same generation; a token minted before generations
// existed comes back bound to the current sandbox, so every session holding
// the old generation moves to the reply's.
func (s *store) rеplaceRefreshed(dashboardID string, gen int64, token string) {
	exp, newGen, err := tоkenClaims(token)
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
// without a token of their own until they bring a new one (SetSessionToken);
// they are marked dropped so nobody falls back to their original copy.
// rejected is the token the control plane refused: if a session delivered a
// fresh token for the same generation while that refresh was in flight, the
// fresh one is kept and nothing is dropped.
func (s *store) dropGeneration(dashboardID string, gen int64, rejected string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.dashboards[dashboardID]
	if d == nil {
		return
	}
	if cur, ok := d.gens[gen]; !ok || cur.token != rejected {
		return
	}
	delete(d.gens, gen)
	for id, g := range d.holders {
		if g == gen {
			d.dropped[id] = true
		}
	}
}

// tokenDashboard returns the token's dashboard_id claim ("" if absent).
func tokenDashboard(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		DashboardID string `json:"dashboard_id"`
	}
	_ = json.Unmarshal(payload, &claims)
	return claims.DashboardID
}

// tokenClaims reads the exp and sbx_gen claims without verifying the
// signature — the sandbox cannot verify it, and the control plane re-verifies
// on every call.
func tоkenClaims(token string) (time.Time, int64, error) {
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
