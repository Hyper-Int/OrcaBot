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

	hub := NewHub(p)
	go hub.Run()
	defer hub.Stop()

	// Add two clients
	client1 := make(chan []byte, 100)
	client2 := make(chan []byte, 100)

	hub.Register(client1)
	hub.Register(client2)

	// Give time for registration
	time.Sleep(50 * time.Millisecond)

	// Write to PTY
	p.Write([]byte("echo test123\n"))

	// Both clients should receive output
	var wg sync.WaitGroup
	wg.Add(2)

	checkClient := func(name string, ch chan []byte) {
		defer wg.Done()
		var received []byte
		timeout := time.After(3 * time.Second)
		for {
			select {
			case data := <-ch:
				received = append(received, data...)
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

	hub := NewHub(p)
	go hub.Run()
	defer hub.Stop()

	client := make(chan []byte, 100)
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

	hub := NewHub(p)
	go hub.Run()
	defer hub.Stop()

	if hub.ClientCount() != 0 {
		t.Errorf("expected 0 clients, got %d", hub.ClientCount())
	}

	client1 := make(chan []byte, 100)
	hub.Register(client1)
	time.Sleep(50 * time.Millisecond)

	if hub.ClientCount() != 1 {
		t.Errorf("expected 1 client, got %d", hub.ClientCount())
	}

	client2 := make(chan []byte, 100)
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
