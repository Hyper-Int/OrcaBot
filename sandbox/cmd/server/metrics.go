// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package main

// REVISION: metrics-v2-topprocs

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const metricsRevision = "metrics-v2-topprocs"

type processInfo struct {
	PID     int     `json:"pid"`
	Name    string  `json:"name"`
	CPUPct  float64 `json:"cpu_pct"`
	MemPct  float64 `json:"mem_pct"`
	Combined float64 `json:"combined"` // CPU + Memory percentage
}

type metricsResponse struct {
	Revision     string        `json:"revision"`
	HeapBytes    uint64        `json:"heap_bytes"`
	SysBytes     uint64        `json:"sys_bytes"`
	HeapObjects  uint64        `json:"heap_objects"`
	Goroutines   int           `json:"goroutines"`
	GCRuns       uint32        `json:"gc_runs"`
	CpuUserMs    int64         `json:"cpu_user_ms"`
	CpuSystemMs  int64         `json:"cpu_system_ms"`
	UptimeMs     int64         `json:"uptime_ms"`
	SessionCount int           `json:"session_count"`
	HeapMB       float64       `json:"heap_mb"`
	SysMB        float64       `json:"sys_mb"`
	TopProcesses []processInfo `json:"top_processes"`
	// System-wide metrics
	SystemCPUPct   float64 `json:"system_cpu_pct"`
	SystemMemPct   float64 `json:"system_mem_pct"`
	SystemMemUsedMB float64 `json:"system_mem_used_mb"`
	SystemMemTotalMB float64 `json:"system_mem_total_mb"`
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

	topProcs := getTopProcesses(5)
	sysMemUsed, sysMemTotal, sysMemPct := getSystemMemoryStats()
	sysCPUPct := getSystemCPUPercent()

	response := metricsResponse{
		Revision:     metricsRevision,
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
		TopProcesses: topProcs,
		SystemCPUPct:    sysCPUPct,
		SystemMemPct:    sysMemPct,
		SystemMemUsedMB: sysMemUsed,
		SystemMemTotalMB: sysMemTotal,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// getTopProcesses returns the top N processes by combined CPU+memory usage
func getTopProcesses(n int) []processInfo {
	// Read from /proc directly for portability (works on Alpine/BusyBox)
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}

	// Get total memory for calculating percentages
	totalMem := getTotalMemoryKB()
	if totalMem == 0 {
		totalMem = 1 // Avoid division by zero
	}

	// Get system CPU stats for calculating percentages
	numCPU := float64(runtime.NumCPU())

	var processes []processInfo
	var pidCount, successCount int
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue // Not a PID directory
		}
		pidCount++

		proc := readProcessInfo(pid, totalMem, numCPU)
		if proc != nil {
			successCount++
			processes = append(processes, *proc)
		}
	}

	// Sort by combined usage descending
	sort.Slice(processes, func(i, j int) bool {
		return processes[i].Combined > processes[j].Combined
	})

	// Return top N
	if len(processes) > n {
		processes = processes[:n]
	}

	return processes
}

// readProcessInfo reads process info from /proc/[pid]/
func readProcessInfo(pid int, totalMemKB uint64, numCPU float64) *processInfo {
	// Read /proc/[pid]/stat for CPU and basic info
	statPath := fmt.Sprintf("/proc/%d/stat", pid)
	statData, err := os.ReadFile(statPath)
	if err != nil {
		return nil
	}

	// Parse stat file - format: pid (comm) state ppid pgrp session tty_nr tpgid flags
	// minflt cminflt majflt cmajflt utime stime cutime cstime priority nice ...
	statStr := string(statData)

	// Extract comm (process name) which is in parentheses
	start := strings.Index(statStr, "(")
	end := strings.LastIndex(statStr, ")")
	if start == -1 || end == -1 || end <= start {
		return nil
	}
	name := statStr[start+1 : end]
	if len(name) > 20 {
		name = name[:20]
	}

	// Fields after the closing paren
	rest := strings.Fields(statStr[end+2:])
	if len(rest) < 22 {
		return nil
	}

	// utime is field 13 (index 11 in rest), stime is field 14 (index 12)
	utime, _ := strconv.ParseUint(rest[11], 10, 64)
	stime, _ := strconv.ParseUint(rest[12], 10, 64)
	totalCPUTicks := utime + stime

	// Read /proc/[pid]/statm for memory info
	statmPath := fmt.Sprintf("/proc/%d/statm", pid)
	statmData, err := os.ReadFile(statmPath)
	if err != nil {
		return nil
	}

	statmFields := strings.Fields(string(statmData))
	if len(statmFields) < 2 {
		return nil
	}

	// RSS is field 1 (in pages, typically 4KB)
	rssPages, _ := strconv.ParseUint(statmFields[1], 10, 64)
	rssKB := rssPages * 4 // Assume 4KB pages

	// Calculate memory percentage
	memPct := (float64(rssKB) / float64(totalMemKB)) * 100.0

	// Calculate CPU percentage based on total ticks vs uptime
	// This is a rough approximation - for accurate instantaneous CPU%
	// we'd need to sample twice and compute delta
	uptimeSecs := float64(time.Since(processStartTime(pid)).Seconds())
	if uptimeSecs < 1 {
		uptimeSecs = 1
	}
	// CPU ticks are typically 100 per second (USER_HZ)
	cpuSecs := float64(totalCPUTicks) / 100.0
	cpuPct := (cpuSecs / uptimeSecs) * 100.0 / numCPU

	// Cap at reasonable values
	if cpuPct > 100 {
		cpuPct = 100
	}
	if memPct > 100 {
		memPct = 100
	}

	return &processInfo{
		PID:      pid,
		Name:     name,
		CPUPct:   cpuPct,
		MemPct:   memPct,
		Combined: cpuPct + memPct,
	}
}

// getTotalMemoryKB returns total system memory in KB
func getTotalMemoryKB() uint64 {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				val, _ := strconv.ParseUint(fields[1], 10, 64)
				return val
			}
		}
	}
	return 0
}

// processStartTime returns when a process started (approximation)
func processStartTime(pid int) time.Time {
	statPath := fmt.Sprintf("/proc/%d/stat", pid)
	data, err := os.ReadFile(statPath)
	if err != nil {
		return time.Now()
	}

	// Find the closing paren and get fields after
	statStr := string(data)
	end := strings.LastIndex(statStr, ")")
	if end == -1 {
		return time.Now()
	}
	rest := strings.Fields(statStr[end+2:])
	if len(rest) < 20 {
		return time.Now()
	}

	// starttime is field 21 (index 19 in rest) - in clock ticks since boot
	startTicks, _ := strconv.ParseUint(rest[19], 10, 64)

	// Read system uptime
	uptimeData, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return time.Now()
	}
	uptimeFields := strings.Fields(string(uptimeData))
	if len(uptimeFields) < 1 {
		return time.Now()
	}
	uptimeSecs, _ := strconv.ParseFloat(uptimeFields[0], 64)

	// Calculate when process started
	startSecs := float64(startTicks) / 100.0 // Assume USER_HZ = 100
	processSecs := uptimeSecs - startSecs
	if processSecs < 0 {
		processSecs = 1
	}

	return time.Now().Add(-time.Duration(processSecs * float64(time.Second)))
}

func timevalToMs(tv syscall.Timeval) int64 {
	return (tv.Sec * 1000) + (tv.Usec / 1000)
}

// getSystemMemoryStats returns used and total memory in MB and usage percentage
// It checks for container cgroup limits first, falling back to host memory if not in a container
func getSystemMemoryStats() (usedMB, totalMB, pct float64) {
	// First, get memory info from /proc/meminfo
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, 0, 0
	}

	var memTotal, memAvailable, memFree, buffers, cached uint64
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		val, _ := strconv.ParseUint(fields[1], 10, 64)
		switch {
		case strings.HasPrefix(line, "MemTotal:"):
			memTotal = val
		case strings.HasPrefix(line, "MemAvailable:"):
			memAvailable = val
		case strings.HasPrefix(line, "MemFree:"):
			memFree = val
		case strings.HasPrefix(line, "Buffers:"):
			buffers = val
		case strings.HasPrefix(line, "Cached:"):
			cached = val
		}
	}

	if memTotal == 0 {
		return 0, 0, 0
	}

	// Check for container cgroup memory limit
	cgroupLimit := getContainerMemoryLimit()
	if cgroupLimit > 0 && cgroupLimit < memTotal*1024 { // cgroupLimit is in bytes, memTotal is in KB
		// We're in a container with a memory limit
		memTotalBytes := cgroupLimit
		memUsedBytes := getContainerMemoryUsage()

		totalMB = float64(memTotalBytes) / (1024.0 * 1024.0)
		usedMB = float64(memUsedBytes) / (1024.0 * 1024.0)
		if memTotalBytes > 0 {
			pct = (float64(memUsedBytes) / float64(memTotalBytes)) * 100.0
		}
		return usedMB, totalMB, pct
	}

	// Not in a container (or no limit), use host memory
	memUsed := memTotal - memAvailable
	if memAvailable == 0 {
		// Fallback calculation if MemAvailable not present
		memUsed = memTotal - memFree - buffers - cached
	}

	totalMB = float64(memTotal) / 1024.0
	usedMB = float64(memUsed) / 1024.0
	pct = (float64(memUsed) / float64(memTotal)) * 100.0
	return usedMB, totalMB, pct
}

// getContainerMemoryLimit returns the container's memory limit in bytes, or 0 if not in a container
func getContainerMemoryLimit() uint64 {
	// Try cgroups v2 first
	if data, err := os.ReadFile("/sys/fs/cgroup/memory.max"); err == nil {
		s := strings.TrimSpace(string(data))
		if s != "max" { // "max" means no limit
			if val, err := strconv.ParseUint(s, 10, 64); err == nil {
				return val
			}
		}
	}

	// Try cgroups v1
	if data, err := os.ReadFile("/sys/fs/cgroup/memory/memory.limit_in_bytes"); err == nil {
		s := strings.TrimSpace(string(data))
		if val, err := strconv.ParseUint(s, 10, 64); err == nil {
			// Check if it's a real limit (not the max value which indicates no limit)
			if val < 9223372036854771712 { // Common "no limit" value
				return val
			}
		}
	}

	return 0
}

// getContainerMemoryUsage returns the container's current memory usage in bytes
func getContainerMemoryUsage() uint64 {
	// Try cgroups v2 first
	if data, err := os.ReadFile("/sys/fs/cgroup/memory.current"); err == nil {
		s := strings.TrimSpace(string(data))
		if val, err := strconv.ParseUint(s, 10, 64); err == nil {
			return val
		}
	}

	// Try cgroups v1
	if data, err := os.ReadFile("/sys/fs/cgroup/memory/memory.usage_in_bytes"); err == nil {
		s := strings.TrimSpace(string(data))
		if val, err := strconv.ParseUint(s, 10, 64); err == nil {
			return val
		}
	}

	return 0
}

// getSystemCPUPercent calculates system-wide CPU usage from /proc/stat
// Note: This is a snapshot and may not reflect instantaneous usage accurately
func getSystemCPUPercent() float64 {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0
	}

	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "cpu ") {
			fields := strings.Fields(line)
			if len(fields) < 5 {
				return 0
			}
			// Fields: cpu user nice system idle iowait irq softirq steal guest guest_nice
			user, _ := strconv.ParseUint(fields[1], 10, 64)
			nice, _ := strconv.ParseUint(fields[2], 10, 64)
			system, _ := strconv.ParseUint(fields[3], 10, 64)
			idle, _ := strconv.ParseUint(fields[4], 10, 64)
			iowait := uint64(0)
			if len(fields) > 5 {
				iowait, _ = strconv.ParseUint(fields[5], 10, 64)
			}

			total := user + nice + system + idle + iowait
			if total == 0 {
				return 0
			}
			busy := user + nice + system
			return (float64(busy) / float64(total)) * 100.0
		}
	}
	return 0
}
