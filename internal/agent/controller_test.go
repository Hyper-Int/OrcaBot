package agent

import (
	"testing"
	"time"
)

func TestAgentControllerCreate(t *testing.T) {
	ac, err := NewController("test-agent", "/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create agent controller: %v", err)
	}
	defer ac.Stop()

	if ac.ID() != "test-agent" {
		t.Errorf("expected ID 'test-agent', got '%s'", ac.ID())
	}

	if ac.State() != StateRunning {
		t.Errorf("expected state Running, got %s", ac.State())
	}
}

func TestAgentControllerPauseResume(t *testing.T) {
	ac, err := NewController("test-agent", "/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create agent controller: %v", err)
	}
	defer ac.Stop()

	// Pause
	err = ac.Pause()
	if err != nil {
		t.Fatalf("pause failed: %v", err)
	}

	if ac.State() != StatePaused {
		t.Errorf("expected state Paused, got %s", ac.State())
	}

	// Resume
	err = ac.Resume()
	if err != nil {
		t.Fatalf("resume failed: %v", err)
	}

	if ac.State() != StateRunning {
		t.Errorf("expected state Running after resume, got %s", ac.State())
	}
}

func TestAgentControllerStop(t *testing.T) {
	ac, err := NewController("test-agent", "/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create agent controller: %v", err)
	}

	err = ac.Stop()
	if err != nil {
		t.Fatalf("stop failed: %v", err)
	}

	if ac.State() != StateStopped {
		t.Errorf("expected state Stopped, got %s", ac.State())
	}
}

func TestAgentControllerStopEscalation(t *testing.T) {
	// Start a process that ignores SIGINT
	ac, err := NewController("test-agent", "/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create agent controller: %v", err)
	}

	// Start a command that traps SIGINT
	ac.Write([]byte("trap '' INT; sleep 100\n"))
	time.Sleep(100 * time.Millisecond)

	// Stop should still work (escalates to SIGTERM/SIGKILL)
	done := make(chan error)
	go func() {
		done <- ac.Stop()
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("stop failed: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("stop timed out - escalation may not be working")
	}

	if ac.State() != StateStopped {
		t.Errorf("expected state Stopped, got %s", ac.State())
	}
}

func TestAgentControllerHub(t *testing.T) {
	ac, err := NewController("test-agent", "/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create agent controller: %v", err)
	}
	defer ac.Stop()

	hub := ac.Hub()
	if hub == nil {
		t.Fatal("expected non-nil hub")
	}

	// Hub should allow registering clients
	client := make(chan []byte, 100)
	hub.Register(client)

	// Write to agent
	ac.Write([]byte("echo agent_test\n"))

	// Should receive output
	timeout := time.After(3 * time.Second)
	for {
		select {
		case data := <-client:
			if len(data) > 0 {
				return // Success - got some output
			}
		case <-timeout:
			t.Fatal("timeout waiting for output")
		}
	}
}

func TestAgentControllerWriteWhenPaused(t *testing.T) {
	ac, err := NewController("test-agent", "/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create agent controller: %v", err)
	}
	defer ac.Stop()

	ac.Pause()

	// Write should still queue (for when resumed)
	_, err = ac.Write([]byte("echo test\n"))
	// Write to paused agent might error or queue - implementation dependent
	// Just ensure it doesn't panic
}

func TestAgentControllerWriteWhenStopped(t *testing.T) {
	ac, err := NewController("test-agent", "/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create agent controller: %v", err)
	}

	ac.Stop()

	// Write to stopped agent should error
	_, err = ac.Write([]byte("echo test\n"))
	if err == nil {
		t.Error("expected error writing to stopped agent")
	}
}

func TestAgentControllerDoubleStop(t *testing.T) {
	ac, err := NewController("test-agent", "/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create agent controller: %v", err)
	}

	err = ac.Stop()
	if err != nil {
		t.Fatalf("first stop failed: %v", err)
	}

	// Second stop should be safe (no-op)
	err = ac.Stop()
	if err != nil {
		t.Fatalf("second stop failed: %v", err)
	}
}

func TestAgentControllerRunCommand(t *testing.T) {
	ac, err := NewController("test-agent", "/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create agent controller: %v", err)
	}
	defer ac.Stop()

	// Run a command and capture output
	output, err := ac.RunCommand("echo hello_from_agent", 5*time.Second)
	if err != nil {
		t.Fatalf("run command failed: %v", err)
	}

	if len(output) == 0 {
		t.Error("expected non-empty output")
	}
}

func TestAgentSoftLockBlocksHumanInput(t *testing.T) {
	ac, err := NewController("test-agent", "/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create agent controller: %v", err)
	}
	defer ac.Stop()

	hub := ac.Hub()

	// Agent hub should start with agent mode enabled and running
	if !hub.IsAgentRunning() {
		t.Error("expected hub to be in agent running mode")
	}

	// Human input via hub.Write should be silently dropped when agent is running
	// First, a human needs to take control (which should work)
	hub.TakeControl("human1")

	// But writing should be blocked because agent is running
	n, err := hub.Write("human1", []byte("echo human_input\n"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 0 {
		t.Error("expected human input to be dropped (0 bytes written) while agent is running")
	}
}

func TestAgentSoftLockAllowsInputWhenPaused(t *testing.T) {
	ac, err := NewController("test-agent", "/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create agent controller: %v", err)
	}
	defer ac.Stop()

	hub := ac.Hub()

	// Pause the agent
	if err := ac.Pause(); err != nil {
		t.Fatalf("failed to pause: %v", err)
	}

	// Hub should no longer be in "agent running" mode
	if hub.IsAgentRunning() {
		t.Error("expected hub to NOT be in agent running mode after pause")
	}

	// Human takes control
	hub.TakeControl("human1")

	// Human input should now be allowed
	n, err := hub.Write("human1", []byte("echo human_input\n"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n == 0 {
		t.Error("expected human input to be allowed when agent is paused")
	}
}

func TestAgentSoftLockResumeBlocksHumanInput(t *testing.T) {
	ac, err := NewController("test-agent", "/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create agent controller: %v", err)
	}
	defer ac.Stop()

	hub := ac.Hub()

	// Pause and let human take control
	ac.Pause()
	hub.TakeControl("human1")

	// Resume the agent
	if err := ac.Resume(); err != nil {
		t.Fatalf("failed to resume: %v", err)
	}

	// Human input should be blocked again
	if !hub.IsAgentRunning() {
		t.Error("expected hub to be in agent running mode after resume")
	}

	n, err := hub.Write("human1", []byte("echo human_input\n"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 0 {
		t.Error("expected human input to be dropped after agent resumes")
	}
}
