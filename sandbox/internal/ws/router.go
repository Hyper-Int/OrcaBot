// Copyright 2026 Rob Macrae. All rights reserved.
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

// REVISION: ws-router-v1-upgrade-debug
const wsRouterRevision = "ws-router-v1-upgrade-debug"

func init() {
	log.Printf("[ws-router] REVISION: %s loaded", wsRouterRevision)
}

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
		log.Printf("[ws-router] origin reject reason=missing path=%s allowed=%q", r.URL.Path, allowedOrigins())
		return false
	}

	allowed := allowedOrigins()
	if len(allowed) == 0 {
		// No allowed origins configured - reject all (fail secure)
		log.Printf("[ws-router] origin reject reason=no_allowed_origins origin=%s path=%s", origin, r.URL.Path)
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
					log.Printf("[ws-router] origin allow mode=wildcard_port origin=%s path=%s match=%s", origin, r.URL.Path, a)
					return true
				}
			}
		}
	}
	log.Printf("[ws-router] origin reject reason=no_match origin=%s path=%s allowed=%q", origin, r.URL.Path, allowed)
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

// Upgrade upgrades an HTTP request to a WebSocket with sandbox origin checks.
func Upgrade(w http.ResponseWriter, req *http.Request) (*websocket.Conn, error) {
	return upgrader.Upgrade(w, req, nil)
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
	origin := req.Header.Get("Origin")
	log.Printf("[ws-router] pty upgrade start sessionId=%s ptyId=%s userId=%s origin=%s remote=%s", sessionId, ptyId, userID, origin, req.RemoteAddr)

	session, err := r.sessions.Get(sessionId)
	if err != nil {
		log.Printf("[ws-router] pty upgrade session lookup failed sessionId=%s ptyId=%s err=%v", sessionId, ptyId, err)
		http.Error(w, "E79702: session not found", http.StatusNotFound)
		return
	}

	ptyInfo, err := session.GetPTY(ptyId)
	if err != nil {
		log.Printf("[ws-router] pty upgrade pty lookup failed sessionId=%s ptyId=%s err=%v", sessionId, ptyId, err)
		http.Error(w, "E79703: pty not found", http.StatusNotFound)
		return
	}

	conn, err := upgrader.Upgrade(w, req, nil)
	if err != nil {
		log.Printf("[ws-router] pty upgrade failed sessionId=%s ptyId=%s userId=%s origin=%s err=%v", sessionId, ptyId, userID, origin, err)
		return
	}
	log.Printf("[ws-router] pty upgrade success sessionId=%s ptyId=%s userId=%s origin=%s", sessionId, ptyId, userID, origin)

	client := NewClientWithUser(conn, ptyInfo.Hub, userID)
	if client == nil {
		// Hub already stopped - close the orphaned connection to prevent leak
		log.Printf("[ws-router] pty upgrade orphaned sessionId=%s ptyId=%s userId=%s", sessionId, ptyId, userID)
		conn.Close()
		return
	}
	go client.ReadPump()
	go client.WritePump()
}

// HandleAgentWebSocket upgrades HTTP to WebSocket and connects to agent PTY
func (r *Router) HandleAgentWebSocket(w http.ResponseWriter, req *http.Request) {
	sessionId := req.PathValue("sessionId")
	userID := req.URL.Query().Get("user_id")
	origin := req.Header.Get("Origin")
	log.Printf("[ws-router] agent upgrade start sessionId=%s userId=%s origin=%s remote=%s", sessionId, userID, origin, req.RemoteAddr)

	session, err := r.sessions.Get(sessionId)
	if err != nil {
		log.Printf("[ws-router] agent upgrade session lookup failed sessionId=%s err=%v", sessionId, err)
		http.Error(w, "E79702: session not found", http.StatusNotFound)
		return
	}

	agent, err := session.GetAgent()
	if err != nil {
		log.Printf("[ws-router] agent upgrade agent lookup failed sessionId=%s err=%v", sessionId, err)
		http.Error(w, "E79704: agent not found", http.StatusNotFound)
		return
	}

	conn, err := upgrader.Upgrade(w, req, nil)
	if err != nil {
		log.Printf("[ws-router] agent upgrade failed sessionId=%s userId=%s origin=%s err=%v", sessionId, userID, origin, err)
		return
	}
	log.Printf("[ws-router] agent upgrade success sessionId=%s userId=%s origin=%s", sessionId, userID, origin)

	client := NewClientWithUser(conn, agent.Hub(), userID)
	if client == nil {
		// Hub already stopped - close the orphaned connection to prevent leak
		log.Printf("[ws-router] agent upgrade orphaned sessionId=%s userId=%s", sessionId, userID)
		conn.Close()
		return
	}
	go client.ReadPump()
	go client.WritePump()
}
