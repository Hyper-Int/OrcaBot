package auth

import (
	"net/http"
	"os"
	"strings"
)

// Middleware provides authentication middleware for HTTP handlers
type Middleware struct {
	token string
}

// NewMiddleware creates a new auth middleware
// Token is read from INTERNAL_API_TOKEN environment variable
func NewMiddleware() *Middleware {
	return &Middleware{
		token: os.Getenv("INTERNAL_API_TOKEN"),
	}
}

// RequireAuth wraps an http.Handler and requires valid authentication
func (m *Middleware) RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !m.isAuthenticated(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireAuthFunc wraps an http.HandlerFunc and requires valid authentication
func (m *Middleware) RequireAuthFunc(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !m.isAuthenticated(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

// isAuthenticated checks if the request has valid authentication
func (m *Middleware) isAuthenticated(r *http.Request) bool {
	// If no token is configured, reject all requests (fail secure)
	if m.token == "" {
		return false
	}

	// Check X-Internal-Token header first (for internal service-to-service calls)
	if token := r.Header.Get("X-Internal-Token"); token != "" {
		return token == m.token
	}

	// Check Authorization header (Bearer token)
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		return false
	}

	// Must be "Bearer <token>"
	parts := strings.SplitN(authHeader, " ", 2)
	if len(parts) != 2 || parts[0] != "Bearer" {
		return false
	}

	return parts[1] == m.token
}

// IsEnabled returns true if authentication is configured
func (m *Middleware) IsEnabled() bool {
	return m.token != ""
}
