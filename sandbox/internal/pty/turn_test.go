package pty

import (
	"testing"
	"time"
)

func TestTurnControllerInitialState(t *testing.T) {
	tc := NewTurnController()

	if tc.Controller() != "" {
		t.Error("expected no controller initially")
	}

	if tc.HasController() {
		t.Error("expected HasController to be false initially")
	}
}

func TestTurnControllerTakeControl(t *testing.T) {
	tc := NewTurnController()

	// First user can take control when no one has it
	ok := tc.TakeControl("user1")
	if !ok {
		t.Error("expected first user to take control")
	}

	if tc.Controller() != "user1" {
		t.Errorf("expected controller to be user1, got %s", tc.Controller())
	}

	// Second user cannot take control
	ok = tc.TakeControl("user2")
	if ok {
		t.Error("expected second user to fail taking control")
	}

	if tc.Controller() != "user1" {
		t.Errorf("expected controller to still be user1, got %s", tc.Controller())
	}
}

func TestTurnControllerRequestGrant(t *testing.T) {
	tc := NewTurnController()

	tc.TakeControl("user1")

	// user2 requests control
	tc.RequestControl("user2")

	requests := tc.PendingRequests()
	if len(requests) != 1 || requests[0] != "user2" {
		t.Errorf("expected pending request from user2, got %v", requests)
	}

	// user1 grants control to user2
	ok := tc.GrantControl("user1", "user2")
	if !ok {
		t.Error("expected grant to succeed")
	}

	if tc.Controller() != "user2" {
		t.Errorf("expected controller to be user2, got %s", tc.Controller())
	}

	// Pending requests should be cleared for user2
	requests = tc.PendingRequests()
	for _, r := range requests {
		if r == "user2" {
			t.Error("user2 should not be in pending requests after grant")
		}
	}
}

func TestTurnControllerGrantOnlyByController(t *testing.T) {
	tc := NewTurnController()

	tc.TakeControl("user1")
	tc.RequestControl("user2")

	// user3 tries to grant (not the controller)
	ok := tc.GrantControl("user3", "user2")
	if ok {
		t.Error("expected grant by non-controller to fail")
	}

	if tc.Controller() != "user1" {
		t.Errorf("expected controller to still be user1, got %s", tc.Controller())
	}
}

func TestTurnControllerRevokeControl(t *testing.T) {
	tc := NewTurnController()

	tc.TakeControl("user1")

	// Controller revokes their own control
	ok := tc.RevokeControl("user1")
	if !ok {
		t.Error("expected revoke to succeed")
	}

	if tc.HasController() {
		t.Error("expected no controller after revoke")
	}
}

func TestTurnControllerRevokeOnlyByController(t *testing.T) {
	tc := NewTurnController()

	tc.TakeControl("user1")

	// user2 tries to revoke (not the controller)
	ok := tc.RevokeControl("user2")
	if ok {
		t.Error("expected revoke by non-controller to fail")
	}

	if tc.Controller() != "user1" {
		t.Errorf("expected controller to still be user1, got %s", tc.Controller())
	}
}

func TestTurnControllerIsCоntrоller(t *testing.T) {
	tc := NewTurnController()

	tc.TakeControl("user1")

	if !tc.IsController("user1") {
		t.Error("expected user1 to be controller")
	}

	if tc.IsController("user2") {
		t.Error("expected user2 to not be controller")
	}
}

func TestTurnControllerDisconnectGracePeriod(t *testing.T) {
	tc := NewTurnController()
	tc.SetGracePeriod(100 * time.Millisecond) // Short for testing

	tc.TakeControl("user1")

	// Disconnect starts grace period
	tc.Disconnect("user1")

	// Should still be controller during grace period
	if tc.Controller() != "user1" {
		t.Error("expected user1 to still be controller during grace period")
	}

	// But marked as disconnected
	if !tc.IsDisconnected("user1") {
		t.Error("expected user1 to be marked as disconnected")
	}

	// Reconnect within grace period
	tc.Reconnect("user1")

	if tc.IsDisconnected("user1") {
		t.Error("expected user1 to no longer be disconnected after reconnect")
	}

	if tc.Controller() != "user1" {
		t.Error("expected user1 to still be controller after reconnect")
	}
}

func TestTurnControllerGracePeriodExpiry(t *testing.T) {
	tc := NewTurnController()
	tc.SetGracePeriod(50 * time.Millisecond)

	tc.TakeControl("user1")
	tc.Disconnect("user1")

	// Wait for grace period to expire
	time.Sleep(100 * time.Millisecond)

	// Control should be released
	if tc.HasController() {
		t.Error("expected no controller after grace period expired")
	}
}

func TestTurnControllerOnExpireCallback(t *testing.T) {
	tc := NewTurnController()
	tc.SetGracePeriod(50 * time.Millisecond)

	var expiredUser string
	var callbackCalled bool
	tc.SetOnExpire(func(userID string) {
		callbackCalled = true
		expiredUser = userID
	})

	tc.TakeControl("user1")
	tc.Disconnect("user1")

	// Wait for grace period to expire
	time.Sleep(100 * time.Millisecond)

	if !callbackCalled {
		t.Error("expected onExpire callback to be called")
	}

	if expiredUser != "user1" {
		t.Errorf("expected expired user to be 'user1', got %q", expiredUser)
	}
}

func TestTurnControllerOnExpireNotCalledIfReconnected(t *testing.T) {
	tc := NewTurnController()
	tc.SetGracePeriod(50 * time.Millisecond)

	var callbackCalled bool
	tc.SetOnExpire(func(userID string) {
		callbackCalled = true
	})

	tc.TakeControl("user1")
	tc.Disconnect("user1")

	// Reconnect before grace period expires
	time.Sleep(20 * time.Millisecond)
	tc.Reconnect("user1")

	// Wait past the original grace period
	time.Sleep(50 * time.Millisecond)

	if callbackCalled {
		t.Error("expected onExpire callback NOT to be called after reconnect")
	}

	if tc.Controller() != "user1" {
		t.Error("expected user1 to still be controller")
	}
}

func TestTurnControllerMultipleRequests(t *testing.T) {
	tc := NewTurnController()

	tc.TakeControl("user1")

	tc.RequestControl("user2")
	tc.RequestControl("user3")
	tc.RequestControl("user2") // Duplicate should be ignored

	requests := tc.PendingRequests()
	if len(requests) != 2 {
		t.Errorf("expected 2 pending requests, got %d", len(requests))
	}
}

func TestTurnControllerCancelRequest(t *testing.T) {
	tc := NewTurnController()

	tc.TakeControl("user1")
	tc.RequestControl("user2")

	tc.CancelRequest("user2")

	requests := tc.PendingRequests()
	if len(requests) != 0 {
		t.Errorf("expected 0 pending requests after cancel, got %d", len(requests))
	}
}

func TestTurnControllerConcurrentAccess(t *testing.T) {
	tc := NewTurnController()

	done := make(chan bool)

	// Multiple goroutines trying to take control
	for i := 0; i < 10; i++ {
		go func(id int) {
			tc.TakeControl(string(rune('a' + id)))
			tc.Controller()
			tc.HasController()
			done <- true
		}(i)
	}

	for i := 0; i < 10; i++ {
		<-done
	}

	// Should have exactly one controller
	if !tc.HasController() {
		t.Error("expected exactly one controller")
	}
}
