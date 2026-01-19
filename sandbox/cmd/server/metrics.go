// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package main

import (
	"encoding/json"
	"net/http"
	"runtime"
	"syscall"
	"time"
)

type metricsResponse struct {
	HeapBytes    uint64  `json:"heap_bytes"`
	SysBytes     uint64  `json:"sys_bytes"`
	HeapObjects  uint64  `json:"heap_objects"`
	Goroutines   int     `json:"goroutines"`
	GCRuns       uint32  `json:"gc_runs"`
	CpuUserMs    int64   `json:"cpu_user_ms"`
	CpuSystemMs  int64   `json:"cpu_system_ms"`
	UptimeMs     int64   `json:"uptime_ms"`
	SessionCount int     `json:"session_count"`
	HeapMB       float64 `json:"heap_mb"`
	SysMB        float64 `json:"sys_mb"`
}

func (s *Server) handleSessionMetrics(w http.ResponseWriter, r *http.Request) {
	_, err := s.sessions.Get(r.PathValue("sessionId"))
	if err != nil {
		http.Error(w, "E79760: session not found", http.StatusNotFound)
		return
	}

	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)

	var usage syscall.Rusage
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &usage)

	response := metricsResponse{
		HeapBytes:    mem.HeapAlloc,
		SysBytes:     mem.Sys,
		HeapObjects:  mem.HeapObjects,
		Goroutines:   runtime.NumGoroutine(),
		GCRuns:       mem.NumGC,
		CpuUserMs:    timevalToMs(usage.Utime),
		CpuSystemMs:  timevalToMs(usage.Stime),
		UptimeMs:     int64(time.Since(s.startedAt) / time.Millisecond),
		SessionCount: len(s.sessions.List()),
		HeapMB:       float64(mem.HeapAlloc) / (1024 * 1024),
		SysMB:        float64(mem.Sys) / (1024 * 1024),
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func timevalToMs(tv syscall.Timeval) int64 {
	return (tv.Sec * 1000) + (tv.Usec / 1000)
}
