package pty

import (
	"sync"
	"time"
)

const DefaultGracePeriod = 10 * time.Second

// TurnController manages turn-taking for a PTY
type TurnController struct {
	mu sync.RWMutex

	controller   string            // Current controller user ID
	disconnected map[string]bool   // Users currently disconnected
	graceTimers  map[string]*time.Timer // Grace period timers
	requests     []string          // Pending control requests (ordered)
	gracePeriod  time.Duration
	onExpire     func(userID string) // Callback when grace period expires
}

// NewTurnController creates a new turn controller
func NewTurnController() *TurnController {
	return &TurnController{
		disconnected: make(map[string]bool),
		graceTimers:  make(map[string]*time.Timer),
		requests:     make([]string, 0),
		gracePeriod:  DefaultGracePeriod,
	}
}

// SetGracePeriod sets the grace period for disconnected controllers
func (tc *TurnController) SetGracePeriod(d time.Duration) {
	tc.mu.Lock()
	defer tc.mu.Unlock()
	tc.gracePeriod = d
}

// SetOnExpire sets the callback invoked when a controller's grace period expires
func (tc *TurnController) SetOnExpire(fn func(userID string)) {
	tc.mu.Lock()
	defer tc.mu.Unlock()
	tc.onExpire = fn
}

// Controller returns the current controller's user ID
func (tc *TurnController) Controller() string {
	tc.mu.RLock()
	defer tc.mu.RUnlock()
	return tc.controller
}

// HasController returns true if there is a current controller
func (tc *TurnController) HasController() bool {
	tc.mu.RLock()
	defer tc.mu.RUnlock()
	return tc.controller != ""
}

// IsController checks if the given user is the current controller
func (tc *TurnController) IsController(userID string) bool {
	tc.mu.RLock()
	defer tc.mu.RUnlock()
	return tc.controller == userID
}

// TakeControl attempts to take control (only succeeds if no one has control)
func (tc *TurnController) TakeControl(userID string) bool {
	tc.mu.Lock()
	defer tc.mu.Unlock()

	if tc.controller != "" {
		return false
	}

	tc.controller = userID
	delete(tc.disconnected, userID)
	tc.removeRequestLocked(userID)
	return true
}

// RequestControl adds a request for control
func (tc *TurnController) RequestControl(userID string) {
	tc.mu.Lock()
	defer tc.mu.Unlock()

	// Don't add if already controller
	if tc.controller == userID {
		return
	}

	// Don't add duplicate requests
	for _, r := range tc.requests {
		if r == userID {
			return
		}
	}

	tc.requests = append(tc.requests, userID)
}

// CancelRequest removes a pending control request
func (tc *TurnController) CancelRequest(userID string) {
	tc.mu.Lock()
	defer tc.mu.Unlock()
	tc.removeRequestLocked(userID)
}

// PendingRequests returns the list of pending control requests
func (tc *TurnController) PendingRequests() []string {
	tc.mu.RLock()
	defer tc.mu.RUnlock()

	result := make([]string, len(tc.requests))
	copy(result, tc.requests)
	return result
}

// GrantControl transfers control from the current controller to another user
func (tc *TurnController) GrantControl(fromUserID, toUserID string) bool {
	tc.mu.Lock()
	defer tc.mu.Unlock()

	// Only the current controller can grant control
	if tc.controller != fromUserID {
		return false
	}

	tc.controller = toUserID
	delete(tc.disconnected, toUserID)
	tc.removeRequestLocked(toUserID)

	// Cancel old controller's grace timer if any
	if timer, ok := tc.graceTimers[fromUserID]; ok {
		timer.Stop()
		delete(tc.graceTimers, fromUserID)
	}

	return true
}

// RevokeControl releases control (only the controller can revoke)
func (tc *TurnController) RevokeControl(userID string) bool {
	tc.mu.Lock()
	defer tc.mu.Unlock()

	if tc.controller != userID {
		return false
	}

	tc.controller = ""
	delete(tc.disconnected, userID)

	if timer, ok := tc.graceTimers[userID]; ok {
		timer.Stop()
		delete(tc.graceTimers, userID)
	}

	return true
}

// Disconnect marks a user as disconnected and starts grace period if controller
func (tc *TurnController) Disconnect(userID string) {
	tc.mu.Lock()
	defer tc.mu.Unlock()

	tc.disconnected[userID] = true

	// Start grace period timer if this is the controller
	if tc.controller == userID {
		// Cancel existing timer if any
		if timer, ok := tc.graceTimers[userID]; ok {
			timer.Stop()
		}

		tc.graceTimers[userID] = time.AfterFunc(tc.gracePeriod, func() {
			tc.expireGracePeriod(userID)
		})
	}
}

// Reconnect marks a user as reconnected and cancels grace period
func (tc *TurnController) Reconnect(userID string) {
	tc.mu.Lock()
	defer tc.mu.Unlock()

	delete(tc.disconnected, userID)

	if timer, ok := tc.graceTimers[userID]; ok {
		timer.Stop()
		delete(tc.graceTimers, userID)
	}
}

// IsDisconnected checks if a user is currently disconnected
func (tc *TurnController) IsDisconnected(userID string) bool {
	tc.mu.RLock()
	defer tc.mu.RUnlock()
	return tc.disconnected[userID]
}

// expireGracePeriod is called when the grace period expires
func (tc *TurnController) expireGracePeriod(userID string) {
	var expired bool
	var callback func(string)

	tc.mu.Lock()
	// Only expire if still disconnected and still controller
	if tc.disconnected[userID] && tc.controller == userID {
		tc.controller = ""
		delete(tc.disconnected, userID)
		expired = true
		callback = tc.onExpire
	}
	delete(tc.graceTimers, userID)
	tc.mu.Unlock()

	// Call callback outside lock to avoid deadlock
	if expired && callback != nil {
		callback(userID)
	}
}

// removeRequestLocked removes a user from the pending requests (must hold lock)
func (tc *TurnController) removeRequestLocked(userID string) {
	for i, r := range tc.requests {
		if r == userID {
			tc.requests = append(tc.requests[:i], tc.requests[i+1:]...)
			return
		}
	}
}

// Stop cleans up any running timers
func (tc *TurnController) Stop() {
	tc.mu.Lock()
	defer tc.mu.Unlock()

	for _, timer := range tc.graceTimers {
		timer.Stop()
	}
	tc.graceTimers = make(map[string]*time.Timer)
}
