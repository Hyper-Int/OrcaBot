// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package auth

import (
	"log"
	"net/http"
	"os"
	"strings"
)

// REVISION: auth-v2-debug-logging
const authRevision = "auth-v2-debug-logging"

func init() {
	log.Printf("[auth] REVISION: %s loaded", authRevision)
}

// Middleware provides authentication middleware for HTTP handlers
type Middleware struct {
	token string
}

// NewMiddleware creates a new auth middleware
// Token is read from SANDBOX_INTERNAL_TOKEN environment variable
func NewMiddleware() *Middleware {
	token := os.Getenv("SANDBOX_INTERNAL_TOKEN")
	if token == "" {
		log.Printf("[auth] WARNING: SANDBOX_INTERNAL_TOKEN is empty — all requests will be rejected (fail-closed)")
	} else {
		log.Printf("[auth] SANDBOX_INTERNAL_TOKEN configured (len=%d, first4=%q, last4=%q)",
			len(token), safePrefix(token, 4), safeSuffix(token, 4))
	}
	return &Middleware{
		token: token,
	}
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
	// If no token is configured, reject all requests (fail secure)
	if m.token == "" {
		log.Printf("[auth] REJECT %s %s — no token configured (fail-closed)", r.Method, r.URL.Path)
		return false
	}

	// Check X-Internal-Token header first (for internal service-to-service calls)
	if token := r.Header.Get("X-Internal-Token"); token != "" {
		if token == m.token {
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

	if parts[1] == m.token {
		return true
	}
	log.Printf("[auth] REJECT %s %s — Bearer token mismatch (got len=%d, want len=%d)",
		r.Method, r.URL.Path, len(parts[1]), len(m.token))
	return false
}

// IsEnabled returns true if authentication is configured
func (m *Middleware) IsEnabled() bool {
	return m.token != ""
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
