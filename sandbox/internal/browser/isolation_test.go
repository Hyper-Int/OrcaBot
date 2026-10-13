// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: browser-isolation-v5-profile-per-dashboard

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
	profile := filepath.Join(ws, "profile")
	if err := os.Symlink(victim, profile); err != nil {
		t.Fatal(err)
	}

	if err := prepareProfileDir(profile, testID); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Lstat(profile)
	if !fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("profile should be a real directory now, got %v", fi.Mode())
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

func TestCrashStateCleanedWithoutFollowingDefaultSymlink(t *testing.T) {
	needRoot(t)
	ws := t.TempDir()
	profile := filepath.Join(ws, "profile")
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
	profile := filepath.Join(t.TempDir(), "profile")
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
	profile := filepath.Join(ws, "profile")
	// Something other than the browser user or root owns the profile (it
	// can't happen in the 0700 home, but if it did): seeded with a setgid,
	// group-writable dir its owner could keep writing to.
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
	profile := filepath.Join(t.TempDir(), "profile")
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

// A root-owned profile directory can only be one root itself created (the
// home is 0700, owned by the browser user): it is given to the browser user.
func TestRootOwnedProfileDirIsChowned(t *testing.T) {
	needRoot(t)
	profile := filepath.Join(t.TempDir(), "profile")
	os.Mkdir(profile, 0o755)
	if err := prepareProfileDir(profile, testID); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Lstat(profile)
	if owner(t, profile) != testID.uid || fi.Mode().Perm() != 0o700 {
		t.Fatalf("profile owner/mode = %d/%v", owner(t, profile), fi.Mode().Perm())
	}
}

// The profile must never live in the agent-writable workspace again: an agent
// could rename it and swap in its own directory while the browser runs.
func TestProfileIsInBrowserHomeNotWorkspace(t *testing.T) {
	id := browserIdentity{uid: 1990, gid: 1990, home: "/home/orcabot-browser"}
	for _, ws := range []string{"/workspace", "/workspace/dash-a"} {
		got := profilePath(id, ws)
		if !strings.HasPrefix(got, "/home/orcabot-browser/profiles/") {
			t.Fatalf("profilePath(%s) = %s", ws, got)
		}
		if strings.HasPrefix(got, "/workspace") {
			t.Fatalf("profile %s is under the workspace", got)
		}
	}
}

// Desktop runs every dashboard in one VM, each with its own browser
// controller: they must not share cookies or local storage.
func TestEachDashboardWorkspaceGetsItsOwnProfile(t *testing.T) {
	id := browserIdentity{uid: 1990, gid: 1990, home: "/home/orcabot-browser"}
	a, b := profilePath(id, "/workspace/dash-a"), profilePath(id, "/workspace/dash-b")
	if a == b {
		t.Fatalf("dashboards share profile %s", a)
	}
	if profilePath(id, "/workspace/dash-a/") != a {
		t.Fatal("profile depends on a trailing slash")
	}
	if filepath.Dir(a) != "/home/orcabot-browser/profiles" || strings.ContainsAny(filepath.Base(a), "/.") {
		t.Fatalf("profile %s is not one fixed component under profiles/", a)
	}
}

func TestCheckBrowserHome(t *testing.T) {
	needRoot(t)
	// Parents must be root-owned and not group/other-writable, so build the
	// chain under / rather than the sticky, world-writable /tmp.
	base, err := os.MkdirTemp("/", "orcabot-home-test-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(base)
	os.Chmod(base, 0o755)
	home := filepath.Join(base, "home")
	os.Mkdir(home, 0o700)
	os.Chown(home, testID.uid, testID.gid)
	id := browserIdentity{uid: testID.uid, gid: testID.gid, home: home}
	if err := checkBrowserHome(id); err != nil {
		t.Fatalf("good home rejected: %v", err)
	}

	os.Chmod(home, 0o750)
	if checkBrowserHome(id) == nil {
		t.Fatal("group-readable home accepted")
	}
	os.Chmod(home, 0o700)

	os.Chmod(base, 0o775)
	if checkBrowserHome(id) == nil {
		t.Fatal("home under a group-writable parent accepted")
	}
	os.Chmod(base, 0o755)

	os.Chown(base, 2000, 2000)
	if checkBrowserHome(id) == nil {
		t.Fatal("home under an agent-owned parent accepted")
	}
	os.Chown(base, 0, 0)

	link := filepath.Join(base, "link")
	os.Symlink(home, link)
	if checkBrowserHome(browserIdentity{uid: testID.uid, gid: testID.gid, home: link}) == nil {
		t.Fatal("symlinked home accepted")
	}

	tmpHome := t.TempDir() // under /tmp: sticky, world-writable parent
	os.Chown(tmpHome, testID.uid, testID.gid)
	os.Chmod(tmpHome, 0o700)
	if checkBrowserHome(browserIdentity{uid: testID.uid, gid: testID.gid, home: tmpHome}) == nil {
		t.Fatal("home under /tmp accepted")
	}
}

func TestLegacyWorkspaceProfileRemoved(t *testing.T) {
	needRoot(t)
	ws := t.TempDir()
	outside := filepath.Join(t.TempDir(), "keep")
	os.WriteFile(outside, []byte("keep"), 0o600)
	legacy := filepath.Join(ws, ".browser")
	os.MkdirAll(filepath.Join(legacy, "Default", "Cache"), 0o700)
	os.WriteFile(filepath.Join(legacy, "Default", "Cookies"), []byte("c"), 0o600)
	os.Symlink(filepath.Dir(outside), filepath.Join(legacy, "Default", "link"))
	filepath.Walk(legacy, func(p string, _ os.FileInfo, _ error) error {
		os.Lchown(p, testID.uid, testID.gid)
		return nil
	})

	if err := removeLegacyProfile(ws, testID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(legacy); !os.IsNotExist(err) {
		t.Fatal("legacy profile not removed")
	}
	if data, _ := os.ReadFile(outside); string(data) != "keep" {
		t.Fatal("removal followed a symlink out of the profile")
	}
}

func TestLegacyProfileNotBrowserOwnedIsLeftAlone(t *testing.T) {
	needRoot(t)
	ws := t.TempDir()
	// An agent's directory renamed to .browser: not ours to delete.
	agentDir := filepath.Join(ws, ".browser")
	os.MkdirAll(agentDir, 0o775)
	os.WriteFile(filepath.Join(agentDir, "work"), []byte("w"), 0o664)
	os.Chown(agentDir, 2000, 2000)
	if err := removeLegacyProfile(ws, testID); err == nil {
		t.Fatal("expected a refusal for a foreign-owned .browser")
	}
	if _, err := os.Stat(filepath.Join(agentDir, "work")); err != nil {
		t.Fatal("agent's files deleted")
	}

	// A symlink to somewhere else: never followed.
	os.RemoveAll(agentDir)
	target := t.TempDir()
	os.WriteFile(filepath.Join(target, "f"), []byte("x"), 0o600)
	os.Chown(target, testID.uid, testID.gid)
	os.Symlink(target, agentDir)
	_ = removeLegacyProfile(ws, testID)
	if _, err := os.Stat(filepath.Join(target, "f")); err != nil {
		t.Fatal("removal followed a .browser symlink")
	}
}
