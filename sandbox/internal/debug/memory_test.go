package debug

import (
	"bytes"
	"log"
	"os"
	"strings"
	"testing"
	"time"
)

func TestMemoryMonitor_LogsOnStartup(t *testing.T) {
	// Capture log output
	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)

	cfg := MemoryMonitorConfig{
		Interval:          100 * time.Millisecond,
		WarningThreshold:  512 * 1024 * 1024,
		CriticalThreshold: 1536 * 1024 * 1024,
	}

	m := NewMemoryMonitor(cfg)
	m.Start()

	// Give it time to log startup
	time.Sleep(50 * time.Millisecond)

	m.Stop()

	output := buf.String()

	// Should log startup message
	if !strings.Contains(output, "Memory monitor started") {
		t.Errorf("expected startup message, got: %s", output)
	}

	// Should log initial memory stats
	if !strings.Contains(output, "[memory:startup]") {
		t.Errorf("expected startup memory stats, got: %s", output)
	}

	// Should include heap info
	if !strings.Contains(output, "heap=") {
		t.Errorf("expected heap stats, got: %s", output)
	}

	// Should include goroutine count
	if !strings.Contains(output, "goroutines=") {
		t.Errorf("expected goroutine count, got: %s", output)
	}
}

func TestMemoryMonitor_PeriodicLogging(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)

	cfg := MemoryMonitorConfig{
		Interval:          50 * time.Millisecond,
		WarningThreshold:  512 * 1024 * 1024,
		CriticalThreshold: 1536 * 1024 * 1024,
	}

	m := NewMemoryMonitor(cfg)
	m.Start()

	// Wait for a couple of periodic logs
	time.Sleep(150 * time.Millisecond)

	m.Stop()

	output := buf.String()

	// Should have periodic logs
	if !strings.Contains(output, "[memory:periodic]") {
		t.Errorf("expected periodic memory stats, got: %s", output)
	}
}

func TestMemoryMonitor_DumpGoroutineStacks(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)

	// Capture stderr too
	oldStderr := os.Stderr
	r, w, _ := os.Pipe()
	os.Stderr = w

	m := NewMemoryMonitor(DefaultConfig())
	m.DumpGoroutineStacks()

	w.Close()
	os.Stderr = oldStderr

	var stderrBuf bytes.Buffer
	stderrBuf.ReadFrom(r)

	logOutput := buf.String()
	stderrOutput := stderrBuf.String()

	// Should log dump message
	if !strings.Contains(logOutput, "[memory:dump]") {
		t.Errorf("expected dump log message, got: %s", logOutput)
	}

	// Should dump goroutine stacks to stderr
	if !strings.Contains(stderrOutput, "GOROUTINE DUMP") {
		t.Errorf("expected goroutine dump in stderr, got: %s", stderrOutput)
	}
}

func TestMemoryMonitor_ForceGC(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)

	m := NewMemoryMonitor(DefaultConfig())
	m.ForceGC()

	output := buf.String()

	// Should log GC message
	if !strings.Contains(output, "[memory:gc]") {
		t.Errorf("expected GC log message, got: %s", output)
	}

	if !strings.Contains(output, "GC complete") {
		t.Errorf("expected GC complete message, got: %s", output)
	}
}

func TestDefaultConfig(t *testing.T) {
	cfg := DefaultConfig()

	if cfg.Interval != 30*time.Second {
		t.Errorf("expected 30s interval, got %v", cfg.Interval)
	}

	if cfg.WarningThreshold != 512*1024*1024 {
		t.Errorf("expected 512MB warning threshold, got %d", cfg.WarningThreshold)
	}

	if cfg.CriticalThreshold != 1536*1024*1024 {
		t.Errorf("expected 1.5GB critical threshold, got %d", cfg.CriticalThreshold)
	}
}
