package ws

import (
	"log"
	"net/http"

	"github.com/hyper-ai-inc/hyper-backend/internal/sessions"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		// TODO: implement proper origin checking
		return true
	},
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
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	ptyInfo, err := session.GetPTY(ptyId)
	if err != nil {
		http.Error(w, "pty not found", http.StatusNotFound)
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
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}

	agent, err := session.GetAgent()
	if err != nil {
		http.Error(w, "agent not found", http.StatusNotFound)
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
