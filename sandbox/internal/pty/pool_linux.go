// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

//go:build linux

package pty

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// applySlotCredential sets cmd to run as the slot's UID and the pool's sandbox GID.
// Called inside newWithCmdID when a pool slot has been allocated for this PTY.
func applySlotCredential(cmd *exec.Cmd, slot *SlotEntry, sandboxGID uint32) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Credential = &syscall.Credential{
		Uid: uint32(slot.UID),
		Gid: sandboxGID,
	}
}

// readLeaderPGID returns the process group ID of pid by parsing /proc/<pid>/stat.
// Field layout after the comm field: state ppid pgrp ...
// Returns 0 on any error (caller treats 0 pgid as "skip process group kill").
func readLeaderPGID(pid int) int {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0
	}
	// The comm field is wrapped in parens and may contain spaces; find the last ')'.
	s := string(data)
	end := strings.LastIndex(s, ")")
	if end < 0 || end+2 >= len(s) {
		return 0
	}
	// After ")" the fields are: " state ppid pgrp ..."
	fields := strings.Fields(s[end+1:])
	if len(fields) < 3 {
		return 0
	}
	pgid, err := strconv.Atoi(fields[2])
	if err != nil {
		return 0
	}
	return pgid
}

// killByUID sends sig to every process whose real UID matches uid.
// Used to catch stragglers that have left their original process group.
func killByUID(uid int, sig syscall.Signal) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return
	}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		if uidOfPID(pid) == uid {
			syscall.Kill(pid, sig) //nolint:errcheck
		}
	}
}

// hasProcessesForUID returns true if any process is running with the given real UID.
func hasProcessesForUID(uid int) bool {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return true // fail safe
	}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		if uidOfPID(pid) == uid {
			return true
		}
	}
	return false
}

// uidOfPID reads the real UID of pid from /proc/<pid>/status.
// Returns -1 if the process doesn't exist or the file can't be parsed.
func uidOfPID(pid int) int {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return -1
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "Uid:") {
			continue
		}
		// Uid: ruid euid suid fsuid
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return -1
		}
		uid, err := strconv.Atoi(fields[1])
		if err != nil {
			return -1
		}
		return uid
	}
	return -1
}

// LookupSandboxGID resolves the GID of the "sandbox" group.
// Called at server startup to initialise the pool. Falls back to 0 with a warning.
func LookupSandboxGID() uint32 {
	out, err := exec.Command("getent", "group", "sandbox").Output()
	if err != nil {
		return 0
	}
	// getent output: sandbox:x:GID:members
	parts := strings.Split(strings.TrimSpace(string(out)), ":")
	if len(parts) < 3 {
		return 0
	}
	gid, err := strconv.ParseUint(parts[2], 10, 32)
	if err != nil {
		return 0
	}
	return uint32(gid)
}
