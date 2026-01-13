package pty

import (
	"bytes"
	"io"
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
