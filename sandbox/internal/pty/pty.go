// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package pty

import (
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/id"
	"github.com/creack/pty"
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

	// Done channel caching to prevent goroutine leaks
	doneOnce sync.Once
	doneChan chan struct{}
}

// New creates a new PTY running the given shell
func New(shell string, cols, rows uint16) (*PTY, error) {
	cmd := exec.Command(shell)
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
	)
	return newWithCmd(cmd, cols, rows)
}

// NewWithCommand creates a new PTY running the given command and optional working directory.
// If command is empty, DefaultShell() is used.
func NewWithCommand(command string, cols, rows uint16, dir string) (*PTY, error) {
	return NewWithCommandEnv(command, cols, rows, dir, nil)
}

// sensitiveEnvVars are environment variables that should NOT be passed to PTYs
// These are internal tokens that agents should not have access to
var sensitiveEnvVars = map[string]bool{
	"INTERNAL_API_TOKEN":      true,
	"SANDBOX_INTERNAL_TOKEN":  true,
	"ORCABOT_INTERNAL_TOKEN":  true, // Legacy, but filter just in case
	"SECRETS_ENCRYPTION_KEY":  true,
	"GOOGLE_CLIENT_SECRET":    true,
	"GITHUB_CLIENT_SECRET":    true,
	"BOX_CLIENT_SECRET":       true,
	"ONEDRIVE_CLIENT_SECRET":  true,
	"RESEND_API_KEY":          true,
}

// filterSensitiveEnv filters out sensitive environment variables
func filterSensitiveEnv(environ []string) []string {
	filtered := make([]string, 0, len(environ))
	for _, env := range environ {
		key := env
		if idx := strings.Index(env, "="); idx != -1 {
			key = env[:idx]
		}
		if !sensitiveEnvVars[key] {
			filtered = append(filtered, env)
		}
	}
	return filtered
}

// NewWithCommandEnv creates a new PTY with extra environment variables.
// If command is empty, DefaultShell() is used.
// SECURITY: Sensitive tokens (INTERNAL_API_TOKEN, etc.) are filtered out.
func NewWithCommandEnv(command string, cols, rows uint16, dir string, extraEnv map[string]string) (*PTY, error) {
	parts := strings.Fields(command)
	if len(parts) == 0 {
		parts = []string{DefaultShell()}
	}
	cmd := exec.Command(parts[0], parts[1:]...)
	// Filter out sensitive environment variables before passing to PTY
	env := append(filterSensitiveEnv(os.Environ()), "TERM=xterm-256color")
	for key, value := range extraEnv {
		env = append(env, key+"="+value)
	}
	cmd.Env = env
	if dir != "" {
		cmd.Dir = dir
	}
	return newWithCmd(cmd, cols, rows)
}

func newWithCmd(cmd *exec.Cmd, cols, rows uint16) (*PTY, error) {
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{
		Cols: cols,
		Rows: rows,
	})
	if err != nil {
		return nil, err
	}
	ptyID, err := id.New()
	if err != nil {
		ptmx.Close()
		return nil, err
	}
	return &PTY{
		ID:   ptyID,
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

// WriteSilent writes to the PTY with echo temporarily disabled.
func (p *PTY) WriteSilent(data []byte) (int, error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return 0, os.ErrClosed
	}
	file := p.file
	p.mu.Unlock()

	fd := int(file.Fd())
	termios, err := ioctlGetTermios(fd)
	if err != nil {
		return file.Write(data)
	}
	original := *termios
	termios.Lflag &^= syscall.ECHO
	if err := ioctlSetTermios(fd, termios); err != nil {
		return file.Write(data)
	}

	n, writeErr := file.Write(data)

	restore := original
	_ = ioctlSetTermios(fd, &restore)
	return n, writeErr
}

func ioctlGetTermios(fd int) (*syscall.Termios, error) {
	var termios syscall.Termios
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), uintptr(syscall.TCGETS), uintptr(unsafe.Pointer(&termios)))
	if errno != 0 {
		return nil, errno
	}
	return &termios, nil
}

func ioctlSetTermios(fd int, termios *syscall.Termios) error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), uintptr(syscall.TCSETS), uintptr(unsafe.Pointer(termios)))
	if errno != 0 {
		return errno
	}
	return nil
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

// Done returns a channel that closes when the PTY process exits.
// The channel is cached to prevent goroutine leaks from multiple calls.
func (p *PTY) Done() <-chan struct{} {
	p.doneOnce.Do(func() {
		p.doneChan = make(chan struct{})
		go func() {
			if p.cmd != nil {
				p.cmd.Wait()
			}
			close(p.doneChan)
		}()
	})
	return p.doneChan
}
