// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package bgproc

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// fakeProc builds a /proc tree; kill marks a process as exited (removes it) on signal.
type fakeProc struct {
	t       *testing.T
	root    string
	signals []string
	// ignoreTerm: these pids survive SIGTERM (only SIGKILL removes them)
	ignoreTerm map[int]bool
}

func newFakeProc(t *testing.T) *fakeProc {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "stat"), []byte("cpu 1 2 3\nbtime 1795300000\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return &fakeProc{t: t, root: root, ignoreTerm: map[int]bool{}}
}

func (f *fakeProc) add(pid, ppid, pgrp int, state, comm string, start uint64, env map[string]string, cmd ...string) {
	dir := filepath.Join(f.root, fmt.Sprint(pid))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		f.t.Fatal(err)
	}
	// fields after "(comm)": state ppid pgrp session tty tpgid flags minflt cminflt majflt
	// cmajflt utime stime cutime cstime priority nice threads itreal starttime
	stat := fmt.Sprintf("%d (%s) %s %d %d %d 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 %d 0 0", pid, comm, state, ppid, pgrp, pgrp, start)
	var envb strings.Builder
	for k, v := range env {
		envb.WriteString(k + "=" + v + "\x00")
	}
	files := map[string]string{
		"stat":    stat,
		"environ": envb.String(),
		"status":  "Name:\t" + comm + "\nUid:\t0\t0\t0\t0\n",
		"cmdline": strings.Join(cmd, "\x00") + "\x00",
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			f.t.Fatal(err)
		}
	}
}

func (f *fakeProc) scanner() *Scanner {
	return &Scanner{Root: f.root, Self: 99999, ClockTicks: 100, Kill: func(pid int, sig syscall.Signal) error {
		f.signals = append(f.signals, fmt.Sprintf("%d:%v", pid, sig))
		if sig == syscall.SIGTERM && f.ignoreTerm[pid] {
			return nil
		}
		return os.RemoveAll(filepath.Join(f.root, fmt.Sprint(pid)))
	}}
}

func pty(id string) map[string]string { return map[string]string{"ORCABOT_PTY_ID": id, "HOME": "/workspace/.home"} }

// The 2026-11-22 case: Codex's app-server daemon (and its child) started by an earlier
// run of the Codex terminal, detached; the current Codex TUI inside the live PTY group.
func setup(t *testing.T) *fakeProc {
	f := newFakeProc(t)
	f.add(806, 1, 806, "S", "codex", 5000, pty("old-codex-pty"), "/x/codex", "app-server", "--listen", "unix://")
	f.add(27256, 806, 806, "S", "codex-code-mode", 9000, pty("old-codex-pty"), "/x/codex-code-mode-host")
	f.add(12338, 621, 12338, "S", "codex", 12000, pty("new-codex-pty"), "codex", "--dangerously-bypass-approvals-and-sandbox")
	f.add(12339, 12338, 12338, "S", "bash", 12001, pty("new-codex-pty"), "bash", "/tmp/pokerbench/seat.sh", "helper", "openai")
	f.add(26700, 621, 26700, "S", "claude", 7000, pty("claude-pty"), "claude")          // another terminal
	f.add(40000, 1, 40000, "S", "node", 7500, pty("claude-pty"), "node", "devserver.js") // another terminal's daemon
	f.add(650, 1, 650, "S", "agent-link", 100, map[string]string{"HOME": "/var/lib"}, "orcabot-agent-link")
	f.add(41000, 1, 41000, "Z", "defunct", 8000, pty("old-codex-pty"))
	return f
}

func TestFindsOnlyThisTerminalsDetachedProcesses(t *testing.T) {
	f := setup(t)
	live := map[int]bool{12338: true, 26700: true}
	got := f.scanner().Find([]string{"new-codex-pty", "old-codex-pty"}, live)
	var pids []int
	for _, p := range got {
		pids = append(pids, p.PID)
	}
	if fmt.Sprint(pids) != "[806 27256]" {
		t.Fatalf("want the detached daemon and its child (oldest first), got %v", pids)
	}
	if got[0].Command != "/x/codex app-server --listen unix://" || got[0].PTYID != "old-codex-pty" || got[0].UID != 0 {
		t.Fatalf("bad process: %+v", got[0])
	}
	if want := time.Unix(1795300000+50, 0).UTC(); !got[0].StartedAt.Equal(want) {
		t.Fatalf("started_at %v, want %v", got[0].StartedAt, want)
	}
	if got := f.scanner().Find(nil, live); len(got) != 0 {
		t.Fatalf("no PTY ids: nothing, got %v", got)
	}
}

func TestStopRechecksEachProcess(t *testing.T) {
	f := setup(t)
	f.ignoreTerm[27256] = true
	live := map[int]bool{12338: true, 26700: true}
	ids := []string{"new-codex-pty", "old-codex-pty"}
	res := f.scanner().Stop([]Target{
		{PID: 806, StartTicks: 5000},
		{PID: 27256, StartTicks: 9000}, // ignores SIGTERM: SIGKILL after the grace
		{PID: 40000, StartTicks: 7500}, // another terminal's: refused
		{PID: 12339, StartTicks: 12001}, // inside the live PTY group: refused
		{PID: 650, StartTicks: 100},     // not a terminal process: refused
		{PID: 55555, StartTicks: 1},     // gone
	}, ids, live, 300*time.Millisecond)
	out := map[int]string{}
	for _, r := range res {
		out[r.PID] = r.Outcome
	}
	want := map[int]string{806: "stopped", 27256: "stopped", 40000: "refused", 12339: "refused", 650: "refused", 55555: "gone"}
	for pid, o := range want {
		if out[pid] != o {
			t.Errorf("pid %d: %q, want %q (all: %v)", pid, out[pid], o, res)
		}
	}
	if s := strings.Join(f.signals, " "); s != "806:terminated 27256:terminated 27256:killed" {
		t.Fatalf("signals: %s", s)
	}
}

func TestStopRefusesAReusedPID(t *testing.T) {
	f := setup(t)
	res := f.scanner().Stop([]Target{{PID: 806, StartTicks: 4999}}, []string{"old-codex-pty"}, nil, time.Second)
	if len(res) != 1 || res[0].Outcome != "gone" || len(f.signals) != 0 {
		t.Fatalf("a different start time is a different process: %v signals=%v", res, f.signals)
	}
}

func TestCommWithSpacesAndParens(t *testing.T) {
	f := newFakeProc(t)
	f.add(500, 1, 500, "S", "tmux: server (1)", 10, pty("p"), "tmux")
	got := f.scanner().Find([]string{"p"}, nil)
	if len(got) != 1 || got[0].Name != "tmux: server (1)" || got[0].PPID != 1 {
		t.Fatalf("got %+v", got)
	}
}
