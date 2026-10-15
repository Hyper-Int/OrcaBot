// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: browser-process-v2-shm-rmid-forced

//go:build linux

package browser

import (
	"log"
	"os"
	"os/exec"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const processRevision = "browser-process-v2-shm-rmid-forced"

func init() {
	log.Printf("[browser] REVISION: %s loaded at %s", processRevision, time.Now().Format(time.RFC3339))
}

const shmRmidForcedPath = "/proc/sys/kernel/shm_rmid_forced"

// EnableOrphanShmCleanup sets kernel.shm_rmid_forced=1, so a SysV shared
// memory segment is destroyed once its creator has exited and nothing has it
// attached. x11vnc frees its framebuffer segments only on a clean exit; one
// that crashes or is OOM-killed would otherwise leak them until the VM hits
// kernel.shmmni and no x11vnc can start (see stоpProcessGroups).
//
// Best effort: in a Docker container /proc/sys is read-only, which is logged.
// Fly machines and the desktop VM run the image as a VM, where it applies.
func EnableOrphanShmCleanup() {
	if cur, err := os.ReadFile(shmRmidForcedPath); err == nil && strings.TrimSpace(string(cur)) == "1" {
		log.Printf("[browser] kernel.shm_rmid_forced already 1")
		return
	}
	if err := os.WriteFile(shmRmidForcedPath, []byte("1\n"), 0o644); err != nil {
		log.Printf("[browser] WARNING: could not set kernel.shm_rmid_forced=1 (%v); shared memory of crashed x11vnc processes will not be freed", err)
		return
	}
	log.Printf("[browser] kernel.shm_rmid_forced set to 1")
}

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
