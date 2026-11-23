// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: bgproc-v1-restart-choice

// Package bgproc finds the background processes a terminal leaves running, so a user
// restarting it can choose to stop them.
//
// Restarting a terminal kills its PTY's process group. A process that left the group
// (setsid, a daemon that forks and detaches) keeps running, with the terminal's
// environment from when it started. From the 2026-11-22 PokerBench game: Codex's shared
// app-server daemon, started by an earlier run of the Codex terminal, kept that run's
// ORCABOT_PTY_ID, so every command Codex ran after a restart looked up a terminal that
// no longer existed.
//
// A terminal's background process: still running, carries one of the terminal's PTY ids
// (current or earlier, from the control plane) in ORCABOT_PTY_ID, and isn't in any live
// PTY's process group (those die with their terminal, or belong to another one).
package bgproc

import (
	"bytes"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const Revision = "bgproc-v1-restart-choice"

func init() {
	log.Printf("[bgproc] REVISION: %s loaded at %s", Revision, time.Now().Format(time.RFC3339))
}

// Process is one background process, as shown to the user.
type Process struct {
	PID     int    `json:"pid"`
	PPID    int    `json:"ppid"`
	UID     int    `json:"uid"`
	Name    string `json:"name"`
	Command string `json:"command"` // cmdline, truncated
	// StartTicks is the start time in clock ticks since boot: with PID it names the
	// process exactly, so a stop request can't hit a different process given a reused PID.
	StartTicks uint64    `json:"start_ticks"`
	StartedAt  time.Time `json:"started_at"`
	PTYID      string    `json:"pty_id"`
}

// Target names a process to stop (from a Find result).
type Target struct {
	PID        int    `json:"pid"`
	StartTicks uint64 `json:"start_ticks"`
}

// Scanner reads a /proc tree.
type Scanner struct {
	Root string // "/proc" in production; a fake tree in tests
	Self int    // never this process
	// Kill sends a signal (syscall.Kill in production).
	Kill func(pid int, sig syscall.Signal) error
	// ClockTicks per second (USER_HZ), 100 on Linux.
	ClockTicks uint64
}

// New is the scanner for this machine.
func New() *Scanner {
	return &Scanner{Root: "/proc", Self: os.Getpid(), Kill: syscall.Kill, ClockTicks: 100}
}

const maxCommand = 300

type procInfo struct {
	Process
	pgrp  int
	state byte
}

// Find returns the background processes left by the terminal whose PTY ids are given,
// oldest first. liveGroups holds the process group of every running PTY.
func (s *Scanner) Find(ptyIDs []string, liveGroups map[int]bool) []Process {
	ids := map[string]bool{}
	for _, id := range ptyIDs {
		if id = strings.TrimSpace(id); id != "" {
			ids[id] = true
		}
	}
	if len(ids) == 0 {
		return nil
	}
	entries, err := os.ReadDir(s.Root)
	if err != nil {
		return nil
	}
	boot := s.bootTime()
	var out []Process
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		p, ok := s.match(pid, ids, liveGroups)
		if !ok {
			continue
		}
		if !boot.IsZero() && s.ClockTicks > 0 {
			p.StartedAt = boot.Add(time.Duration(p.StartTicks) * time.Second / time.Duration(s.ClockTicks)).UTC()
		}
		out = append(out, p.Process)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].StartTicks != out[j].StartTicks {
			return out[i].StartTicks < out[j].StartTicks
		}
		return out[i].PID < out[j].PID
	})
	return out
}

// match reads one process and reports whether it is one of the terminal's background
// processes.
func (s *Scanner) match(pid int, ids map[string]bool, liveGroups map[int]bool) (procInfo, bool) {
	if pid <= 1 || pid == s.Self {
		return procInfo{}, false
	}
	dir := filepath.Join(s.Root, strconv.Itoa(pid))
	env, err := os.ReadFile(filepath.Join(dir, "environ"))
	if err != nil {
		return procInfo{}, false
	}
	ptyID := envValue(env, "ORCABOT_PTY_ID")
	if !ids[ptyID] {
		return procInfo{}, false
	}
	p, err := s.read(pid)
	if err != nil {
		return procInfo{}, false
	}
	if p.state == 'Z' || p.state == 'X' || liveGroups[p.pgrp] {
		return procInfo{}, false
	}
	p.PTYID = ptyID
	return p, true
}

func (s *Scanner) read(pid int) (procInfo, error) {
	dir := filepath.Join(s.Root, strconv.Itoa(pid))
	stat, err := os.ReadFile(filepath.Join(dir, "stat"))
	if err != nil {
		return procInfo{}, err
	}
	// pid (comm) state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt
	// utime stime cutime cstime priority nice num_threads itrealvalue starttime ...
	// comm may hold spaces and parentheses: split at the last ')'.
	close := bytes.LastIndexByte(stat, ')')
	open := bytes.IndexByte(stat, '(')
	if open < 0 || close < open {
		return procInfo{}, errors.New("bad stat")
	}
	fields := strings.Fields(string(stat[close+1:]))
	if len(fields) < 20 {
		return procInfo{}, errors.New("short stat")
	}
	p := procInfo{}
	p.PID = pid
	p.Name = string(stat[open+1 : close])
	p.state = fields[0][0]
	p.PPID, _ = strconv.Atoi(fields[1])
	p.pgrp, _ = strconv.Atoi(fields[2])
	p.StartTicks, _ = strconv.ParseUint(fields[19], 10, 64)
	p.UID = -1
	if status, err := os.ReadFile(filepath.Join(dir, "status")); err == nil {
		for _, line := range strings.Split(string(status), "\n") {
			if strings.HasPrefix(line, "Uid:") {
				if f := strings.Fields(line); len(f) > 1 {
					p.UID, _ = strconv.Atoi(f[1])
				}
				break
			}
		}
	}
	if cmd, err := os.ReadFile(filepath.Join(dir, "cmdline")); err == nil {
		c := strings.TrimSpace(strings.ReplaceAll(string(bytes.TrimRight(cmd, "\x00")), "\x00", " "))
		if len(c) > maxCommand {
			c = c[:maxCommand] + "…"
		}
		p.Command = c
	}
	if p.Command == "" {
		p.Command = "[" + p.Name + "]"
	}
	return p, nil
}

func envValue(environ []byte, key string) string {
	prefix := []byte(key + "=")
	for _, kv := range bytes.Split(environ, []byte{0}) {
		if bytes.HasPrefix(kv, prefix) {
			return string(kv[len(prefix):])
		}
	}
	return ""
}

func (s *Scanner) bootTime() time.Time {
	data, err := os.ReadFile(filepath.Join(s.Root, "stat"))
	if err != nil {
		return time.Time{}
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "btime ") {
			if sec, err := strconv.ParseInt(strings.TrimSpace(line[6:]), 10, 64); err == nil {
				return time.Unix(sec, 0)
			}
		}
	}
	return time.Time{}
}

// Result of a Stop: each target is stopped, already gone, or refused with a reason.
type Result struct {
	PID     int    `json:"pid"`
	Outcome string `json:"outcome"` // "stopped" | "gone" | "refused" | "failed"
	Detail  string `json:"detail,omitempty"`
}

// Stop stops the given processes, each only if it is still one of the terminal's
// background processes (same PID and start time, still carrying one of ptyIDs, outside
// every live PTY's group): SIGTERM, then SIGKILL after grace.
func (s *Scanner) Stop(targets []Target, ptyIDs []string, liveGroups map[int]bool, grace time.Duration) []Result {
	ids := map[string]bool{}
	for _, id := range ptyIDs {
		if id = strings.TrimSpace(id); id != "" {
			ids[id] = true
		}
	}
	results := make([]Result, 0, len(targets))
	var signalled []Target
	for _, t := range targets {
		p, ok := s.match(t.PID, ids, liveGroups)
		switch {
		case !ok && !s.exists(t.PID):
			results = append(results, Result{PID: t.PID, Outcome: "gone"})
		case !ok:
			results = append(results, Result{PID: t.PID, Outcome: "refused", Detail: "not a background process of this terminal"})
		case p.StartTicks != t.StartTicks:
			results = append(results, Result{PID: t.PID, Outcome: "gone", Detail: "that process exited; its PID was reused"})
		default:
			if err := s.Kill(t.PID, syscall.SIGTERM); err != nil {
				results = append(results, Result{PID: t.PID, Outcome: "failed", Detail: err.Error()})
				continue
			}
			log.Printf("[bgproc] SIGTERM pid=%d (%s) pty=%s", t.PID, p.Name, p.PTYID)
			signalled = append(signalled, t)
		}
	}
	deadline := time.Now().Add(grace)
	for _, t := range signalled {
		for s.alive(t) && time.Now().Before(deadline) {
			time.Sleep(100 * time.Millisecond)
		}
		if s.alive(t) {
			_ = s.Kill(t.PID, syscall.SIGKILL)
			log.Printf("[bgproc] SIGKILL pid=%d (still running %s after SIGTERM)", t.PID, grace)
			for i := 0; i < 20 && s.alive(t); i++ {
				time.Sleep(50 * time.Millisecond)
			}
		}
		if s.alive(t) {
			results = append(results, Result{PID: t.PID, Outcome: "failed", Detail: "still running after SIGKILL"})
		} else {
			results = append(results, Result{PID: t.PID, Outcome: "stopped"})
		}
	}
	return results
}

func (s *Scanner) exists(pid int) bool {
	_, err := os.Stat(filepath.Join(s.Root, strconv.Itoa(pid)))
	return err == nil
}

// alive: the same process (PID and start time) is still there and not a zombie.
func (s *Scanner) alive(t Target) bool {
	p, err := s.read(t.PID)
	if err != nil {
		return false
	}
	return p.StartTicks == t.StartTicks && p.state != 'Z' && p.state != 'X'
}

// String is for logs.
func (p Process) String() string {
	return fmt.Sprintf("pid=%d %s pty=%s", p.PID, p.Name, p.PTYID)
}
