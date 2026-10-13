// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

//go:build linux

package browser

import (
	"bytes"
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
	cookie, _ := newXCookie()
	if err := writeXauthority(path, 91, cookie, testID); err != nil {
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
	if len(data) != 2+2+0+2+2+2+18+2+16 || !bytes.HasSuffix(data, cookie) {
		t.Fatalf("entry length %d", len(data))
	}

	// Rewritten with the display Xvfb picked: same cookie, new number.
	if err := writeXauthority(path, 7, cookie, testID); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(path)
	if !bytes.HasSuffix(data, cookie) || strings.Contains(string(data), "91") || !strings.Contains(string(data), "\x00\x017") {
		t.Fatalf("rewritten entry %q", data)
	}
}

func TestXauthorityTempSymlinkNotFollowed(t *testing.T) {
	needRoot(t)
	dir := t.TempDir()
	victim := filepath.Join(t.TempDir(), "victim")
	os.WriteFile(victim, []byte("keep"), 0o644)
	path := filepath.Join(dir, "xauth")
	// The browser user owns its home, so it could plant this.
	os.Symlink(victim, path+".tmp")
	cookie, _ := newXCookie()
	if err := writeXauthority(path, 1, cookie, testID); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(victim); string(data) != "keep" || owner(t, victim) != 0 {
		t.Fatal("writeXauthority wrote through a symlink")
	}
}

func TestForeignOwnedProfileIsMovedAsideNotHandedOver(t *testing.T) {
	needRoot(t)
	ws := t.TempDir()
	profile := filepath.Join(ws, ".browser")
	// An agent (pool UID) pre-creates the profile, seeding it with a
	// setgid, group-writable dir it can keep writing to.
	os.MkdirAll(filepath.Join(profile, "Default"), 0o777)
	os.WriteFile(filepath.Join(profile, "Default", "Preferences"), []byte(`{}`), 0o666)
	for _, p := range []string{profile, filepath.Join(profile, "Default"), filepath.Join(profile, "Default", "Preferences")} {
		os.Chown(p, 2000, 2000)
	}
	os.Chmod(filepath.Join(profile, "Default"), 0o2777)

	if err := prepareProfileDir(profile, testID); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Lstat(profile)
	if owner(t, profile) != testID.uid || fi.Mode().Perm() != 0o700 {
		t.Fatalf("profile owner/mode = %d/%v", owner(t, profile), fi.Mode().Perm())
	}
	if entries, _ := os.ReadDir(profile); len(entries) != 0 {
		t.Fatalf("foreign profile contents carried over: %v", entries)
	}
	moved, _ := filepath.Glob(profile + ".invalid-*")
	if len(moved) != 1 {
		t.Fatalf("foreign profile not moved aside: %v", moved)
	}
	if owner(t, moved[0]) != 2000 || owner(t, filepath.Join(moved[0], "Default", "Preferences")) != 2000 {
		t.Fatal("foreign profile was handed over before being moved aside")
	}
}

func TestBrowserOwnedProfileKept(t *testing.T) {
	needRoot(t)
	profile := filepath.Join(t.TempDir(), ".browser")
	os.MkdirAll(filepath.Join(profile, "Default"), 0o700)
	os.WriteFile(filepath.Join(profile, "Default", "Cookies"), []byte("c"), 0o600)
	os.Chown(profile, testID.uid, testID.gid)

	if err := prepareProfileDir(profile, testID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(profile, "Default", "Cookies")); err != nil {
		t.Fatal("browser-owned profile lost its contents")
	}
	if moved, _ := filepath.Glob(profile + ".invalid-*"); len(moved) != 0 {
		t.Fatalf("browser-owned profile moved aside: %v", moved)
	}
}

func TestRootProfileHandoverStripsGroupOtherBits(t *testing.T) {
	needRoot(t)
	// A legitimate legacy profile: root-owned, nothing group/other-writable,
	// but readable by others and with setgid/sticky/setuid bits about.
	profile := filepath.Join(t.TempDir(), ".browser")
	sub := filepath.Join(profile, "Default", "Cache")
	os.MkdirAll(sub, 0o755)
	os.Chmod(profile, 0o755)
	os.Chmod(filepath.Join(profile, "Default"), 0o2755)
	os.Chmod(sub, 0o1755)
	file := filepath.Join(profile, "Default", "Cookies")
	os.WriteFile(file, []byte("c"), 0o644)
	os.Chmod(file, 0o4744)

	if err := prepareProfileDir(profile, testID); err != nil {
		t.Fatal(err)
	}
	want := map[string]os.FileMode{
		profile:                           os.ModeDir | 0o700,
		filepath.Join(profile, "Default"): os.ModeDir | 0o700,
		sub:                               os.ModeDir | 0o700,
		file:                              0o700,
	}
	for p, mode := range want {
		fi, err := os.Lstat(p)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode() != mode || owner(t, p) != testID.uid {
			t.Errorf("%s: mode %v owner %d, want %v owner %d", p, fi.Mode(), owner(t, p), mode, testID.uid)
		}
	}
}

// An agent can rename any root-owned directory it can write into `.browser`
// (/workspace has no sticky bit). Such a tree is moved aside, never handed
// over, whichever part of it betrays the agent's access.
func TestPlantedRootOwnedProfileIsMovedAside(t *testing.T) {
	needRoot(t)
	for _, tc := range []struct {
		name  string
		plant func(profile string)
	}{
		{"group-writable top dir", func(p string) {
			os.Chmod(p, 0o2775)
		}},
		{"group-writable subdir", func(p string) {
			os.Mkdir(filepath.Join(p, "Default"), 0o755)
			os.Chmod(filepath.Join(p, "Default"), 0o777)
		}},
		{"agent-owned file", func(p string) {
			os.MkdirAll(filepath.Join(p, "Default"), 0o755)
			f := filepath.Join(p, "Default", "Preferences")
			os.WriteFile(f, []byte(`{}`), 0o600)
			os.Chown(f, 2000, 2000)
		}},
		{"agent-owned symlink", func(p string) {
			os.Symlink("/tmp", filepath.Join(p, "link"))
			os.Lchown(filepath.Join(p, "link"), 2000, 2000)
		}},
		{"root file the agent can write", func(p string) {
			f := filepath.Join(p, "Local State")
			os.WriteFile(f, []byte(`{}`), 0o644)
			os.Chmod(f, 0o666)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			profile := filepath.Join(t.TempDir(), ".browser")
			os.Mkdir(profile, 0o755)
			tc.plant(profile)

			if err := prepareProfileDir(profile, testID); err != nil {
				t.Fatal(err)
			}
			if entries, _ := os.ReadDir(profile); len(entries) != 0 || owner(t, profile) != testID.uid {
				t.Fatalf("planted tree handed over: owner %d, entries %v", owner(t, profile), entries)
			}
			moved, _ := filepath.Glob(profile + ".invalid-*")
			if len(moved) != 1 {
				t.Fatalf("planted tree not moved aside: %v", moved)
			}
			if owner(t, moved[0]) != 0 {
				t.Fatal("planted tree chowned before being moved aside")
			}
		})
	}
}

func TestRootProfileHandoverUnlinksHardLinks(t *testing.T) {
	needRoot(t)
	// Same filesystem, as a hard link needs.
	base := t.TempDir()
	outside := filepath.Join(base, "shadow")
	os.WriteFile(outside, []byte("x"), 0o640)
	profile := filepath.Join(base, ".browser")
	os.MkdirAll(profile, 0o755)
	if err := os.Link(outside, filepath.Join(profile, "linked")); err != nil {
		t.Fatal(err)
	}

	if err := prepareProfileDir(profile, testID); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(outside)
	if owner(t, outside) != 0 || fi.Mode().Perm() != 0o640 {
		t.Fatalf("hard-linked file outside the profile changed: owner %d mode %v", owner(t, outside), fi.Mode().Perm())
	}
	if _, err := os.Lstat(filepath.Join(profile, "linked")); !os.IsNotExist(err) {
		t.Fatal("hard link left in the profile (root-owned, unwritable by Chromium)")
	}
}

func TestRootProfileHandoverRemovesSpecialFiles(t *testing.T) {
	needRoot(t)
	profile := filepath.Join(t.TempDir(), ".browser")
	os.MkdirAll(profile, 0o755)
	fifo := filepath.Join(profile, "fifo")
	if err := syscall.Mkfifo(fifo, 0o666); err != nil {
		t.Fatal(err)
	}
	if err := prepareProfileDir(profile, testID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(fifo); !os.IsNotExist(err) {
		t.Fatal("FIFO left in handed-over profile")
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
