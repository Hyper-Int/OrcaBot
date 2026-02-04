// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: hub-v4-cwd-tracking

package pty

import (
	"bytes"
	"encoding/json"
	"log"
	"strings"
	"sync"
	"time"
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
	Cwd        string   `json:"cwd,omitempty"`         // current working directory (relative to workspace root)
}

// AudioEvent represents an audio playback event to broadcast
type AudioEvent struct {
	Type   string `json:"type"`             // always "audio"
	Action string `json:"action"`           // "play" or "stop"
	Path   string `json:"path,omitempty"`   // file path in workspace (for file-based)
	Data   string `json:"data,omitempty"`   // base64-encoded audio (for inline)
	Format string `json:"format,omitempty"` // "mp3", "wav", etc.
}

// TtsStatusEvent represents a TTS configuration status update from talkito
type TtsStatusEvent struct {
	Type        string `json:"type"`               // always "tts_status"
	Enabled     bool   `json:"enabled"`            // whether TTS is enabled
	Initialized bool   `json:"initialized"`        // whether TTS is initialized
	Mode        string `json:"mode,omitempty"`     // "full", "partial", etc.
	Provider    string `json:"provider,omitempty"` // "openai", "elevenlabs", etc.
	Voice       string `json:"voice,omitempty"`    // voice name/ID
}

// TalkitoNoticeEvent represents a log/notice message from talkito
type TalkitoNoticeEvent struct {
	Type     string `json:"type"`              // always "talkito_notice"
	Level    string `json:"level"`             // "info", "warning", "error"
	Message  string `json:"message"`           // the log message
	Category string `json:"category,omitempty"` // e.g. "tts"
}

// CwdEvent is broadcast when the PTY process changes its working directory.
type CwdEvent struct {
	Type string `json:"type"` // always "cwd_changed"
	Cwd  string `json:"cwd"`  // current working directory (relative to workspace root)
}

// AgentStoppedEvent is broadcast when an agentic coder finishes its turn.
// This event is triggered by native stop hooks from Claude Code, Gemini CLI,
// GitHub Copilot CLI, OpenCode, OpenClaw, Droid, and Codex CLI.
type AgentStoppedEvent struct {
	Type        string `json:"type"`        // always "agent_stopped"
	Agent       string `json:"agent"`       // claude-code, gemini, codex, etc.
	LastMessage string `json:"lastMessage"` // the agent's final response (truncated to 4KB)
	Reason      string `json:"reason"`      // complete, interrupted, error, unknown
	Timestamp   string `json:"timestamp"`   // ISO 8601 timestamp
}

// IdleTimeout is how long a hub stays alive with no connected clients.
// After this duration with zero clients, the hub automatically stops to prevent goroutine leaks.
const IdleTimeout = 600 * time.Second

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

	// Idle timeout: stops hub if no clients for IdleTimeout duration
	idleTimer *time.Timer
	idleChan  chan struct{}

	// onStop callback invoked when hub stops (for cleanup by owner)
	onStop func()

	suppressMu      sync.Mutex
	suppressActive  bool
	suppressMarkers [][]byte // Multiple markers to wait for
	suppressBuffer  []byte

	// Secrets redaction
	secretValues   []string   // Secret values to redact from output
	secretsMu      sync.RWMutex
	redactionTail  []byte     // Buffer to handle secrets split across chunks

	// Last known terminal dimensions (updated on Resize). Used to re-issue
	// SIGWINCH after scrollback replay so TUI apps redraw at the correct size.
	lastCols uint16
	lastRows uint16

	// Scrollback ring buffer: stores last scrollbackMax bytes of PTY output (post-redaction).
	// Used as fallback when agent transcript doesn't contain the text response.
	scrollbackMu  sync.Mutex
	scrollback    []byte
	scrollbackPos int // write position in ring buffer
	scrollbackMax int // capacity (default 64KB)

	// cwd tracking: workspace root is stripped to give relative paths
	workspaceRoot string // set by session on creation, e.g. "/workspace/abc123"
	lastCwd       string // last known cwd (relative to workspace root)
}

// NewHub creates a new Hub for the given PTY.
// If creatorID is provided, they are automatically assigned control.
func NewHub(p *PTY, creatorID string) *Hub {
	h := &Hub{
		pty:           p,
		turn:          NewTurnController(),
		clients:       make(map[chan HubMessage]*ClientInfo),
		register:      make(chan *ClientInfo),
		unregister:    make(chan chan HubMessage),
		stop:          make(chan struct{}),
		readLoopDone:  make(chan struct{}),
		idleChan:      make(chan struct{}),
		scrollbackMax: 64 * 1024, // 64KB ring buffer
		scrollback:    make([]byte, 64*1024),
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

	// Periodic cwd polling
	cwdTicker := time.NewTicker(2 * time.Second)
	defer cwdTicker.Stop()

	for {
		select {
		case <-cwdTicker.C:
			h.checkAndBroadcastCwd()

		case info := <-h.register:
			h.mu.Lock()
			// Cancel idle timer if a client connects
			if h.idleTimer != nil {
				h.idleTimer.Stop()
				h.idleTimer = nil
			}
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
			// Start idle timer when last client disconnects
			clientCount := len(h.clients)
			if clientCount == 0 && h.idleTimer == nil {
				h.idleTimer = time.AfterFunc(IdleTimeout, func() {
					close(h.idleChan)
				})
				log.Printf("Hub: no clients, starting %v idle timeout", IdleTimeout)
			}
			h.mu.Unlock()

		case <-h.idleChan:
			// Idle timeout expired with no clients - stop to prevent goroutine leak
			log.Printf("Hub: idle timeout expired, stopping PTY")
			h.Stop()
			return

		case <-h.readLoopDone:
			// PTY read failed - broadcast pty_closed before cleanup
			h.broadcastPtyClosed()
			h.Stop()
			return

		case <-h.stop:
			h.mu.Lock()
			h.turn.Stop()
			// Cancel idle timer if running
			if h.idleTimer != nil {
				h.idleTimer.Stop()
				h.idleTimer = nil
			}
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

// SuppressOutputUntil drops PTY output until the marker is observed.
// If called multiple times before markers are seen, all markers are queued
// and suppression continues until all have been observed.
func (h *Hub) SuppressOutputUntil(marker string) {
	h.suppressMu.Lock()
	defer h.suppressMu.Unlock()
	h.suppressActive = true
	h.suppressMarkers = append(h.suppressMarkers, []byte(marker))
	// Don't reset buffer when adding new markers - keep accumulated data
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
	// Apply secret redaction first - prevents LLM from seeing secret values
	data = h.redactSecrets(data)

	data = h.filterSuppressed(data)
	if len(data) == 0 {
		return
	}

	// Store in scrollback ring buffer (post-redaction)
	h.appendScrollback(data)

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

func (h *Hub) filterSuppressed(data []byte) []byte {
	h.suppressMu.Lock()
	defer h.suppressMu.Unlock()

	if !h.suppressActive || len(h.suppressMarkers) == 0 {
		return data
	}

	combined := append(h.suppressBuffer, data...)

	// Find and remove all markers (in any order they appear)
	// Keep track of the rightmost marker position to know where to resume output
	rightmostEnd := -1
	remainingMarkers := make([][]byte, 0, len(h.suppressMarkers))

	for _, marker := range h.suppressMarkers {
		index := bytes.Index(combined, marker)
		if index == -1 {
			// Marker not found yet - keep it in the list
			remainingMarkers = append(remainingMarkers, marker)
		} else {
			// Found this marker - track where it ends
			endPos := index + len(marker)
			if endPos > rightmostEnd {
				rightmostEnd = endPos
			}
		}
	}

	h.suppressMarkers = remainingMarkers

	if len(remainingMarkers) > 0 {
		// Still waiting for some markers - keep buffering
		// Keep enough tail to detect markers spanning reads
		maxMarkerLen := 0
		for _, m := range remainingMarkers {
			if len(m) > maxMarkerLen {
				maxMarkerLen = len(m)
			}
		}
		tailLen := maxMarkerLen - 1
		if tailLen < 0 {
			tailLen = 0
		}
		if len(combined) > tailLen {
			h.suppressBuffer = combined[len(combined)-tailLen:]
		} else {
			h.suppressBuffer = combined
		}
		return nil
	}

	// All markers found - suppression complete
	// Return everything after the rightmost marker
	h.suppressActive = false
	h.suppressBuffer = nil
	if rightmostEnd >= 0 && rightmostEnd < len(combined) {
		return combined[rightmostEnd:]
	}
	return nil
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
		// Notify owner for cleanup (e.g., remove from session's PTY map)
		if h.onStop != nil {
			h.onStop()
		}
	})
}

// SetOnStop sets a callback invoked when the hub stops.
// Use this to clean up references to the hub (e.g., remove from session's PTY map).
func (h *Hub) SetOnStop(fn func()) {
	h.onStop = fn
}

// IsProcessAlive checks if the PTY's underlying process is still running.
// Returns false if the process has exited or the hub is stopped.
func (h *Hub) IsProcessAlive() bool {
	select {
	case <-h.stop:
		return false
	default:
	}
	select {
	case <-h.pty.Done():
		return false
	default:
		return true
	}
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

// Execute sends text to PTY followed by CR after a brief delay.
// The delay allows the terminal to process the text before execution.
// Only the controller can execute commands.
func (h *Hub) Execute(userID string, text string) (int, error) {
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

	// Write text first
	n, err := h.pty.Write([]byte(text))
	if err != nil {
		return n, err
	}

	// Brief delay to let terminal process the text
	time.Sleep(50 * time.Millisecond)

	// Send CR to execute
	_, err = h.pty.Write([]byte{0x0D})
	return n, err
}

// WriteAgent sends input to the PTY from the agent process.
// Bypasses all human input gates - use only for agent-originated writes.
func (h *Hub) WriteAgent(data []byte) (int, error) {
	return h.pty.Write(data)
}

// WriteAgentSilent sends input to the PTY with echo suppressed.
func (h *Hub) WriteAgentSilent(data []byte) (int, error) {
	return h.pty.WriteSilent(data)
}

// Resize changes the PTY window size and records the dimensions for replay.
func (h *Hub) Resize(cols, rows uint16) error {
	h.mu.Lock()
	h.lastCols = cols
	h.lastRows = rows
	h.mu.Unlock()
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

	// Read current cwd for initial state
	cwd := h.pty.Cwd()
	h.mu.RLock()
	root := h.workspaceRoot
	h.mu.RUnlock()
	if root != "" && strings.HasPrefix(cwd, root) {
		cwd = cwd[len(root):]
		if cwd == "" {
			cwd = "/"
		}
	}
	// Update lastCwd
	h.mu.Lock()
	h.lastCwd = cwd
	h.mu.Unlock()

	event := ControlEvent{
		Type:       "control_state",
		Controller: h.Cоntrоller(),
		Requests:   h.turn.PendingRequests(),
		AgentState: agentState,
		Cwd:        cwd,
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

	// Replay scrollback buffer so reconnecting clients see previous terminal output
	// instead of a blank screen. The raw bytes include ANSI sequences so xterm.js
	// can render them correctly. Data is already post-redaction (secrets stripped).
	// We strip terminal query sequences (DA, DSR, CPR) that would cause xterm.js
	// to send response strings back as PTY input — these leak as phantom keystrokes.
	if raw := h.ScrollbackRaw(0); len(raw) > 0 {
		raw = stripTerminalQueries(raw)
		if len(raw) > 0 {
			replayMsg := HubMessage{IsBinary: true, Data: raw}
			select {
			case client <- replayMsg:
			default:
			}
		}

		// Re-issue resize after replay. The replayed output may contain cursor
		// positioning for a different terminal size, leaving TUI apps confused.
		// A fresh SIGWINCH forces them to query dimensions and redraw correctly.
		h.mu.RLock()
		cols, rows := h.lastCols, h.lastRows
		h.mu.RUnlock()
		if cols > 0 && rows > 0 {
			h.pty.Resize(cols, rows)
		}
	}

	// If the PTY process is already dead, immediately notify the connecting client.
	// This saves the client from waiting for the reconnect watchdog timeout.
	if !h.IsProcessAlive() {
		closedEvent := ControlEvent{Type: "pty_closed"}
		if closedData, err := json.Marshal(closedEvent); err == nil {
			closedMsg := HubMessage{IsBinary: false, Data: closedData}
			select {
			case client <- closedMsg:
			default:
			}
		}
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

// SetWorkspaceRoot sets the workspace root path used to compute relative cwd paths.
func (h *Hub) SetWorkspaceRoot(root string) {
	h.mu.Lock()
	h.workspaceRoot = root
	h.mu.Unlock()
}

// checkAndBroadcastCwd reads the PTY process cwd and broadcasts if it changed.
func (h *Hub) checkAndBroadcastCwd() {
	absCwd := h.pty.Cwd()
	if absCwd == "" {
		return
	}
	// Strip workspace root to get a relative path
	relCwd := absCwd
	h.mu.RLock()
	root := h.workspaceRoot
	h.mu.RUnlock()
	if root != "" && strings.HasPrefix(absCwd, root) {
		relCwd = absCwd[len(root):]
		if relCwd == "" {
			relCwd = "/"
		}
	}
	// Only broadcast if changed
	h.mu.Lock()
	if relCwd == h.lastCwd {
		h.mu.Unlock()
		return
	}
	h.lastCwd = relCwd
	h.mu.Unlock()

	event := CwdEvent{Type: "cwd_changed", Cwd: relCwd}
	data, err := json.Marshal(event)
	if err != nil {
		return
	}
	h.broadcastControl(data)
}

// CurrentCwd returns the last known relative cwd.
func (h *Hub) CurrentCwd() string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.lastCwd
}

// BroadcastAudio sends an audio event to all clients
func (h *Hub) BroadcastAudio(event AudioEvent) {
	event.Type = "audio"
	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("failed to marshal audio event: %v", err)
		return
	}
	h.broadcastControl(data)
}

// BroadcastTtsStatus sends a TTS status event to all clients
func (h *Hub) BroadcastTtsStatus(event TtsStatusEvent) {
	event.Type = "tts_status"
	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("failed to marshal tts status event: %v", err)
		return
	}
	h.broadcastControl(data)
}

// BroadcastTalkitoNotice sends a talkito notice/log event to all clients
func (h *Hub) BroadcastTalkitoNotice(event TalkitoNoticeEvent) {
	event.Type = "talkito_notice"
	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("failed to marshal talkito notice event: %v", err)
		return
	}
	h.broadcastControl(data)
}

// BroadcastAgentStopped sends an agent stopped event to all clients.
// This is called when an agentic coder's native stop hook fires.
func (h *Hub) BroadcastAgentStopped(event AgentStoppedEvent) {
	event.Type = "agent_stopped"
	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("failed to marshal agent stopped event: %v", err)
		return
	}
	h.broadcastControl(data)
}

// SetSecretValues updates the list of secret values to redact from output.
// Values shorter than 8 characters are ignored to prevent false positives.
func (h *Hub) SetSecretValues(values []string) {
	h.secretsMu.Lock()
	defer h.secretsMu.Unlock()
	h.secretValues = values
	h.redactionTail = nil // Reset tail buffer when secrets change
}

// redactSecrets replaces secret values with asterisks in PTY output.
// Uses a tail buffer to handle secrets that may be split across output chunks.
func (h *Hub) redactSecrets(data []byte) []byte {
	h.secretsMu.Lock()
	defer h.secretsMu.Unlock()

	if len(h.secretValues) == 0 {
		return data
	}

	// Find the maximum secret length for cross-chunk buffering
	maxSecretLen := 0
	for _, s := range h.secretValues {
		if len(s) > maxSecretLen {
			maxSecretLen = len(s)
		}
	}

	if maxSecretLen == 0 {
		return data
	}

	// Buffer tail bytes from previous output to catch secrets split across chunks.
	// Keep at most maxSecretLen-1 bytes from the previous output.
	prefixLen := 0
	if len(h.redactionTail) > 0 {
		// Trim tail if it's too long
		if len(h.redactionTail) > maxSecretLen-1 {
			h.redactionTail = h.redactionTail[len(h.redactionTail)-(maxSecretLen-1):]
		}
		prefixLen = len(h.redactionTail)
		// Prepend tail to current data for scanning
		data = append(h.redactionTail, data...)
	}

	// Update tail buffer for next chunk (last maxSecretLen-1 bytes)
	if len(data) >= maxSecretLen-1 {
		h.redactionTail = make([]byte, maxSecretLen-1)
		copy(h.redactionTail, data[len(data)-(maxSecretLen-1):])
	} else {
		h.redactionTail = make([]byte, len(data))
		copy(h.redactionTail, data)
	}

	// Redact each secret value using byte-safe operations (no string conversion)
	result := data
	for _, secret := range h.secretValues {
		secretBytes := []byte(secret)
		if len(secretBytes) >= 8 && bytes.Contains(result, secretBytes) {
			result = bytes.ReplaceAll(result, secretBytes, bytes.Repeat([]byte("*"), len(secretBytes)))
		}
	}

	// Remove the prefix we added from previous chunk's tail
	if prefixLen > 0 && len(result) >= prefixLen {
		result = result[prefixLen:]
	}

	return result
}

// appendScrollback writes data to the ring buffer.
func (h *Hub) appendScrollback(data []byte) {
	h.scrollbackMu.Lock()
	defer h.scrollbackMu.Unlock()

	for _, b := range data {
		h.scrollback[h.scrollbackPos%h.scrollbackMax] = b
		h.scrollbackPos++
	}
}

// Scrollback returns the recent PTY output from the ring buffer, with ANSI escape codes stripped.
func (h *Hub) Scrollback(maxBytes int) string {
	h.scrollbackMu.Lock()
	defer h.scrollbackMu.Unlock()

	total := h.scrollbackPos
	if total == 0 {
		return ""
	}

	size := total
	if size > h.scrollbackMax {
		size = h.scrollbackMax
	}
	if maxBytes > 0 && size > maxBytes {
		size = maxBytes
	}

	// Read from ring buffer in order
	out := make([]byte, size)
	start := h.scrollbackPos - size
	if start < 0 {
		start = 0
	}
	for i := 0; i < size; i++ {
		out[i] = h.scrollback[(start+i)%h.scrollbackMax]
	}

	return stripANSI(string(out))
}

// ScrollbackRaw returns the raw PTY output from the ring buffer (with ANSI codes intact).
// Used for replaying terminal history to reconnecting clients so xterm.js can render it.
func (h *Hub) ScrollbackRaw(maxBytes int) []byte {
	h.scrollbackMu.Lock()
	defer h.scrollbackMu.Unlock()

	total := h.scrollbackPos
	if total == 0 {
		return nil
	}

	size := total
	if size > h.scrollbackMax {
		size = h.scrollbackMax
	}
	if maxBytes > 0 && size > maxBytes {
		size = maxBytes
	}

	out := make([]byte, size)
	start := h.scrollbackPos - size
	if start < 0 {
		start = 0
	}
	for i := 0; i < size; i++ {
		out[i] = h.scrollback[(start+i)%h.scrollbackMax]
	}

	return out
}

// stripTerminalQueries removes CSI sequences that request a response from the
// terminal emulator. During scrollback replay these would cause xterm.js to
// send response strings (e.g. DA response "\x1b[?1;2c") back into the PTY
// where the running application interprets them as user input.
//
// Stripped sequences:
//   - CSI c, CSI 0c, CSI >c, CSI >0c, CSI =c  (Device Attributes DA1/DA2/DA3)
//   - CSI 5n                                     (Device Status Report)
//   - CSI 6n, CSI ?6n                            (Cursor Position Report)
//   - CSI x, CSI 0x, CSI 1x                      (Request Terminal Parameters)
//
// All other CSI sequences (colors, cursor movement, etc.) are preserved.
func stripTerminalQueries(data []byte) []byte {
	result := make([]byte, 0, len(data))
	i := 0
	for i < len(data) {
		// Look for CSI start: ESC [
		if i+1 < len(data) && data[i] == 0x1b && data[i+1] == '[' {
			seqStart := i
			j := i + 2
			// Collect parameter bytes (0x30-0x3f: digits, ;, <, =, >, ?)
			for j < len(data) && data[j] >= 0x30 && data[j] <= 0x3f {
				j++
			}
			// Skip intermediate bytes (0x20-0x2f)
			for j < len(data) && data[j] >= 0x20 && data[j] <= 0x2f {
				j++
			}
			// Check final byte (0x40-0x7e)
			if j < len(data) && data[j] >= 0x40 && data[j] <= 0x7e {
				finalByte := data[j]
				params := string(data[i+2 : j]) // parameter + intermediate bytes before final

				isQuery := false
				switch finalByte {
				case 'c': // Device Attributes (DA1, DA2, DA3)
					// All CSI...c sequences are DA queries/responses
					isQuery = true
				case 'n': // Device Status Report / Cursor Position Report
					isQuery = params == "5" || params == "6" || params == "?6"
				case 'x': // Request Terminal Parameters (DECREQTPARM)
					isQuery = params == "" || params == "0" || params == "1"
				}

				if isQuery {
					i = j + 1 // skip entire sequence
					continue
				}
			}
			// Not a query — keep the sequence
			result = append(result, data[seqStart])
			i = seqStart + 1
			continue
		}
		result = append(result, data[i])
		i++
	}
	return result
}

// stripANSI removes ANSI escape sequences and control characters from a string.
// Handles CSI, OSC, DCS, PM, APC sequences and C0/C1 control codes.
func stripANSI(s string) string {
	var result []byte
	i := 0
	for i < len(s) {
		if s[i] == 0x1b { // ESC
			i++
			if i >= len(s) {
				break
			}
			switch s[i] {
			case '[':
				// CSI sequence: ESC [ ... <final byte 0x40-0x7e>
				i++
				for i < len(s) && (s[i] < 0x40 || s[i] > 0x7e) {
					i++
				}
				if i < len(s) {
					i++ // skip the final byte
				}
			case ']':
				// OSC sequence: skip until ST (ESC \ or BEL)
				i++
				for i < len(s) {
					if s[i] == 0x07 { // BEL
						i++
						break
					}
					if s[i] == 0x1b && i+1 < len(s) && s[i+1] == '\\' {
						i += 2
						break
					}
					i++
				}
			case 'P', '^', '_':
				// DCS (P), PM (^), APC (_): skip until ST
				i++
				for i < len(s) {
					if s[i] == 0x1b && i+1 < len(s) && s[i+1] == '\\' {
						i += 2
						break
					}
					if s[i] == 0x07 {
						i++
						break
					}
					i++
				}
			default:
				i++ // skip single char after ESC (e.g., ESC =, ESC >)
			}
		} else if s[i] == 0x9b {
			// C1 CSI (0x9b): same as ESC [
			i++
			for i < len(s) && (s[i] < 0x40 || s[i] > 0x7e) {
				i++
			}
			if i < len(s) {
				i++
			}
		} else if s[i] < 0x20 && s[i] != '\n' && s[i] != '\r' && s[i] != '\t' {
			// Strip C0 control chars except newline, CR, tab
			i++
		} else {
			result = append(result, s[i])
			i++
		}
	}
	return string(result)
}
