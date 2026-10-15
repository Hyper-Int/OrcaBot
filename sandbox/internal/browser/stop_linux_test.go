// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: browser-v22-graceful-stop

//go:build linux

package browser

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func startGroupLeader(t *testing.T, script string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command("sh", "-c", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Skipf("no sh: %v", err)
	}
	// Let the shell install its trap before it is signalled.
	time.Sleep(200 * time.Millisecond)
	return cmd
}

// x11vnc frees its shared-memory framebuffers only when it exits cleanly, so
// a browser stop must deliver SIGTERM and let it run its handler.
func TestStopSendsTermBeforeKill(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "cleaned-up")
	cmd := startGroupLeader(t, `trap 'touch "`+marker+`"; exit 0' TERM; while :; do sleep 0.05; done`)

	start := time.Now()
	killProcessTree(cmd)
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("TERM handler did not run: %v", err)
	}
	if d := time.Since(start); d >= processStopGrace {
		t.Fatalf("stop waited %v for a process that exited on TERM", d)
	}
	if processRunning(cmd) {
		t.Fatal("process still running")
	}
}

func TestStopKillsProcessesIgnoringTerm(t *testing.T) {
	stubborn := startGroupLeader(t, `trap '' TERM; while :; do sleep 0.05; done`)
	polite := startGroupLeader(t, `trap 'exit 0' TERM; while :; do sleep 0.05; done`)

	start := time.Now()
	stоpProcessGroups(stubborn, polite, nil)
	d := time.Since(start)
	if d < processStopGrace {
		t.Fatalf("stop returned after %v, before the grace period, though one process ignores TERM", d)
	}
	if d > processStopGrace+2*time.Second {
		t.Fatalf("stop took %v", d)
	}
	for _, cmd := range []*exec.Cmd{stubborn, polite} {
		// Signal 0 still succeeds on an unreaped zombie, so ESRCH means the
		// process was killed and reaped.
		if err := syscall.Kill(cmd.Process.Pid, 0); err != syscall.ESRCH {
			t.Fatalf("pid %d not killed and reaped (kill 0: %v)", cmd.Process.Pid, err)
		}
	}
}
