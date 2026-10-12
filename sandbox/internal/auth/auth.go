// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package auth

import (
	"crypto/ed25519"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// REVISION: auth-v3-signed-requests
const authRevision = "auth-v3-signed-requests"

// SignedRequestHeader carries the control plane's per-machine Ed25519 signature.
const SignedRequestHeader = "X-Sandbox-Auth"

// signingContext must match controlplane/src/sandbox/request-signing.ts.
const signingContext = "orcabot-sandbox-auth-v1."

// maxClockSkew tolerates small clock differences between control plane and VM.
const maxClockSkew = 60 * time.Second

func init() {
	log.Printf("[auth] REVISION: %s loaded", authRevision)
}

// Middleware provides authentication middleware for HTTP handlers
type Middleware struct {
	token     string            // legacy static SANDBOX_INTERNAL_TOKEN (shared by every VM)
	publicKey ed25519.PublicKey // SANDBOX_AUTH_PUBLIC_KEY: verifies control plane signatures
	machineID string            // this machine; signed requests must name it
	now       func() time.Time
}

// NewMiddleware creates a new auth middleware from the environment:
//   - SANDBOX_AUTH_PUBLIC_KEY (base64url Ed25519): accept requests the control plane
//     signed for this machine (FLY_MACHINE_ID). A VM holding only the public key
//     cannot authenticate to any other machine.
//   - SANDBOX_INTERNAL_TOKEN: legacy static token, accepted while configured.
//
// With neither configured, every request is rejected (fail-closed).
func NewMiddleware() *Middleware {
	m := &Middleware{
		token:     os.Getenv("SANDBOX_INTERNAL_TOKEN"),
		machineID: machineIDFromEnv(),
		now:       time.Now,
	}
	if raw := strings.TrimSpace(os.Getenv("SANDBOX_AUTH_PUBLIC_KEY")); raw != "" {
		key, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(raw, "="))
		if err != nil || len(key) != ed25519.PublicKeySize {
			log.Printf("[auth] ERROR: SANDBOX_AUTH_PUBLIC_KEY is invalid (err=%v len=%d) — signed requests will be rejected", err, len(key))
		} else {
			m.publicKey = ed25519.PublicKey(key)
			log.Printf("[auth] signed requests enabled for machine %q", m.machineID)
		}
	}
	if m.token == "" {
		log.Printf("[auth] SANDBOX_INTERNAL_TOKEN not set — static token auth disabled")
	} else {
		log.Printf("[auth] SANDBOX_INTERNAL_TOKEN configured (len=%d, first4=%q, last4=%q)",
			len(m.token), safePrefix(m.token, 4), safeSuffix(m.token, 4))
	}
	if !m.IsEnabled() {
		log.Printf("[auth] WARNING: no SANDBOX_AUTH_PUBLIC_KEY or SANDBOX_INTERNAL_TOKEN — all requests will be rejected (fail-closed)")
	}
	return m
}

// machineIDFromEnv mirrors sandboxMachineID() in cmd/server.
func machineIDFromEnv() string {
	if id := os.Getenv("FLY_MACHINE_ID"); id != "" {
		return id
	}
	return os.Getenv("FLY_ALLOC_ID")
}

type signedClaims struct {
	MachineID string `json:"mid"`
	Method    string `json:"m"`
	Path      string `json:"p"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
}

// verifySigned checks an X-Sandbox-Auth value: a valid control plane signature,
// unexpired, and addressed to this machine, method and request target.
func (m *Middleware) verifySigned(r *http.Request, value string) (bool, string) {
	payloadB64, sigB64, ok := strings.Cut(value, ".")
	if !ok {
		return false, "malformed"
	}
	sig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil || !ed25519.Verify(m.publicKey, []byte(signingContext+payloadB64), sig) {
		return false, "bad signature"
	}
	payload, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return false, "malformed payload"
	}
	var c signedClaims
	if err := json.Unmarshal(payload, &c); err != nil {
		return false, "malformed payload"
	}
	now := m.now()
	if now.After(time.Unix(c.ExpiresAt, 0).Add(maxClockSkew)) {
		return false, "expired"
	}
	if time.Unix(c.IssuedAt, 0).After(now.Add(maxClockSkew)) {
		return false, "issued in the future"
	}
	if c.MachineID != m.machineID {
		return false, "signed for machine " + c.MachineID + ", this is " + m.machineID
	}
	if c.Method != r.Method {
		return false, "method mismatch"
	}
	// The raw request target exactly as sent (signed as URL.pathname + URL.search).
	target := r.RequestURI
	if target == "" {
		target = r.URL.RequestURI()
	}
	if c.Path != target {
		return false, "path mismatch"
	}
	return true, ""
}

// RequireAuth wraps an http.Handler and requires valid authentication
func (m *Middleware) RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !m.isAuthenticated(r) {
			http.Error(w, "E79701: Unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireAuthFunc wraps an http.HandlerFunc and requires valid authentication
func (m *Middleware) RequireAuthFunc(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !m.isAuthenticated(r) {
			http.Error(w, "E79701: Unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

// isAuthenticated checks if the request has valid authentication
func (m *Middleware) isAuthenticated(r *http.Request) bool {
	// If nothing is configured, reject all requests (fail secure)
	if !m.IsEnabled() {
		log.Printf("[auth] REJECT %s %s — no credentials configured (fail-closed)", r.Method, r.URL.Path)
		return false
	}

	// Per-machine signature from the control plane
	if signed := r.Header.Get(SignedRequestHeader); signed != "" && m.publicKey != nil {
		ok, reason := m.verifySigned(r, signed)
		if ok {
			return true
		}
		log.Printf("[auth] REJECT %s %s — signed request: %s", r.Method, r.URL.Path, reason)
		return false
	}

	if m.token == "" {
		log.Printf("[auth] REJECT %s %s — no valid %s (static token auth disabled)", r.Method, r.URL.Path, SignedRequestHeader)
		return false
	}

	// Check X-Internal-Token header first (for internal service-to-service calls)
	if token := r.Header.Get("X-Internal-Token"); token != "" {
		if constantTimeEqual(token, m.token) {
			return true
		}
		log.Printf("[auth] REJECT %s %s — X-Internal-Token mismatch (got len=%d first4=%q last4=%q, want len=%d first4=%q last4=%q)",
			r.Method, r.URL.Path,
			len(token), safePrefix(token, 4), safeSuffix(token, 4),
			len(m.token), safePrefix(m.token, 4), safeSuffix(m.token, 4))
		return false
	}

	// Check Authorization header (Bearer token)
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		log.Printf("[auth] REJECT %s %s — no X-Internal-Token or Authorization header present", r.Method, r.URL.Path)
		return false
	}

	// Must be "Bearer <token>"
	parts := strings.SplitN(authHeader, " ", 2)
	if len(parts) != 2 || parts[0] != "Bearer" {
		log.Printf("[auth] REJECT %s %s — malformed Authorization header", r.Method, r.URL.Path)
		return false
	}

	if constantTimeEqual(parts[1], m.token) {
		return true
	}
	log.Printf("[auth] REJECT %s %s — Bearer token mismatch (got len=%d, want len=%d)",
		r.Method, r.URL.Path, len(parts[1]), len(m.token))
	return false
}

// IsEnabled returns true if authentication is configured
func (m *Middleware) IsEnabled() bool {
	return m.token != "" || m.publicKey != nil
}

func constantTimeEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func safePrefix(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func safeSuffix(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}
