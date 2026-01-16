// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package ws

import (
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/gorilla/websocket"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/sessions"
)

// allowedOrigins returns the list of allowed WebSocket origins from environment
func allowedOrigins() []string {
	origins := os.Getenv("ALLOWED_ORIGINS")
	if origins == "" {
		return nil
	}
	return strings.Split(origins, ",")
}

// checkOrigin validates the Origin header against allowed origins
func checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		// No Origin header - reject (browsers always send Origin for cross-origin)
		return false
	}

	allowed := allowedOrigins()
	if len(allowed) == 0 {
		// No allowed origins configured - reject all (fail secure)
		return false
	}

	for _, a := range allowed {
		a = strings.TrimSpace(a)
		if a == origin {
			return true
		}
		// Support wildcard for all origins (use with caution, only for dev)
		if a == "*" {
			return true
		}
		// Support wildcard port matching (e.g., "http://localhost:*")
		if strings.HasSuffix(a, ":*") {
			prefix := strings.TrimSuffix(a, "*")
			if strings.HasPrefix(origin, prefix) {
				// Check that remainder is a valid port (digits only)
				remainder := strings.TrimPrefix(origin, prefix)
				if len(remainder) > 0 && isNumeric(remainder) {
					return true
				}
			}
		}
	}
	return false
}

// isNumeric checks if a string contains only digits
func isNumeric(s string) bool {
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     checkOrigin,
}

// Router handles WebSocket connections to PTYs
type Router struct {
	sessions *sessions.Manager
}

// NewRouter creates a new WebSocket router
func NewRouter(sm *sessions.Manager) *Router {
	return &Router{
		sessions: sm,
	}
}

// HandleWebSocket upgrades HTTP to WebSocket and connects to PTY
func (r *Router) HandleWebSocket(w http.ResponseWriter, req *http.Request) {
	sessionId := req.PathValue("sessionId")
	ptyId := req.PathValue("ptyId")
	userID := req.URL.Query().Get("user_id") // Get user ID from query param

	session, err := r.sessions.Get(sessionId)
	if err != nil {
		http.Error(w, "E79702: session not found", http.StatusNotFound)
		return
	}

	ptyInfo, err := session.GetPTY(ptyId)
	if err != nil {
		http.Error(w, "E79703: pty not found", http.StatusNotFound)
		return
	}

	conn, err := upgrader.Upgrade(w, req, nil)
	if err != nil {
		log.Printf("websocket upgrade failed: %v", err)
		return
	}

	client := NewClientWithUser(conn, ptyInfo.Hub, userID)
	if client == nil {
		// Hub already stopped
		return
	}
	go client.ReadPump()
	go client.WritePump()
}

// HandleAgentWebSocket upgrades HTTP to WebSocket and connects to agent PTY
func (r *Router) HandleAgentWebSocket(w http.ResponseWriter, req *http.Request) {
	sessionId := req.PathValue("sessionId")
	userID := req.URL.Query().Get("user_id")

	session, err := r.sessions.Get(sessionId)
	if err != nil {
		http.Error(w, "E79702: session not found", http.StatusNotFound)
		return
	}

	agent, err := session.GetAgent()
	if err != nil {
		http.Error(w, "E79704: agent not found", http.StatusNotFound)
		return
	}

	conn, err := upgrader.Upgrade(w, req, nil)
	if err != nil {
		log.Printf("websocket upgrade failed: %v", err)
		return
	}

	client := NewClientWithUser(conn, agent.Hub(), userID)
	if client == nil {
		// Hub already stopped
		return
	}
	go client.ReadPump()
	go client.WritePump()
}
