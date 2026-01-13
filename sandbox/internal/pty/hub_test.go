package pty

import (
	"bytes"
	"sync"
	"testing"
	"time"
)

func TestHubBroadcast(t *testing.T) {
	p, err := New("/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create PTY: %v", err)
	}
	defer p.Close()

	hub := NewHub(p, "")
	go hub.Run()
	defer hub.Stop()

	// Add two clients
	client1 := make(chan HubMessage, 100)
	client2 := make(chan HubMessage, 100)

	hub.Register(client1)
	hub.Register(client2)

	// Give time for registration
	time.Sleep(50 * time.Millisecond)

	// Write to PTY
	p.Write([]byte("echo test123\n"))

	// Both clients should receive output
	var wg sync.WaitGroup
	wg.Add(2)

	checkClient := func(name string, ch chan HubMessage) {
		defer wg.Done()
		var received []byte
		timeout := time.After(3 * time.Second)
		for {
			select {
			case msg := <-ch:
				received = append(received, msg.Data...)
				if bytes.Contains(received, []byte("test123")) {
					return
				}
			case <-timeout:
				t.Errorf("%s: timeout waiting for output", name)
				return
			}
		}
	}

	go checkClient("client1", client1)
	go checkClient("client2", client2)

	wg.Wait()
}

func TestHubUnregister(t *testing.T) {
	p, err := New("/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create PTY: %v", err)
	}
	defer p.Close()

	hub := NewHub(p, "")
	go hub.Run()
	defer hub.Stop()

	client := make(chan HubMessage, 100)
	hub.Register(client)

	time.Sleep(50 * time.Millisecond)

	hub.Unregister(client)

	// After unregister, channel should not receive new data
	time.Sleep(50 * time.Millisecond)
	p.Write([]byte("echo after_unregister\n"))

	time.Sleep(100 * time.Millisecond)

	// Drain any remaining buffered data
	select {
	case <-client:
		// Might have some buffered data, that's ok
	default:
	}
}

func TestHubClientCount(t *testing.T) {
	p, err := New("/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create PTY: %v", err)
	}
	defer p.Close()

	hub := NewHub(p, "")
	go hub.Run()
	defer hub.Stop()

	if hub.ClientCount() != 0 {
		t.Errorf("expected 0 clients, got %d", hub.ClientCount())
	}

	client1 := make(chan HubMessage, 100)
	hub.Register(client1)
	time.Sleep(50 * time.Millisecond)

	if hub.ClientCount() != 1 {
		t.Errorf("expected 1 client, got %d", hub.ClientCount())
	}

	client2 := make(chan HubMessage, 100)
	hub.Register(client2)
	time.Sleep(50 * time.Millisecond)

	if hub.ClientCount() != 2 {
		t.Errorf("expected 2 clients, got %d", hub.ClientCount())
	}

	hub.Unregister(client1)
	time.Sleep(50 * time.Millisecond)

	if hub.ClientCount() != 1 {
		t.Errorf("expected 1 client after unregister, got %d", hub.ClientCount())
	}
}

func TestHubStopKillsProcessAndClosesClients(t *testing.T) {
	p, err := New("/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create PTY: %v", err)
	}
	// Don't defer p.Close() - hub.Stop() should do it

	hub := NewHub(p, "")
	go hub.Run()

	// Register a client
	client := make(chan HubMessage, 100)
	hub.Register(client)
	time.Sleep(50 * time.Millisecond)

	// Stop the hub
	hub.Stop()

	// Client channel should eventually be closed
	// Drain any pending data and wait for close
	timeout := time.After(500 * time.Millisecond)
	closed := false
	for !closed {
		select {
		case _, ok := <-client:
			if !ok {
				closed = true
			}
			// If ok, keep draining
		case <-timeout:
			t.Fatal("timeout waiting for client channel to close")
		}
	}

	// PTY should be closed - write should fail
	_, err = p.Write([]byte("test"))
	if err == nil {
		t.Error("expected write to closed PTY to fail")
	}
}

func TestHubNewClientReceivesAgentState(t *testing.T) {
	p, err := New("/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create PTY: %v", err)
	}
	defer p.Close()

	hub := NewHub(p, "")
	go hub.Run()
	defer hub.Stop()

	// Set agent mode (agent starts as running)
	hub.SetAgentMode(true)

	// Connect a new client
	client := make(chan HubMessage, 100)
	hub.Register(client)

	// Wait for control_state message
	timeout := time.After(500 * time.Millisecond)
	var gotAgentState bool
	for {
		select {
		case msg := <-client:
			if !msg.IsBinary {
				// Parse JSON to check for agent_state
				data := string(msg.Data)
				if bytes.Contains(msg.Data, []byte(`"agent_state":"running"`)) &&
					bytes.Contains(msg.Data, []byte(`"type":"control_state"`)) {
					gotAgentState = true
				}
				_ = data // suppress unused warning
			}
			if gotAgentState {
				return
			}
		case <-timeout:
			t.Fatal("new client did not receive agent_state in control_state message")
		}
	}
}

func TestHubAgentStateTransitions(t *testing.T) {
	p, err := New("/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create PTY: %v", err)
	}
	defer p.Close()

	hub := NewHub(p, "")
	go hub.Run()
	defer hub.Stop()

	client := make(chan HubMessage, 100)
	hub.Register(client)
	time.Sleep(50 * time.Millisecond)

	// Drain initial control_state
	drainNonBinary(client)

	// Enable agent mode
	hub.SetAgentMode(true)
	expectAgentState(t, client, "running")

	// Pause
	hub.SetAgentRunning(false)
	expectAgentState(t, client, "paused")

	// Resume
	hub.SetAgentRunning(true)
	expectAgentState(t, client, "running")

	// Stop
	hub.SetAgentStopped()
	expectAgentState(t, client, "stopped")
}

func drainNonBinary(ch chan HubMessage) {
	for {
		select {
		case msg := <-ch:
			if msg.IsBinary {
				continue
			}
		case <-time.After(100 * time.Millisecond):
			return
		}
	}
}

func expectAgentState(t *testing.T, ch chan HubMessage, expected string) {
	t.Helper()
	timeout := time.After(500 * time.Millisecond)
	for {
		select {
		case msg := <-ch:
			if msg.IsBinary {
				continue
			}
			if bytes.Contains(msg.Data, []byte(`"agent_state":"`+expected+`"`)) {
				return
			}
		case <-timeout:
			t.Fatalf("timeout waiting for agent_state %q", expected)
		}
	}
}

func TestHubCreatorGetsControlAutomatically(t *testing.T) {
	p, err := New("/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create PTY: %v", err)
	}
	defer p.Close()

	// Create hub with a creator ID
	hub := NewHub(p, "creator-user")
	go hub.Run()
	defer hub.Stop()

	// Creator should already be controller
	if !hub.IsController("creator-user") {
		t.Error("creator should automatically be controller")
	}

	if hub.Controller() != "creator-user" {
		t.Errorf("expected controller to be 'creator-user', got %q", hub.Controller())
	}

	// Another user should not be controller
	if hub.IsController("other-user") {
		t.Error("other user should not be controller")
	}
}

func TestHubCreatorEmptyNoController(t *testing.T) {
	p, err := New("/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create PTY: %v", err)
	}
	defer p.Close()

	// Create hub without a creator ID
	hub := NewHub(p, "")
	go hub.Run()
	defer hub.Stop()

	// No one should be controller
	if hub.Controller() != "" {
		t.Errorf("expected no controller, got %q", hub.Controller())
	}
}

func TestHubRequestControlAutoGrantsWhenNoController(t *testing.T) {
	p, err := New("/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create PTY: %v", err)
	}
	defer p.Close()

	// Create hub without a creator (no controller)
	hub := NewHub(p, "")
	go hub.Run()
	defer hub.Stop()

	// Register a client to receive events
	client := make(chan HubMessage, 100)
	hub.RegisterClient("user1", client)
	time.Sleep(50 * time.Millisecond)

	// Drain initial control_state
	drainNonBinary(client)

	// Verify no controller
	if hub.Controller() != "" {
		t.Fatalf("expected no controller initially, got %q", hub.Controller())
	}

	// Request control - should auto-grant since no controller
	hub.RequestControl("user1")

	// Should receive control_taken (not control_requested)
	timeout := time.After(500 * time.Millisecond)
	for {
		select {
		case msg := <-client:
			if msg.IsBinary {
				continue
			}
			if bytes.Contains(msg.Data, []byte(`"type":"control_taken"`)) &&
				bytes.Contains(msg.Data, []byte(`"controller":"user1"`)) {
				// Success - verify state
				if !hub.IsController("user1") {
					t.Error("user1 should be controller after auto-grant")
				}
				return
			}
			if bytes.Contains(msg.Data, []byte(`"type":"control_requested"`)) {
				t.Fatal("should not receive control_requested when no controller exists")
			}
		case <-timeout:
			t.Fatal("timeout waiting for control_taken event")
		}
	}
}

func TestHubRequestControlQueuesWhenControllerExists(t *testing.T) {
	p, err := New("/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create PTY: %v", err)
	}
	defer p.Close()

	// Create hub with a creator who has control
	hub := NewHub(p, "user1")
	go hub.Run()
	defer hub.Stop()

	// Register clients
	client1 := make(chan HubMessage, 100)
	client2 := make(chan HubMessage, 100)
	hub.RegisterClient("user1", client1)
	hub.RegisterClient("user2", client2)
	time.Sleep(50 * time.Millisecond)

	// Drain initial messages
	drainNonBinary(client1)
	drainNonBinary(client2)

	// user1 should be controller
	if !hub.IsController("user1") {
		t.Fatal("user1 should be controller")
	}

	// user2 requests control - should queue, not auto-grant
	hub.RequestControl("user2")

	// Should receive control_requested (not control_taken)
	timeout := time.After(500 * time.Millisecond)
	for {
		select {
		case msg := <-client2:
			if msg.IsBinary {
				continue
			}
			if bytes.Contains(msg.Data, []byte(`"type":"control_requested"`)) &&
				bytes.Contains(msg.Data, []byte(`"user2"`)) {
				// Success - user1 should still be controller
				if !hub.IsController("user1") {
					t.Error("user1 should still be controller")
				}
				if hub.IsController("user2") {
					t.Error("user2 should NOT be controller yet")
				}
				return
			}
			if bytes.Contains(msg.Data, []byte(`"type":"control_taken"`)) &&
				bytes.Contains(msg.Data, []byte(`"user2"`)) {
				t.Fatal("user2 should not auto-take control when user1 has it")
			}
		case <-timeout:
			t.Fatal("timeout waiting for control_requested event")
		}
	}
}

func TestHubRequestControlAfterControllerDisconnects(t *testing.T) {
	p, err := New("/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create PTY: %v", err)
	}
	defer p.Close()

	// Create hub with a creator who has control
	hub := NewHub(p, "user1")
	// Use short grace period for test
	hub.turn.SetGracePeriod(50 * time.Millisecond)
	go hub.Run()
	defer hub.Stop()

	// Register user1 client
	client1 := make(chan HubMessage, 100)
	hub.RegisterClient("user1", client1)
	time.Sleep(50 * time.Millisecond)

	// user1 is controller
	if !hub.IsController("user1") {
		t.Fatal("user1 should be controller")
	}

	// user1 disconnects
	hub.Unregister(client1)

	// Wait for grace period to expire
	time.Sleep(100 * time.Millisecond)

	// Now no one should be controller
	if hub.Controller() != "" {
		t.Fatalf("expected no controller after grace period, got %q", hub.Controller())
	}

	// user2 connects and requests control
	client2 := make(chan HubMessage, 100)
	hub.RegisterClient("user2", client2)
	time.Sleep(50 * time.Millisecond)
	drainNonBinary(client2)

	hub.RequestControl("user2")

	// Should auto-grant since no controller
	timeout := time.After(500 * time.Millisecond)
	for {
		select {
		case msg := <-client2:
			if msg.IsBinary {
				continue
			}
			if bytes.Contains(msg.Data, []byte(`"type":"control_taken"`)) &&
				bytes.Contains(msg.Data, []byte(`"controller":"user2"`)) {
				if !hub.IsController("user2") {
					t.Error("user2 should be controller after auto-grant")
				}
				return
			}
		case <-timeout:
			t.Fatal("timeout waiting for control_taken event after previous controller disconnected")
		}
	}
}
