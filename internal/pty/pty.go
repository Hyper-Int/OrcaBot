package pty

import (
	"os"
	"os/exec"
	"sync"
	"syscall"

	"github.com/creack/pty"
	"github.com/google/uuid"
)

// Signal types for PTY control
type Signal int

const (
	SIGINT  Signal = Signal(syscall.SIGINT)
	SIGTERM Signal = Signal(syscall.SIGTERM)
	SIGKILL Signal = Signal(syscall.SIGKILL)
	SIGSTOP Signal = Signal(syscall.SIGSTOP)
	SIGCONT Signal = Signal(syscall.SIGCONT)
)

// PTY represents a pseudo-terminal
type PTY struct {
	ID   string
	file *os.File
	cmd  *exec.Cmd

	mu     sync.Mutex
	closed bool
}

// New creates a new PTY running the given shell
func New(shell string, cols, rows uint16) (*PTY, error) {
	cmd := exec.Command(shell)
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
	)

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{
		Cols: cols,
		Rows: rows,
	})
	if err != nil {
		return nil, err
	}

	return &PTY{
		ID:   uuid.New().String(),
		file: ptmx,
		cmd:  cmd,
	}, nil
}

// Read reads from the PTY
func (p *PTY) Read(buf []byte) (int, error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return 0, os.ErrClosed
	}
	file := p.file
	p.mu.Unlock()

	return file.Read(buf)
}

// Write writes to the PTY
func (p *PTY) Write(data []byte) (int, error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return 0, os.ErrClosed
	}
	file := p.file
	p.mu.Unlock()

	return file.Write(data)
}

// Resize changes the PTY window size
func (p *PTY) Resize(cols, rows uint16) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.closed {
		return os.ErrClosed
	}

	return pty.Setsize(p.file, &pty.Winsize{
		Cols: cols,
		Rows: rows,
	})
}

// Signal sends a signal to the PTY process
func (p *PTY) Signal(sig Signal) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.closed {
		return os.ErrClosed
	}

	if p.cmd.Process == nil {
		return os.ErrProcessDone
	}

	return p.cmd.Process.Signal(syscall.Signal(sig))
}

// Close terminates the PTY
func (p *PTY) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.closed {
		return nil
	}
	p.closed = true

	// Kill the process if still running
	if p.cmd.Process != nil {
		p.cmd.Process.Kill()
	}

	// Close the PTY file
	return p.file.Close()
}

// Done returns a channel that closes when the PTY process exits
func (p *PTY) Done() <-chan struct{} {
	done := make(chan struct{})
	go func() {
		if p.cmd != nil {
			p.cmd.Wait()
		}
		close(done)
	}()
	return done
}
