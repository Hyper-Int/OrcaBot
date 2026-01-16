// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package pty

import (
	"encoding/json"
	"log"
	"sync"
)

// HubMessage represents a message sent through the hub to clients.
// IsBinary indicates whether this should be sent as a WebSocket binary frame (PTY output)
// or text frame (JSON control messages).
type HubMessage struct {
	IsBinary bool
	Data     []byte
}

// ClientInfo holds information about a connected client
type ClientInfo struct {
	UserID string
	Output chan HubMessage
}

// ControlEvent represents a turn-taking event to broadcast
type ControlEvent struct {
	Type       string   `json:"type"`
	Controller string   `json:"controller,omitempty"`  // user ID for turn-taking events
	AgentState string   `json:"agent_state,omitempty"` // running|paused|stopped for agent_state events
	From       string   `json:"from,omitempty"`
	To         string   `json:"to,omitempty"`
	Requests   []string `json:"requests,omitempty"`
}

// Hub manages multiple clients connected to a single PTY
type Hub struct {
	pty  *PTY
	turn *TurnController

	mu      sync.RWMutex
	clients map[chan HubMessage]*ClientInfo

	// Agent mode: when true, this Hub is for an agent PTY
	// and human input is only allowed when agent is not running
	agentMode    bool
	agentRunning bool
	agentState   string // "running", "paused", or "stopped" (empty if not agent mode)

	register     chan *ClientInfo
	unregister   chan chan HubMessage
	stop         chan struct{}
	stopOnce     sync.Once
	readLoopDone chan struct{} // Signals when readLoop exits
}

// NewHub creates a new Hub for the given PTY.
// If creatorID is provided, they are automatically assigned control.
func NewHub(p *PTY, creatorID string) *Hub {
	h := &Hub{
		pty:          p,
		turn:         NewTurnController(),
		clients:      make(map[chan HubMessage]*ClientInfo),
		register:     make(chan *ClientInfo),
		unregister:   make(chan chan HubMessage),
		stop:         make(chan struct{}),
		readLoopDone: make(chan struct{}),
	}

	// Set up callback to broadcast when controller's grace period expires
	h.turn.SetOnExpire(func(userID string) {
		h.broadcastControlEvent(ControlEvent{
			Type:       "control_expired",
			From:       userID,
			Controller: "", // No controller after expiry
		})
	})

	// Auto-assign control to creator if provided
	if creatorID != "" {
		h.turn.TakeControl(creatorID)
	}

	return h
}

// Run starts the hub's event loop
func (h *Hub) Run() {
	// Start reading from PTY
	go h.readLооp()

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
				close(client) // Close channel to unblock WritePump
				// Handle disconnect for turn-taking
				if info.UserID != "" {
					h.turn.Disconnect(info.UserID)
				}
			}
			h.mu.Unlock()

		case <-h.readLoopDone:
			// PTY read failed - broadcast pty_closed before cleanup
			h.broadcastPtyClosed()
			h.Stop()
			return

		case <-h.stop:
			h.mu.Lock()
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

// readLoop reads from PTY and broadcasts to all clients.
// Signals readLoopDone when it exits to enable proper cleanup.
func (h *Hub) readLооp() {
	defer close(h.readLoopDone)

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

// broadcast sends PTY output to all connected clients as binary messages
func (h *Hub) broadcast(data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	msg := HubMessage{IsBinary: true, Data: data}
	for client := range h.clients {
		select {
		case client <- msg:
		default:
			// Client buffer full, skip (or could disconnect)
		}
	}
}

// Register adds a client to receive PTY output (legacy - no user ID).
// Returns false if hub is already stopped.
func (h *Hub) Register(client chan HubMessage) bool {
	select {
	case h.register <- &ClientInfo{Output: client}:
		return true
	case <-h.stop:
		return false
	}
}

// RegisterClient adds a client with user ID.
// Returns false if hub is already stopped.
func (h *Hub) RegisterClient(userID string, client chan HubMessage) bool {
	select {
	case h.register <- &ClientInfo{UserID: userID, Output: client}:
		return true
	case <-h.stop:
		return false
	}
}

// Unregister removes a client.
// Safe to call even after hub is stopped.
func (h *Hub) Unregister(client chan HubMessage) {
	// Use select to avoid blocking if hub is already stopped
	select {
	case h.unregister <- client:
		// Successfully sent to run loop
	case <-h.stop:
		// Hub already stopped, clean up directly
		h.mu.Lock()
		if info, ok := h.clients[client]; ok {
			delete(h.clients, client)
			close(client) // Close channel to unblock WritePump
			if info.UserID != "" {
				h.turn.Disconnect(info.UserID)
			}
		}
		h.mu.Unlock()
	}
}

// Stop shuts down the hub and kills the PTY process.
// Safe to call multiple times (idempotent).
func (h *Hub) Stop() {
	h.stopOnce.Do(func() {
		// Signal the run loop to stop
		close(h.stop)
		// Close the PTY (kills process, closes file descriptor)
		h.pty.Close()
	})
}

// ClientCount returns the number of connected clients
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// Write sends input to the PTY (only from controller)
// In agent mode, human input is blocked while agent is running
func (h *Hub) Write(userID string, data []byte) (int, error) {
	h.mu.RLock()
	agentMode := h.agentMode
	agentRunning := h.agentRunning
	h.mu.RUnlock()

	// In agent mode, block human input while agent is running
	if agentMode && agentRunning {
		return 0, nil // Silently drop - agent has exclusive control
	}

	if !h.turn.IsController(userID) {
		return 0, nil // Silently drop input from non-controllers
	}
	return h.pty.Write(data)
}

// WriteAgent sends input to the PTY from the agent process.
// Bypasses all human input gates - use only for agent-originated writes.
func (h *Hub) WriteAgent(data []byte) (int, error) {
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
func (h *Hub) TakeCоntrol(userID string) bool {
	if h.turn.TakeControl(userID) {
		h.broadcastControlEvent(ControlEvent{
			Type:       "control_taken",
			Controller: userID,
		})
		return true
	}
	return false
}

// RequestControl requests control from the current controller.
// If no one currently has control, the requester is granted control immediately.
func (h *Hub) RequestCоntrol(userID string) {
	// If no controller, auto-grant instead of queueing
	if !h.turn.HasController() {
		if h.turn.TakeControl(userID) {
			h.broadcastControlEvent(ControlEvent{
				Type:       "control_taken",
				Controller: userID,
			})
			return
		}
	}

	h.turn.RequestControl(userID)
	h.broadcastControlEvent(ControlEvent{
		Type:     "control_requested",
		From:     userID,
		Requests: h.turn.PendingRequests(),
	})
}

// GrantControl transfers control from current controller to another user
func (h *Hub) GrantCоntrol(fromUserID, toUserID string) bool {
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
func (h *Hub) RevоkeCоntrol(userID string) bool {
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
func (h *Hub) Cоntrоller() string {
	return h.turn.Controller()
}

// IsController checks if the given user is the current controller
func (h *Hub) IsCоntrоller(userID string) bool {
	return h.turn.IsController(userID)
}

// Reconnect handles a user reconnecting
func (h *Hub) Reconnect(userID string) {
	h.turn.Reconnect(userID)
}

// SetAgentMode configures this hub for agent mode
// In agent mode, human input is blocked while the agent is running
func (h *Hub) SetAgentMode(enabled bool) {
	h.mu.Lock()
	h.agentMode = enabled
	h.agentRunning = enabled // Start as running if enabling
	if enabled {
		h.agentState = "running"
	} else {
		h.agentState = ""
	}
	h.mu.Unlock()

	if enabled {
		h.broadcastAgentState("running")
	}
}

// SetAgentRunning updates the agent running state
// When running=false (paused/stopped), humans can take control
func (h *Hub) SetAgentRunning(running bool) {
	var state string
	if running {
		state = "running"
	} else {
		state = "paused"
	}

	h.mu.Lock()
	h.agentRunning = running
	h.agentState = state
	h.mu.Unlock()

	h.broadcastAgentState(state)
}

// IsAgentRunning returns true if this is an agent hub and agent is running
func (h *Hub) IsAgentRunning() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.agentMode && h.agentRunning
}

// SetAgentStopped marks the agent as stopped and broadcasts to clients.
// Call this before Stop() to notify clients the agent has terminated.
func (h *Hub) SetAgentStopped() {
	h.mu.Lock()
	h.agentRunning = false
	h.agentState = "stopped"
	h.mu.Unlock()

	h.broadcastAgentState("stopped")
}

// broadcastAgentState sends agent state to all clients
func (h *Hub) broadcastAgentState(state string) {
	event := ControlEvent{
		Type:       "agent_state",
		AgentState: state,
	}
	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("failed to marshal agent state event: %v", err)
		return
	}
	h.broadcastControl(data)
}

// broadcastPtyClosed notifies all clients that the PTY has closed
func (h *Hub) broadcastPtyClosed() {
	event := ControlEvent{
		Type: "pty_closed",
	}
	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("failed to marshal pty_closed event: %v", err)
		return
	}
	h.broadcastControl(data)
}

// sendControlState sends current control state to a specific client
func (h *Hub) sendControlState(client chan HubMessage) {
	h.mu.RLock()
	agentState := h.agentState
	h.mu.RUnlock()

	event := ControlEvent{
		Type:       "control_state",
		Controller: h.Cоntrоller(),
		Requests:   h.turn.PendingRequests(),
		AgentState: agentState,
	}
	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("failed to marshal control state event: %v", err)
		return
	}
	msg := HubMessage{IsBinary: false, Data: data}
	select {
	case client <- msg:
	default:
	}
}

// broadcastControlEvent sends a control event to all clients
func (h *Hub) broadcastControlEvent(event ControlEvent) {
	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("failed to marshal control event: %v", err)
		return
	}
	h.broadcastControl(data)
}

// broadcastControl sends control data to all clients as text messages
func (h *Hub) broadcastControl(data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	msg := HubMessage{IsBinary: false, Data: data}
	for client := range h.clients {
		select {
		case client <- msg:
		default:
		}
	}
}
