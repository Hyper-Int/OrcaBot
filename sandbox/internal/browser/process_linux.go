// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: browser-process-v1-waitid-nowait

//go:build linux

package browser

import (
	"os/exec"

	"golang.org/x/sys/unix"
)

// processRunning reports whether cmd's process is still alive, without reaping
// it (WNOWAIT), so killProcessTree's Wait still works afterwards.
func processRunning(cmd *exec.Cmd) bool {
	if cmd == nil || cmd.Process == nil {
		return false
	}
	var info unix.Siginfo
	err := unix.Waitid(unix.P_PID, cmd.Process.Pid, &info, unix.WEXITED|unix.WNOHANG|unix.WNOWAIT, nil)
	if err != nil {
		return false // already reaped, or not our child
	}
	// WNOHANG with no state change leaves the siginfo zeroed.
	return info.Signo == 0
}
