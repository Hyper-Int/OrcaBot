package pty

import (
	"encoding/json"
	"sync"
)

// ClientInfo holds information about a connected client
type ClientInfo struct {
	UserID string
	Output chan []byte
}

// ControlEvent represents a turn-taking event to broadcast
type ControlEvent struct {
	Type       string `json:"type"`
	Controller string `json:"controller,omitempty"`
	From       string `json:"from,omitempty"`
	To         string `json:"to,omitempty"`
	Requests   []string `json:"requests,omitempty"`
}

// Hub manages multiple clients connected to a single PTY
type Hub struct {
	pty  *PTY
	turn *TurnController

	mu      sync.RWMutex
	clients map[chan []byte]*ClientInfo

	register   chan *ClientInfo
	unregister chan chan []byte
	stop       chan struct{}
	stopped    bool
}

// NewHub creates a new Hub for the given PTY
func NewHub(p *PTY) *Hub {
	return &Hub{
		pty:        p,
		turn:       NewTurnController(),
		clients:    make(map[chan []byte]*ClientInfo),
		register:   make(chan *ClientInfo),
		unregister: make(chan chan []byte),
		stop:       make(chan struct{}),
	}
}

// Run starts the hub's event loop
func (h *Hub) Run() {
	// Start reading from PTY
	go h.readLoop()

	for {
		select {
		case info := <-h.register:
			h.mu.Lock()
			h.clients[info.Output] = info
			h.mu.Unlock()
			// Send current control state to new client
			h.sendControlState(info.Output)

		case client := <-h.unregister:
			h.mu.Lock()
			info, ok := h.clients[client]
			if ok {
				delete(h.clients, client)
				// Handle disconnect for turn-taking
				if info.UserID != "" {
					h.turn.Disconnect(info.UserID)
				}
			}
			h.mu.Unlock()

		case <-h.stop:
			h.mu.Lock()
			h.stopped = true
			h.turn.Stop()
			// Close all client channels
			for client := range h.clients {
				close(client)
				delete(h.clients, client)
			}
			h.mu.Unlock()
			return
		}
	}
}

// readLoop reads from PTY and broadcasts to all clients
func (h *Hub) readLoop() {
	buf := make([]byte, 32*1024) // 32KB buffer

	for {
		n, err := h.pty.Read(buf)
		if err != nil {
			return
		}

		if n > 0 {
			// Make a copy for broadcasting
			data := make([]byte, n)
			copy(data, buf[:n])

			h.broadcast(data)
		}
	}
}

// broadcast sends data to all connected clients
func (h *Hub) broadcast(data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	for client := range h.clients {
		select {
		case client <- data:
		default:
			// Client buffer full, skip (or could disconnect)
		}
	}
}

// Register adds a client to receive PTY output (legacy - no user ID)
func (h *Hub) Register(client chan []byte) {
	h.register <- &ClientInfo{Output: client}
}

// RegisterClient adds a client with user ID
func (h *Hub) RegisterClient(userID string, client chan []byte) {
	h.register <- &ClientInfo{UserID: userID, Output: client}
}

// Unregister removes a client
func (h *Hub) Unregister(client chan []byte) {
	h.unregister <- client
}

// Stop shuts down the hub
func (h *Hub) Stop() {
	close(h.stop)
}

// ClientCount returns the number of connected clients
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// Write sends input to the PTY (only from controller)
func (h *Hub) Write(userID string, data []byte) (int, error) {
	if !h.turn.IsController(userID) {
		return 0, nil // Silently drop input from non-controllers
	}
	return h.pty.Write(data)
}

// WriteForce sends input to the PTY without checking controller (for legacy/testing)
func (h *Hub) WriteForce(data []byte) (int, error) {
	return h.pty.Write(data)
}

// Resize changes the PTY window size
func (h *Hub) Resize(cols, rows uint16) error {
	return h.pty.Resize(cols, rows)
}

// Signal sends a signal to the PTY process
func (h *Hub) Signal(sig Signal) error {
	return h.pty.Signal(sig)
}

// TakeControl attempts to take control (only works if no one has control)
func (h *Hub) TakeControl(userID string) bool {
	if h.turn.TakeControl(userID) {
		h.broadcastControlEvent(ControlEvent{
			Type:       "control_taken",
			Controller: userID,
		})
		return true
	}
	return false
}

// RequestControl requests control from the current controller
func (h *Hub) RequestControl(userID string) {
	h.turn.RequestControl(userID)
	h.broadcastControlEvent(ControlEvent{
		Type:     "control_requested",
		From:     userID,
		Requests: h.turn.PendingRequests(),
	})
}

// GrantControl transfers control from current controller to another user
func (h *Hub) GrantControl(fromUserID, toUserID string) bool {
	if h.turn.GrantControl(fromUserID, toUserID) {
		h.broadcastControlEvent(ControlEvent{
			Type:       "control_granted",
			From:       fromUserID,
			To:         toUserID,
			Controller: toUserID,
		})
		return true
	}
	return false
}

// RevokeControl releases control (only the controller can revoke)
func (h *Hub) RevokeControl(userID string) bool {
	if h.turn.RevokeControl(userID) {
		h.broadcastControlEvent(ControlEvent{
			Type: "control_revoked",
			From: userID,
		})
		return true
	}
	return false
}

// Controller returns the current controller's user ID
func (h *Hub) Controller() string {
	return h.turn.Controller()
}

// IsController checks if the given user is the current controller
func (h *Hub) IsController(userID string) bool {
	return h.turn.IsController(userID)
}

// Reconnect handles a user reconnecting
func (h *Hub) Reconnect(userID string) {
	h.turn.Reconnect(userID)
}

// sendControlState sends current control state to a specific client
func (h *Hub) sendControlState(client chan []byte) {
	event := ControlEvent{
		Type:       "control_state",
		Controller: h.turn.Controller(),
		Requests:   h.turn.PendingRequests(),
	}
	data, _ := json.Marshal(event)
	select {
	case client <- data:
	default:
	}
}

// broadcastControlEvent sends a control event to all clients
func (h *Hub) broadcastControlEvent(event ControlEvent) {
	data, _ := json.Marshal(event)
	h.broadcastControl(data)
}

// broadcastControl sends control data to all clients
func (h *Hub) broadcastControl(data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	for client := range h.clients {
		select {
		case client <- data:
		default:
		}
	}
}
