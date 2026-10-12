// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: browser-isolation-v1-unprivileged-user
package browser

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const isolationRevision = "browser-isolation-v1-unprivileged-user"

func init() {
	log.Printf("[browser] REVISION: %s loaded at %s", isolationRevision, time.Now().Format(time.RFC3339))
}

// The browser stack runs as this unprivileged user (docker/Dockerfile), never
// root. Chromium needs --no-sandbox in the VM, so a root Chromium with a
// DevTools port reachable over loopback let any agent read and write files as
// root (file:// pages, Browser.setDownloadBehavior). As this user, CDP access
// is worth no more than the browser itself.
const BrowserUser = "orcabot-browser"

// Ports for x11vnc, websockify and Chromium's DevTools come from this range so
// iptables can block pool UIDs from all of them (cmd/server/egress_linux.go).
const (
	PortRangeStart = 6100
	PortRangeEnd   = 6299
)

type browserIdentity struct {
	uid, gid int
	home     string
}

func lookupBrowserIdentity() (browserIdentity, error) {
	u, err := user.Lookup(BrowserUser)
	if err != nil {
		return browserIdentity{}, fmt.Errorf("browser user %q missing (rebuild the sandbox image): %w", BrowserUser, err)
	}
	uid, err := strconv.Atoi(u.Uid)
	if err != nil {
		return browserIdentity{}, err
	}
	gid, err := strconv.Atoi(u.Gid)
	if err != nil {
		return browserIdentity{}, err
	}
	if uid == 0 || gid == 0 {
		return browserIdentity{}, fmt.Errorf("browser user %q must not be root", BrowserUser)
	}
	return browserIdentity{uid: uid, gid: gid, home: u.HomeDir}, nil
}

func (id browserIdentity) sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		Setpgid:    true,
		Credential: &syscall.Credential{Uid: uint32(id.uid), Gid: uint32(id.gid), NoSetGroups: false},
	}
}

// env for the browser processes: the server's env minus anything secret-bearing
// it doesn't need, with the browser user's HOME and the X auth cookie.
func (id browserIdentity) env(display, xauthority string) []string {
	return []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=" + id.home,
		"USER=" + BrowserUser,
		"DISPLAY=" + display,
		"XAUTHORITY=" + xauthority,
		"LANG=C.UTF-8",
	}
}

// freePortInRange returns a free 127.0.0.1 port in [PortRangeStart, PortRangeEnd],
// skipping ports already chosen for this start.
func freePortInRange(skip ...int) (int, error) {
	var b [2]byte
	_, _ = rand.Read(b[:])
	span := PortRangeEnd - PortRangeStart + 1
	offset := int(binary.BigEndian.Uint16(b[:])) % span
	for i := 0; i < span; i++ {
		port := PortRangeStart + (offset+i)%span
		taken := false
		for _, s := range skip {
			taken = taken || s == port
		}
		if taken {
			continue
		}
		l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			continue
		}
		_ = l.Close()
		return port, nil
	}
	return 0, fmt.Errorf("no free port in %d-%d", PortRangeStart, PortRangeEnd)
}

// writeXauthority writes an MIT-MAGIC-COOKIE-1 entry for `display` (any host)
// to a 0600 file owned by the browser user. Xvfb is started with -auth on it,
// so only processes holding the cookie (the browser stack) can open the
// display — not agents injecting keystrokes into the browser window.
func writeXauthority(path string, display int, id browserIdentity) error {
	cookie := make([]byte, 16)
	if _, err := rand.Read(cookie); err != nil {
		return err
	}
	field := func(buf []byte, v []byte) []byte {
		buf = binary.BigEndian.AppendUint16(buf, uint16(len(v)))
		return append(buf, v...)
	}
	var entry []byte
	entry = binary.BigEndian.AppendUint16(entry, 0xffff) // FamilyWild: any address
	entry = field(entry, nil)
	entry = field(entry, []byte(strconv.Itoa(display)))
	entry = field(entry, []byte("MIT-MAGIC-COOKIE-1"))
	entry = field(entry, cookie)

	_ = os.Remove(path)
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Write(entry); err != nil {
		return err
	}
	return f.Chown(id.uid, id.gid)
}

// prepareProfileDir makes `path` a real directory owned by the browser user
// (0700) and clears Chromium's stale lock and crash state, without root ever
// following a symlink. The profile lives in /workspace, which every pool UID
// can write (group sandbox, no sticky bit), so an agent could replace
// `.browser` with a symlink; every root operation here goes through a directory
// fd opened with O_NOFOLLOW instead of the path.
func prepareProfileDir(path string, id browserIdentity) error {
	fi, err := os.Lstat(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return err
	case fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir():
		aside := fmt.Sprintf("%s.invalid-%d", path, time.Now().Unix())
		log.Printf("[browser] SECURITY: %s is not a directory (mode %v) — moving it to %s", path, fi.Mode(), aside)
		if err := os.Rename(path, aside); err != nil {
			return fmt.Errorf("move aside %s: %w", path, err)
		}
	}
	if err := unix.Mkdir(path, 0o700); err != nil && !errors.Is(err, unix.EEXIST) {
		return fmt.Errorf("mkdir %s: %w", path, err)
	}

	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("open profile dir %s: %w", path, err)
	}
	dir := os.NewFile(uintptr(fd), path)
	defer dir.Close()

	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return err
	}
	if int(st.Uid) != id.uid {
		// Profiles from before this change are root-owned: hand them over.
		log.Printf("[browser] migrating profile %s to %s ownership", path, BrowserUser)
		if err := chownTree(fd, id); err != nil {
			return fmt.Errorf("chown profile: %w", err)
		}
	}
	if err := unix.Fchown(fd, id.uid, id.gid); err != nil {
		return err
	}
	if err := unix.Fchmod(fd, 0o700); err != nil {
		return err
	}

	// Stale lock files from a previous run cause "profile in use" errors.
	for _, name := range []string{"SingletonLock", "SingletonSocket", "SingletonCookie"} {
		_ = unix.Unlinkat(fd, name, 0)
	}
	cleanCrashStateAt(fd, id)
	return nil
}

// chownTree recursively hands every entry under dirfd to the browser user,
// never following symlinks (they are chowned themselves, not their targets).
func chownTree(dirfd int, id browserIdentity) error {
	dup, err := unix.Dup(dirfd)
	if err != nil {
		return err
	}
	d := os.NewFile(uintptr(dup), "")
	entries, err := d.ReadDir(-1)
	d.Close()
	if err != nil {
		return err
	}
	for _, e := range entries {
		name := e.Name()
		if err := unix.Fchownat(dirfd, name, id.uid, id.gid, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		if e.Type()&os.ModeSymlink == 0 && e.IsDir() {
			sub, err := unix.Openat(dirfd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
			err = chownTree(sub, id)
			unix.Close(sub)
			if err != nil {
				return err
			}
		}
	}
	return nil
}

// cleanCrashStateAt sets profile.exit_type=Normal / exited_cleanly=true in
// Default/Preferences so Chromium doesn't show "Restore pages?", working only
// through fds relative to the profile dir with O_NOFOLLOW.
func cleanCrashStateAt(profileFd int, id browserIdentity) {
	defFd, err := unix.Openat(profileFd, "Default", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return // fresh profile
	}
	defer unix.Close(defFd)

	inFd, err := unix.Openat(defFd, "Preferences", unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return
	}
	in := os.NewFile(uintptr(inFd), "Preferences")
	data, err := io.ReadAll(io.LimitReader(in, 16<<20))
	in.Close()
	if err != nil {
		return
	}

	var prefs map[string]interface{}
	if err := json.Unmarshal(data, &prefs); err != nil {
		log.Printf("[browser] cleanCrashState: failed to parse Preferences: %v", err)
		return
	}
	profile, ok := prefs["profile"].(map[string]interface{})
	if !ok {
		profile = make(map[string]interface{})
		prefs["profile"] = profile
	}
	profile["exit_type"] = "Normal"
	profile["exited_cleanly"] = true
	updated, err := json.Marshal(prefs)
	if err != nil {
		return
	}

	// Atomic replace: temp file + rename, both relative to Default/.
	_ = unix.Unlinkat(defFd, "Preferences.tmp", 0)
	outFd, err := unix.Openat(defFd, "Preferences.tmp", unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
	if err != nil {
		log.Printf("[browser] cleanCrashState: create temp: %v", err)
		return
	}
	out := os.NewFile(uintptr(outFd), "Preferences.tmp")
	_, werr := out.Write(updated)
	_ = out.Chown(id.uid, id.gid)
	out.Close()
	if werr != nil {
		_ = unix.Unlinkat(defFd, "Preferences.tmp", 0)
		return
	}
	if err := unix.Renameat(defFd, "Preferences.tmp", defFd, "Preferences"); err != nil {
		log.Printf("[browser] cleanCrashState: rename: %v", err)
	}
}

// xauthorityPath is where the display's cookie lives: the browser user's home,
// which is 0700 and outside /workspace.
func xauthorityPath(id browserIdentity, display int) string {
	return filepath.Join(id.home, fmt.Sprintf(".Xauthority-%d", display))
}
