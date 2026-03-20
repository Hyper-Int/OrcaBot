// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

//go:build !linux

package pty

import (
	"os/exec"
	"syscall"
)

// applySlotCredential is a no-op on non-Linux platforms.
func applySlotCredential(cmd *exec.Cmd, slot *SlotEntry, sandboxGID uint32) {}

// readLeaderPGID is a no-op on non-Linux platforms.
func readLeaderPGID(pid int) int { return 0 }

// killByUID is a no-op on non-Linux platforms.
func killByUID(uid int, sig syscall.Signal) {}

// hasProcessesForUID always returns false on non-Linux platforms (no /proc).
func hasProcessesForUID(uid int) bool { return false }

// LookupSandboxGID always returns 0 on non-Linux platforms.
func LookupSandboxGID() uint32 { return 0 }
