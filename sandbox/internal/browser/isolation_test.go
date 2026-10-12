// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

//go:build linux

package browser

import (
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// nobody: an unprivileged identity to hand files to. These tests need root
// (they chown), which is how the sandbox server runs.
var testID = browserIdentity{uid: 65534, gid: 65534}

func needRoot(t *testing.T) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("needs root (chown)")
	}
}

func owner(t *testing.T, path string) int {
	t.Helper()
	fi, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	return int(fi.Sys().(*syscall.Stat_t).Uid)
}

func TestProfileSymlinkIsMovedAsideNotFollowed(t *testing.T) {
	needRoot(t)
	ws := t.TempDir()
	victim := t.TempDir() // e.g. /etc/cron.d
	os.WriteFile(filepath.Join(victim, "SingletonLock"), []byte("keep"), 0o644)
	profile := filepath.Join(ws, ".browser")
	if err := os.Symlink(victim, profile); err != nil {
		t.Fatal(err)
	}

	if err := prepareProfileDir(profile, testID); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Lstat(profile)
	if !fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 {
		t.Fatalf(".browser should be a real directory now, got %v", fi.Mode())
	}
	if owner(t, profile) != testID.uid || fi.Mode().Perm() != 0o700 {
		t.Fatalf("profile owner/mode = %d/%v", owner(t, profile), fi.Mode().Perm())
	}
	if _, err := os.Stat(filepath.Join(victim, "SingletonLock")); err != nil {
		t.Fatal("root followed the symlink and deleted a file in the target")
	}
	if owner(t, victim) == testID.uid {
		t.Fatal("root chowned the symlink target")
	}
	moved, _ := filepath.Glob(profile + ".invalid-*")
	if len(moved) != 1 {
		t.Fatalf("symlink not moved aside: %v", moved)
	}
}

func TestLegacyRootProfileIsHandedOverWithoutFollowingLinks(t *testing.T) {
	needRoot(t)
	ws := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret")
	os.WriteFile(outside, []byte("x"), 0o600)
	profile := filepath.Join(ws, ".browser")
	os.MkdirAll(filepath.Join(profile, "Default", "Cache"), 0o755)
	os.WriteFile(filepath.Join(profile, "Default", "Cookies"), []byte("c"), 0o644)
	os.Symlink(outside, filepath.Join(profile, "Default", "link"))
	os.WriteFile(filepath.Join(profile, "SingletonLock"), nil, 0o644)

	if err := prepareProfileDir(profile, testID); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{profile, filepath.Join(profile, "Default"), filepath.Join(profile, "Default", "Cache"), filepath.Join(profile, "Default", "Cookies"), filepath.Join(profile, "Default", "link")} {
		if owner(t, p) != testID.uid {
			t.Errorf("%s not handed to the browser user", p)
		}
	}
	if owner(t, outside) != 0 {
		t.Fatal("chown followed a symlink out of the profile")
	}
	if _, err := os.Lstat(filepath.Join(profile, "SingletonLock")); !os.IsNotExist(err) {
		t.Fatal("stale SingletonLock not removed")
	}
}

func TestCrashStateCleanedWithoutFollowingDefaultSymlink(t *testing.T) {
	needRoot(t)
	ws := t.TempDir()
	profile := filepath.Join(ws, ".browser")
	os.MkdirAll(profile, 0o700)
	elsewhere := t.TempDir()
	prefs := filepath.Join(elsewhere, "Preferences")
	os.WriteFile(prefs, []byte(`{"profile":{"exit_type":"Crashed"}}`), 0o644)
	os.Symlink(elsewhere, filepath.Join(profile, "Default"))

	if err := prepareProfileDir(profile, testID); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(prefs); !strings.Contains(string(data), "Crashed") {
		t.Fatal("rewrote Preferences through a Default symlink")
	}
}

func TestCrashStateCleaned(t *testing.T) {
	needRoot(t)
	profile := filepath.Join(t.TempDir(), ".browser")
	os.MkdirAll(filepath.Join(profile, "Default"), 0o700)
	os.WriteFile(filepath.Join(profile, "Default", "Preferences"), []byte(`{"profile":{"exit_type":"Crashed","name":"p"}}`), 0o600)

	if err := prepareProfileDir(profile, testID); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(profile, "Default", "Preferences"))
	var got struct {
		Profile map[string]interface{} `json:"profile"`
	}
	json.Unmarshal(data, &got)
	if got.Profile["exit_type"] != "Normal" || got.Profile["exited_cleanly"] != true || got.Profile["name"] != "p" {
		t.Fatalf("prefs = %s", data)
	}
	if owner(t, filepath.Join(profile, "Default", "Preferences")) != testID.uid {
		t.Fatal("rewritten Preferences not owned by the browser user")
	}
}

func TestXauthorityCookie(t *testing.T) {
	needRoot(t)
	path := filepath.Join(t.TempDir(), "xauth")
	if err := writeXauthority(path, 91, testID); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(path)
	if fi.Mode().Perm() != 0o600 || owner(t, path) != testID.uid {
		t.Fatalf("xauth mode/owner = %v/%d", fi.Mode().Perm(), owner(t, path))
	}
	data, _ := os.ReadFile(path)
	if binary.BigEndian.Uint16(data[0:2]) != 0xffff {
		t.Fatal("expected FamilyWild")
	}
	if !strings.Contains(string(data), "91") || !strings.Contains(string(data), "MIT-MAGIC-COOKIE-1") {
		t.Fatalf("unexpected xauth entry %q", data)
	}
	if len(data) != 2+2+0+2+2+2+18+2+16 {
		t.Fatalf("entry length %d", len(data))
	}
}

func TestPortsComeFromTheBlockedRange(t *testing.T) {
	a, err := freePortInRange()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := freePortInRange(a)
	if a < PortRangeStart || a > PortRangeEnd || b < PortRangeStart || b > PortRangeEnd || a == b {
		t.Fatalf("ports %d, %d", a, b)
	}
}
