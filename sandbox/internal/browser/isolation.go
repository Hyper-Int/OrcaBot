// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: browser-isolation-v5-profile-per-dashboard
package browser

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
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

const isolationRevision = "browser-isolation-v5-profile-per-dashboard"

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

func newXCookie() ([]byte, error) {
	cookie := make([]byte, 16)
	_, err := rand.Read(cookie)
	return cookie, err
}

// writeXauthority writes an MIT-MAGIC-COOKIE-1 entry for `display` (any host)
// to a 0600 file owned by the browser user, replacing it atomically. Xvfb is
// started with -auth on it, so only processes holding the cookie (the browser
// stack) can open the display — not agents injecting keystrokes into the
// browser window. The file lives in the browser user's home, so the temp file
// is created O_EXCL|O_NOFOLLOW: a symlink planted there is never followed.
func writeXauthority(path string, display int, cookie []byte, id browserIdentity) error {
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

	tmp := path + ".tmp"
	_ = os.Remove(tmp)
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	_, werr := f.Write(entry)
	cerr := f.Chown(id.uid, id.gid)
	f.Close()
	if werr != nil || cerr != nil {
		os.Remove(tmp)
		return errors.Join(werr, cerr)
	}
	return os.Rename(tmp, path)
}

// profilesDirName holds one Chromium profile per workspace in the browser
// user's home. Desktop runs one VM for every dashboard, each with its own
// workspace root (/workspace/<dashboardID>) and browser controller, so a single
// profile would let one dashboard's pages read another's cookies and storage.
// It used to be /workspace/.browser (see removeLegacyProfile), and briefly one
// shared <home>/profile (see sharedProfileDirName).
const profilesDirName = "profiles"

// sharedProfileDirName is the single profile every dashboard used to share;
// it is deleted rather than handed to any one of them.
const sharedProfileDirName = "profile"

func profilesPath(id browserIdentity) string {
	return filepath.Join(id.home, profilesDirName)
}

// profilePath is the profile for one workspace: a hash of its root, so the
// name is a fixed-length, path-safe component whatever the dashboard ID holds.
func profilePath(id browserIdentity, workspace string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(workspace)))
	return filepath.Join(profilesPath(id), hex.EncodeToString(sum[:16]))
}

// checkBrowserHome verifies the browser user's home is a place only that user
// (and root) can reach: a real directory owned by the browser user with no
// group/other bits, every parent a real, root-owned directory nobody else can
// write. The profile and the X cookie live there; if an agent
// could rename or replace any directory on the way, it could swap in its own
// profile (cookie theft, planted prefs/extensions) as it could under
// /workspace. Fails closed.
func checkBrowserHome(id browserIdentity) error {
	if id.home == "" || !filepath.IsAbs(id.home) {
		return fmt.Errorf("browser user home %q is not an absolute path", id.home)
	}
	home := filepath.Clean(id.home)
	fi, err := os.Lstat(home)
	if err != nil {
		return fmt.Errorf("browser user home: %w", err)
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || !fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("browser user home %s is not a directory", home)
	}
	if int(st.Uid) != id.uid || st.Mode&0o077 != 0 {
		return fmt.Errorf("browser user home %s must be owned by %s with mode 0700 (uid %d mode %o)", home, BrowserUser, st.Uid, st.Mode&0o7777)
	}
	for dir := filepath.Dir(home); ; dir = filepath.Dir(dir) {
		fi, err := os.Lstat(dir)
		if err != nil {
			return fmt.Errorf("browser user home parent: %w", err)
		}
		st, ok := fi.Sys().(*syscall.Stat_t)
		if !ok || !fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 || st.Uid != 0 || st.Mode&0o022 != 0 {
			return fmt.Errorf("browser user home parent %s must be a root-owned directory only root can write", dir)
		}
		if dir == "/" {
			return nil
		}
	}
}

// prepareProfileDir makes `path` (in the browser user's private home, see
// checkBrowserHome) a real directory owned by the browser user (0700) and
// clears Chromium's stale lock and crash state. Only root and the browser user
// can write the home, so the one party that could have planted a symlink or a
// foreign directory there is the browser itself; root still works through a
// directory fd opened with O_NOFOLLOW and moves anything that isn't a browser-
// or root-owned directory aside rather than adopting it. A root-owned
// directory can only be the one root just created.
func prepareProfileDir(path string, id browserIdentity) error {
	for attempt := 0; ; attempt++ {
		fd, err := openProfileDir(path)
		if err != nil {
			return err
		}
		var st unix.Stat_t
		if err := unix.Fstat(fd, &st); err != nil {
			unix.Close(fd)
			return err
		}
		if int(st.Uid) != id.uid && st.Uid != 0 {
			unix.Close(fd)
			why := fmt.Sprintf("owned by uid %d", st.Uid)
			if attempt > 0 {
				return fmt.Errorf("profile %s replaced while preparing it (%s)", path, why)
			}
			if err := moveAside(path, why); err != nil {
				return err
			}
			continue
		}
		err = finishProfileDir(fd, id)
		unix.Close(fd)
		return err
	}
}

// openProfileDir moves a non-directory (or symlink) at path aside, creates the
// directory if missing, and opens it without following symlinks.
func openProfileDir(path string) (int, error) {
	fi, err := os.Lstat(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return -1, err
	case fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir():
		if err := moveAside(path, fmt.Sprintf("not a directory (mode %v)", fi.Mode())); err != nil {
			return -1, err
		}
	}
	if err := unix.Mkdir(path, 0o700); err != nil && !errors.Is(err, unix.EEXIST) {
		return -1, fmt.Errorf("mkdir %s: %w", path, err)
	}
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, fmt.Errorf("open profile dir %s: %w", path, err)
	}
	return fd, nil
}

// moveAside renames path (whatever it is; rename never follows a symlink) out
// of the way so a fresh profile can be created.
func moveAside(path, why string) error {
	var suffix [4]byte
	_, _ = rand.Read(suffix[:])
	aside := fmt.Sprintf("%s.invalid-%d-%s", path, time.Now().Unix(), hex.EncodeToString(suffix[:]))
	log.Printf("[browser] SECURITY: %s is %s — moving it to %s", path, why, aside)
	if err := os.Rename(path, aside); err != nil {
		return fmt.Errorf("move aside %s: %w", path, err)
	}
	return nil
}

func finishProfileDir(fd int, id browserIdentity) error {
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

// readDirFd lists dirfd from the start. A dup shares the file offset, so it
// rewinds first.
func readDirFd(dirfd int) ([]os.DirEntry, error) {
	dup, err := unix.Dup(dirfd)
	if err != nil {
		return nil, err
	}
	d := os.NewFile(uintptr(dup), "")
	defer d.Close()
	if _, err := d.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	return d.ReadDir(-1)
}

// legacyProfileName is where the profile lived before it moved out of the
// workspace.
const legacyProfileName = ".browser"

// removeLegacyProfile deletes the old /workspace/.browser profile (cookies and
// sessions the browser no longer uses) rather than migrating it: adopting a
// tree from the agent-writable workspace is exactly the hand-over attack
// surface (planted dirs, hard links, fds held open) that moving the profile
// removes. Only a real directory owned by the browser user is removed, and
// only through fds opened with O_NOFOLLOW: its contents are writable by no one
// but the browser user, and it is unlinked from the workspace only if the
// entry still names the directory that was emptied. Anything else (an agent's
// directory or symlink renamed into place) is left alone.
func removeLegacyProfile(workspace string, id browserIdentity) error {
	wsfd, err := unix.Open(workspace, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(wsfd)
	fd, err := unix.Openat(wsfd, legacyProfileName, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if errors.Is(err, unix.ENOENT) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("open legacy profile: %w", err)
	}
	defer unix.Close(fd)
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return err
	}
	if int(st.Uid) != id.uid {
		return fmt.Errorf("legacy profile %s/%s is owned by uid %d, not %s; leaving it", workspace, legacyProfileName, st.Uid, BrowserUser)
	}
	if err := removeTreeAt(fd); err != nil {
		return err
	}
	var now unix.Stat_t
	if err := unix.Fstatat(wsfd, legacyProfileName, &now, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	if now.Dev != st.Dev || now.Ino != st.Ino {
		return fmt.Errorf("legacy profile replaced while removing it; leaving the new entry")
	}
	return unix.Unlinkat(wsfd, legacyProfileName, unix.AT_REMOVEDIR)
}

// removeTreeAt empties the directory dirfd without following symlinks.
func removeTreeAt(dirfd int) error {
	entries, err := readDirFd(dirfd)
	if err != nil {
		return err
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() {
			sub, err := unix.Openat(dirfd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
			err = removeTreeAt(sub)
			unix.Close(sub)
			if err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
			if err := unix.Unlinkat(dirfd, name, unix.AT_REMOVEDIR); err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
			continue
		}
		if err := unix.Unlinkat(dirfd, name, 0); err != nil && !errors.Is(err, unix.ENOENT) {
			return fmt.Errorf("%s: %w", name, err)
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

// xauthorityPath picks a fresh path for a display's cookie in the browser
// user's home, which is 0700 and outside /workspace. It is chosen before Xvfb
// picks the display, so it is random rather than named after it.
func xauthorityPath(id browserIdentity) (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return filepath.Join(id.home, ".Xauthority-"+hex.EncodeToString(b[:])), nil
}
