// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

//go:build linux

package bgproc

import (
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"
)

// On a real /proc: a process that detached from its terminal's group (setsid) is found
// by its ORCABOT_PTY_ID, one still in a live group is not, and Stop ends it.
func TestRealDetachedProcess(t *testing.T) {
	id := "it-pty-" + time.Now().Format("150405.000000")
	inGroup := exec.Command("sleep", "60")
	inGroup.Env = append(os.Environ(), "ORCABOT_PTY_ID="+id)
	inGroup.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	detached := exec.Command("sleep", "61")
	detached.Env = append(os.Environ(), "ORCABOT_PTY_ID="+id)
	detached.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	for _, c := range []*exec.Cmd{inGroup, detached} {
		if err := c.Start(); err != nil {
			t.Fatal(err)
		}
		defer c.Process.Kill() //nolint:errcheck
	}
	go detached.Wait() //nolint:errcheck // reap, so it doesn't linger as a zombie

	s := New()
	live := map[int]bool{inGroup.Process.Pid: true}
	found := s.Find([]string{id}, live)
	if len(found) != 1 || found[0].PID != detached.Process.Pid || !strings.Contains(found[0].Command, "sleep 61") {
		t.Fatalf("want only the detached sleep, got %+v", found)
	}
	if found[0].StartedAt.IsZero() || time.Since(found[0].StartedAt) > time.Minute {
		t.Fatalf("started_at %v", found[0].StartedAt)
	}
	res := s.Stop([]Target{{PID: inGroup.Process.Pid, StartTicks: 0}, {PID: found[0].PID, StartTicks: found[0].StartTicks}}, []string{id}, live, 2*time.Second)
	if len(res) != 2 || res[0].Outcome != "refused" || res[1].Outcome != "stopped" {
		t.Fatalf("results %+v", res)
	}
}
