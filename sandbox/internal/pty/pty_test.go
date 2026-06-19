package pty

import (
	"bytes"
	"io"
	"regexp"
	"strconv"
	"syscall"
	"testing"
	"time"
)

func TestPTYCreate(t *testing.T) {
	p, err := New("/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create PTY: %v", err)
	}
	defer p.Close()

	if p.ID == "" {
		t.Error("expected non-empty PTY ID")
	}
}

func TestPTYWriteRead(t *testing.T) {
	p, err := New("/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create PTY: %v", err)
	}
	defer p.Close()

	// Write a command
	_, err = p.Write([]byte("echo hello\n"))
	if err != nil {
		t.Fatalf("failed to write: %v", err)
	}

	// Read output (with timeout)
	buf := make([]byte, 1024)
	done := make(chan bool)
	var output []byte

	go func() {
		for {
			n, err := p.Read(buf)
			if err != nil {
				break
			}
			output = append(output, buf[:n]...)
			if bytes.Contains(output, []byte("hello")) {
				done <- true
				return
			}
		}
		done <- false
	}()

	select {
	case success := <-done:
		if !success {
			t.Error("failed to read 'hello' from PTY output")
		}
	case <-time.After(5 * time.Second):
		t.Error("timeout waiting for PTY output")
	}
}

func TestPTYResize(t *testing.T) {
	p, err := New("/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create PTY: %v", err)
	}
	defer p.Close()

	err = p.Resize(120, 40)
	if err != nil {
		t.Fatalf("failed to resize: %v", err)
	}
}

func TestPTYClose(t *testing.T) {
	p, err := New("/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create PTY: %v", err)
	}

	err = p.Close()
	if err != nil {
		t.Fatalf("failed to close: %v", err)
	}

	// Writing after close should fail
	_, err = p.Write([]byte("test"))
	if err == nil {
		t.Error("expected error writing to closed PTY")
	}
}

func TestPTYReadAfterClose(t *testing.T) {
	p, err := New("/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create PTY: %v", err)
	}

	p.Close()

	// Reading after close should return EOF or error
	buf := make([]byte, 1024)
	_, err = p.Read(buf)
	if err == nil || err == io.EOF {
		// EOF is acceptable
	} else {
		// Other errors are also acceptable after close
	}
}

func TestPTYSignal(t *testing.T) {
	p, err := New("/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create PTY: %v", err)
	}
	defer p.Close()

	// Start a long-running command
	p.Write([]byte("sleep 100\n"))

	// Send SIGINT
	time.Sleep(100 * time.Millisecond)
	err = p.Signal(SIGINT)
	if err != nil {
		t.Fatalf("failed to send signal: %v", err)
	}
}

// TestPTYCloseReapsProcess guards the zombie-leak regression (bug #1): Close()
// must kill AND reap the process in ALL modes (previously cmd.Wait() only ran for
// pool slots, so non-pool PTYs left a zombie on every delete). A zombie still
// satisfies kill(pid,0)==nil; only after the parent reaps it does the PID become
// ESRCH. So we poll for ESRCH after Close().
func TestPTYCloseReapsProcess(t *testing.T) {
	p, err := New("/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create PTY: %v", err)
	}
	pid := p.cmd.Process.Pid

	if err := p.Close(); err != nil {
		t.Fatalf("failed to close: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		if err := syscall.Kill(pid, 0); err == syscall.ESRCH {
			return // killed and reaped — no zombie
		}
		if time.Now().After(deadline) {
			t.Fatalf("process %d still present after Close — not reaped (zombie/leak regression)", pid)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// TestPTYCloseKillsProcessGroup guards the orphaned-children regression (bug #1):
// Close() must kill the whole process group, not just the leader, so agent children
// (node/chromium, here a backgrounded sleep) die too instead of orphaning.
func TestPTYCloseKillsProcessGroup(t *testing.T) {
	p, err := New("/bin/sh", 80, 24)
	if err != nil {
		t.Fatalf("failed to create PTY: %v", err)
	}

	// Spawn a child inside the PTY's process group and capture its real PID.
	if _, err := p.Write([]byte("set +m; sleep 300 & echo CHILDPID=$! END\n")); err != nil {
		p.Close()
		t.Fatalf("failed to write: %v", err)
	}

	childRe := regexp.MustCompile(`CHILDPID=(\d+) END`)
	childPID := 0
	matchCh := make(chan int, 1)
	go func() {
		buf := make([]byte, 4096)
		var acc []byte
		for {
			n, err := p.Read(buf)
			if n > 0 {
				acc = append(acc, buf[:n]...)
				if m := childRe.FindSubmatch(acc); m != nil {
					pid, _ := strconv.Atoi(string(m[1]))
					matchCh <- pid
					return
				}
			}
			if err != nil {
				matchCh <- 0
				return
			}
		}
	}()
	select {
	case childPID = <-matchCh:
	case <-time.After(5 * time.Second):
		p.Close()
		t.Fatal("timeout waiting for child PID")
	}
	if childPID == 0 {
		p.Close()
		t.Fatal("could not determine child PID")
	}

	if err := p.Close(); err != nil {
		t.Fatalf("failed to close: %v", err)
	}

	// The backgrounded child must be killed with the group.
	deadline := time.Now().Add(5 * time.Second)
	for {
		if err := syscall.Kill(childPID, 0); err == syscall.ESRCH {
			return // child died with the group
		}
		if time.Now().After(deadline) {
			t.Fatalf("child process %d survived Close — process group not killed (orphan regression)", childPID)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
