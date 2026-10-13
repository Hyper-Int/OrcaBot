// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: browser-safewrite-v2-nofollow-root

package browser

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// An agent replaces the screenshot target with a symlink to a root-only file:
// the write must replace the link, not write through it.
func TestScreenshotWriteDoesNotFollowSymlinkedTarget(t *testing.T) {
	ws := t.TempDir()
	victim := filepath.Join(t.TempDir(), "shadow")
	os.WriteFile(victim, []byte("keep"), 0o600)
	if err := os.Symlink(victim, filepath.Join(ws, "shot.png")); err != nil {
		t.Fatal(err)
	}

	path, err := writeWorkspaceFile(ws, "shot.png", []byte("PNG"), 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(victim); string(data) != "keep" {
		t.Fatalf("wrote through the symlink: victim now %q", data)
	}
	fi, err := os.Lstat(path)
	if err != nil || !fi.Mode().IsRegular() || fi.Mode().Perm() != 0o644 {
		t.Fatalf("target should now be a regular 0644 file: %v %v", fi, err)
	}
	if data, _ := os.ReadFile(path); string(data) != "PNG" {
		t.Fatalf("screenshot content %q", data)
	}
}

// An agent replaces a parent directory with a symlink (e.g. to /root/.ssh):
// nothing may be created through it.
func TestScreenshotWriteRefusesSymlinkedParent(t *testing.T) {
	ws := t.TempDir()
	outside := t.TempDir() // e.g. /root/.ssh
	if err := os.Symlink(outside, filepath.Join(ws, "shots")); err != nil {
		t.Fatal(err)
	}
	_, err := writeWorkspaceFile(ws, "shots/authorized_keys", []byte("PNG"), 0o644)
	if !errors.Is(err, errSymlinkInPath) {
		t.Fatalf("expected errSymlinkInPath, got %v", err)
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatalf("created files through a symlinked dir: %v", entries)
	}

	// A deeper symlinked component too.
	os.MkdirAll(filepath.Join(ws, "a"), 0o755)
	os.Symlink(outside, filepath.Join(ws, "a", "b"))
	if _, err := writeWorkspaceFile(ws, "a/b/c/x.png", []byte("PNG"), 0o644); !errors.Is(err, errSymlinkInPath) {
		t.Fatalf("expected errSymlinkInPath for nested link, got %v", err)
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatalf("created files through a nested symlinked dir: %v", entries)
	}
}

func TestScreenshotWriteCreatesDirsAndRejectsEscapes(t *testing.T) {
	ws := t.TempDir()
	path, err := writeWorkspaceFile(ws, "out/deep/s.png", []byte("PNG"), 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if path != filepath.Join(ws, "out", "deep", "s.png") {
		t.Fatalf("path = %s", path)
	}
	if data, _ := os.ReadFile(path); string(data) != "PNG" {
		t.Fatalf("content %q", data)
	}
	for _, bad := range []string{"", "/etc/passwd", "../x.png", "a/../../x.png", ".", "a/.."} {
		if _, err := writeWorkspaceFile(ws, bad, []byte("PNG"), 0o644); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	// A directory at the target is not replaced.
	os.Mkdir(filepath.Join(ws, "dir.png"), 0o755)
	if _, err := writeWorkspaceFile(ws, "dir.png", []byte("PNG"), 0o644); err == nil {
		t.Error("replaced a directory")
	}
	// No temp files left behind.
	entries, _ := os.ReadDir(ws)
	for _, e := range entries {
		if len(e.Name()) > 0 && e.Name()[0] == '.' {
			t.Errorf("leftover temp file %s", e.Name())
		}
	}
}

// Desktop roots a dashboard at /workspace/<dashboardID>, inside the
// agent-writable /workspace: the agent can swap the root itself for a symlink.
func TestScreenshotWriteRefusesSymlinkedWorkspaceRoot(t *testing.T) {
	base := t.TempDir()
	target := t.TempDir()
	root := filepath.Join(base, "dash-1")
	if err := os.Symlink(target, root); err != nil {
		t.Fatal(err)
	}
	if _, err := writeWorkspaceFile(root, "shot.png", []byte("PNG"), 0o644); !errors.Is(err, errSymlinkInPath) {
		t.Fatalf("err = %v, want errSymlinkInPath", err)
	}
	if _, err := os.Stat(filepath.Join(target, "shot.png")); !os.IsNotExist(err) {
		t.Fatal("wrote through the symlinked workspace root")
	}
}
