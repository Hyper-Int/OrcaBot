// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package debug

import (
	"fmt"
	"log"
	"os"
	"runtime"
	"runtime/pprof"
	"sync"
	"time"
)

// MemoryMonitor provides automatic memory diagnostics logging.
// It periodically logs memory stats and can dump goroutine stacks on demand.
type MemoryMonitor struct {
	interval         time.Duration
	warningThreshold uint64 // bytes
	criticalThreshold uint64 // bytes

	stopCh   chan struct{}
	stopOnce sync.Once
	wg       sync.WaitGroup

	// Track previous stats for delta reporting
	prevNumGC uint32
	prevAlloc uint64
}

// Config for MemoryMonitor
type MemoryMonitorConfig struct {
	// Interval between memory stat logs (default: 30s)
	Interval time.Duration
	// WarningThreshold logs a warning when heap exceeds this (default: 512MB)
	WarningThreshold uint64
	// CriticalThreshold logs critical when heap exceeds this (default: 1.5GB)
	CriticalThreshold uint64
}

// DefaultConfig returns sensible defaults for a 2GB VM
func DefaultConfig() MemoryMonitorConfig {
	return MemoryMonitorConfig{
		Interval:          30 * time.Second,
		WarningThreshold:  512 * 1024 * 1024,  // 512 MB
		CriticalThreshold: 1536 * 1024 * 1024, // 1.5 GB
	}
}

// NewMemoryMonitor creates a new memory monitor with the given config
func NewMemoryMonitor(cfg MemoryMonitorConfig) *MemoryMonitor {
	if cfg.Interval == 0 {
		cfg.Interval = 30 * time.Second
	}
	if cfg.WarningThreshold == 0 {
		cfg.WarningThreshold = 512 * 1024 * 1024
	}
	if cfg.CriticalThreshold == 0 {
		cfg.CriticalThreshold = 1536 * 1024 * 1024
	}

	return &MemoryMonitor{
		interval:          cfg.Interval,
		warningThreshold:  cfg.WarningThreshold,
		criticalThreshold: cfg.CriticalThreshold,
		stopCh:            make(chan struct{}),
	}
}

// Start begins periodic memory monitoring
func (m *MemoryMonitor) Start() {
	m.wg.Add(1)
	go m.monitorLoop()
	log.Printf("INFO Memory monitor started (interval=%v, warn=%dMB, crit=%dMB)",
		m.interval,
		m.warningThreshold/(1024*1024),
		m.criticalThreshold/(1024*1024))
}

// Stop halts the memory monitor
func (m *MemoryMonitor) Stop() {
	m.stopOnce.Do(func() {
		close(m.stopCh)
	})
	m.wg.Wait()
	log.Println("INFO Memory monitor stopped")
}

func (m *MemoryMonitor) monitorLoop() {
	defer m.wg.Done()

	// Log initial state
	m.logMemoryStats("startup")

	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()

	for {
		select {
		case <-m.stopCh:
			m.logMemoryStats("shutdown")
			return
		case <-ticker.C:
			m.logMemoryStats("periodic")
		}
	}
}

func (m *MemoryMonitor) logMemoryStats(reason string) {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)

	numGoroutines := runtime.NumGoroutine()
	heapMB := float64(ms.HeapAlloc) / (1024 * 1024)
	sysMB := float64(ms.Sys) / (1024 * 1024)

	// Calculate deltas since last check
	gcRuns := ms.NumGC - m.prevNumGC
	allocDelta := int64(ms.TotalAlloc - m.prevAlloc)
	m.prevNumGC = ms.NumGC
	m.prevAlloc = ms.TotalAlloc

	// Determine log level based on heap size
	level := "INFO"
	if ms.HeapAlloc >= m.criticalThreshold {
		level = "CRITICAL"
	} else if ms.HeapAlloc >= m.warningThreshold {
		level = "WARNING"
	}

	log.Printf("%s [memory:%s] heap=%.1fMB sys=%.1fMB goroutines=%d gc_runs=%d alloc_delta=%.1fMB heap_objects=%d",
		level,
		reason,
		heapMB,
		sysMB,
		numGoroutines,
		gcRuns,
		float64(allocDelta)/(1024*1024),
		ms.HeapObjects,
	)

	// Log additional details at warning/critical levels
	if ms.HeapAlloc >= m.warningThreshold {
		log.Printf("%s [memory:detail] heap_inuse=%.1fMB heap_idle=%.1fMB heap_released=%.1fMB stack_inuse=%.1fMB",
			level,
			float64(ms.HeapInuse)/(1024*1024),
			float64(ms.HeapIdle)/(1024*1024),
			float64(ms.HeapReleased)/(1024*1024),
			float64(ms.StackInuse)/(1024*1024),
		)
	}

	// At critical level, dump goroutine summary
	if ms.HeapAlloc >= m.criticalThreshold {
		m.logGoroutineSummary()
	}
}

// DumpGoroutineStacks writes all goroutine stacks to stderr
// Call this on SIGQUIT or when debugging hangs
func (m *MemoryMonitor) DumpGoroutineStacks() {
	log.Println("INFO [memory:dump] Dumping all goroutine stacks...")

	// First log memory stats
	m.logMemoryStats("dump")

	// Then dump goroutine stacks
	buf := make([]byte, 1024*1024) // 1MB buffer
	for {
		n := runtime.Stack(buf, true) // true = all goroutines
		if n < len(buf) {
			fmt.Fprintf(os.Stderr, "\n=== GOROUTINE DUMP ===\n%s\n=== END GOROUTINE DUMP ===\n", buf[:n])
			break
		}
		// Buffer too small, grow it
		buf = make([]byte, len(buf)*2)
		if len(buf) > 64*1024*1024 { // Cap at 64MB
			fmt.Fprintf(os.Stderr, "\n=== GOROUTINE DUMP (truncated) ===\n%s\n=== END GOROUTINE DUMP ===\n", buf)
			break
		}
	}

	log.Printf("INFO [memory:dump] Goroutine dump complete (count=%d)", runtime.NumGoroutine())
}

// logGoroutineSummary logs a summary of goroutine states without full stacks
func (m *MemoryMonitor) logGoroutineSummary() {
	// Use pprof to get goroutine profile
	p := pprof.Lookup("goroutine")
	if p == nil {
		return
	}
	log.Printf("CRITICAL [memory:goroutines] total_goroutines=%d (dumping summary to stderr)", p.Count())

	// Write a debug profile to stderr
	p.WriteTo(os.Stderr, 1) // 1 = debug level (human readable)
}

// WriteHeapProfile writes a heap profile to the given path
// Useful for detailed analysis with go tool pprof
func WriteHeapProfile(path string) error {
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create heap profile: %w", err)
	}
	defer f.Close()

	if err := pprof.WriteHeapProfile(f); err != nil {
		return fmt.Errorf("write heap profile: %w", err)
	}

	log.Printf("INFO [memory:profile] Heap profile written to %s", path)
	return nil
}

// ForceGC triggers a garbage collection and logs the results
func (m *MemoryMonitor) ForceGC() {
	log.Println("INFO [memory:gc] Forcing garbage collection...")

	var before runtime.MemStats
	runtime.ReadMemStats(&before)

	runtime.GC()

	var after runtime.MemStats
	runtime.ReadMemStats(&after)

	freedMB := float64(before.HeapAlloc-after.HeapAlloc) / (1024 * 1024)
	log.Printf("INFO [memory:gc] GC complete: freed=%.1fMB heap_before=%.1fMB heap_after=%.1fMB",
		freedMB,
		float64(before.HeapAlloc)/(1024*1024),
		float64(after.HeapAlloc)/(1024*1024),
	)
}
