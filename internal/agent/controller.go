package agent

import (
	"bytes"
	"errors"
	"sync"
	"time"

	"github.com/hyper-ai-inc/hyper-backend/internal/pty"
)

// State represents the agent's current state
type State string

const (
	StateRunning State = "running"
	StatePaused  State = "paused"
	StateStopped State = "stopped"
)

var (
	ErrAgentStopped = errors.New("agent is stopped")
	ErrAgentPaused  = errors.New("agent is paused")
	ErrStopTimeout  = errors.New("agent stop timed out")
)

// Controller manages an agent process (like Claude Code)
type Controller struct {
	id    string
	pty   *pty.PTY
	hub   *pty.Hub
	state State

	mu sync.RWMutex
}

// NewController creates a new agent controller
func NewController(id, shell string, cols, rows uint16) (*Controller, error) {
	p, err := pty.New(shell, cols, rows)
	if err != nil {
		return nil, err
	}

	hub := pty.NewHub(p, "") // Agent PTYs have no human creator
	hub.SetAgentMode(true)   // Enable agent mode - blocks human input while running
	go hub.Run()

	return &Controller{
		id:    id,
		pty:   p,
		hub:   hub,
		state: StateRunning,
	}, nil
}

// ID returns the agent's identifier
func (c *Controller) ID() string {
	return c.id
}

// State returns the agent's current state
func (c *Controller) State() State {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.state
}

// Hub returns the PTY hub for WebSocket connections
func (c *Controller) Hub() *pty.Hub {
	return c.hub
}

// Write sends input to the agent
func (c *Controller) Write(data []byte) (int, error) {
	c.mu.RLock()
	state := c.state
	c.mu.RUnlock()

	if state == StateStopped {
		return 0, ErrAgentStopped
	}

	return c.pty.Write(data)
}

// Pause sends SIGSTOP to pause the agent
func (c *Controller) Pause() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.state == StateStopped {
		return ErrAgentStopped
	}

	if c.state == StatePaused {
		return nil // Already paused
	}

	if err := c.pty.Signal(pty.SIGSTOP); err != nil {
		return err
	}

	c.state = StatePaused
	c.hub.SetAgentRunning(false) // Allow human input while paused
	return nil
}

// Resume sends SIGCONT to resume the agent
func (c *Controller) Resume() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.state == StateStopped {
		return ErrAgentStopped
	}

	if c.state == StateRunning {
		return nil // Already running
	}

	if err := c.pty.Signal(pty.SIGCONT); err != nil {
		return err
	}

	c.state = StateRunning
	c.hub.SetAgentRunning(true) // Block human input while running
	return nil
}

// Stop terminates the agent using escalating signals:
// 1. SIGINT (3 times with 500ms delay)
// 2. SIGTERM (wait 1s)
// 3. SIGKILL
func (c *Controller) Stop() error {
	c.mu.Lock()
	if c.state == StateStopped {
		c.mu.Unlock()
		return nil
	}
	c.mu.Unlock()

	// If paused, resume first so it can receive signals
	c.Resume()

	done := c.pty.Done()

	// Try SIGINT 3 times
	for i := 0; i < 3; i++ {
		c.pty.Signal(pty.SIGINT)
		select {
		case <-done:
			c.markStopped()
			return nil
		case <-time.After(500 * time.Millisecond):
		}
	}

	// Try SIGTERM
	c.pty.Signal(pty.SIGTERM)
	select {
	case <-done:
		c.markStopped()
		return nil
	case <-time.After(1 * time.Second):
	}

	// Force SIGKILL
	c.pty.Signal(pty.SIGKILL)
	select {
	case <-done:
		c.markStopped()
		return nil
	case <-time.After(1 * time.Second):
		// Process should be dead by now, but close PTY anyway
		c.markStopped()
		return nil
	}
}

// markStopped updates state and cleans up
func (c *Controller) markStopped() {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.state = StateStopped
	c.hub.SetAgentStopped() // Notify clients before closing
	c.hub.Stop()
	c.pty.Close()
}

// Resize changes the PTY window size
func (c *Controller) Resize(cols, rows uint16) error {
	c.mu.RLock()
	state := c.state
	c.mu.RUnlock()

	if state == StateStopped {
		return ErrAgentStopped
	}

	return c.pty.Resize(cols, rows)
}

// RunCommand executes a command and waits for output
func (c *Controller) RunCommand(command string, timeout time.Duration) ([]byte, error) {
	c.mu.RLock()
	state := c.state
	c.mu.RUnlock()

	if state == StateStopped {
		return nil, ErrAgentStopped
	}

	// Create a temporary client to capture output
	output := make(chan pty.HubMessage, 1024)
	c.hub.Register(output)
	defer c.hub.Unregister(output)

	// Send the command
	_, err := c.Write([]byte(command + "\n"))
	if err != nil {
		return nil, err
	}

	// Collect output until timeout or we see the command echoed back
	var result bytes.Buffer
	deadline := time.After(timeout)

	for {
		select {
		case msg := <-output:
			result.Write(msg.Data)
		case <-deadline:
			return result.Bytes(), nil
		}
	}
}

// StartClaudeCode launches Claude Code CLI
func (c *Controller) StartClaudeCode(workDir string) error {
	cmd := "cd " + workDir + " && claude"
	_, err := c.Write([]byte(cmd + "\n"))
	return err
}

// StartCodex launches Codex CLI
func (c *Controller) StartCodex(workDir string) error {
	cmd := "cd " + workDir + " && codex"
	_, err := c.Write([]byte(cmd + "\n"))
	return err
}
