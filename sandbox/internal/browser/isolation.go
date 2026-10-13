// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: browser-isolation-v3-trusted-root-tree
package browser

import (
	"crypto/rand"
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

const isolationRevision = "browser-isolation-v3-trusted-root-tree"

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

// prepareProfileDir makes `path` a real directory owned by the browser user
// (0700) and clears Chromium's stale lock and crash state, without root ever
// following a symlink. The profile lives in /workspace, which every pool UID
// can write (group sandbox, no sticky bit), so an agent could replace
// `.browser` with a symlink or its own directory; every root operation here
// goes through a directory fd opened with O_NOFOLLOW instead of the path.
//
// Ownership decides what happens to an existing directory:
//   - browser user: used as is.
//   - root: a profile from before the browser ran unprivileged; handed over
//     (owner changed, group/other permission bits stripped throughout) — but
//     only if the whole tree is root-owned and nothing in it is group- or
//     world-writable (rootTreeTrusted). /workspace has no sticky bit, so an
//     agent can rename any root-owned directory it can write into `.browser`;
//     such a tree may hold agent-owned files, or root-owned ones the agent
//     still has open for writing, and handing it over would give the agent
//     the browser's profile. It is moved aside like a foreign one.
//   - anyone else: an agent planted it (possibly pre-seeded with hard links,
//     setgid dirs or group-writable files), so it is moved aside and a fresh
//     profile created. It is never handed over.
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
		var untrusted string
		switch int(st.Uid) {
		case id.uid:
		case 0:
			// Root-owned: a legacy profile, or the directory we just created.
			if err := rootTreeTrusted(fd, st, "."); err != nil {
				untrusted = err.Error()
				break
			}
			log.Printf("[browser] handing profile %s over to %s", path, BrowserUser)
			if err := handOverTree(fd, id); err != nil {
				unix.Close(fd)
				return fmt.Errorf("hand over profile: %w", err)
			}
		default:
			untrusted = fmt.Sprintf("owned by uid %d", st.Uid)
		}
		if untrusted != "" {
			unix.Close(fd)
			if attempt > 0 {
				return fmt.Errorf("profile %s replaced while preparing it (%s)", path, untrusted)
			}
			if err := moveAside(path, untrusted); err != nil {
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
// rewinds first: rootTreeTrusted and handOverTree read the same fds in turn.
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

// rootTreeTrusted checks a root-owned profile can be handed over: every entry
// is owned by root, and no directory or regular file is group- or
// world-writable (so no other user could have created entries in it or holds
// it open for writing). st is dirfd's own stat; name is for messages.
func rootTreeTrusted(dirfd int, st unix.Stat_t, name string) error {
	if st.Uid != 0 || st.Mode&0o022 != 0 {
		return fmt.Errorf("an untrusted legacy profile (%s: uid %d mode %o)", name, st.Uid, st.Mode&0o7777)
	}
	entries, err := readDirFd(dirfd)
	if err != nil {
		return err
	}
	for _, e := range entries {
		child := name + "/" + e.Name()
		if e.IsDir() {
			sub, err := unix.Openat(dirfd, e.Name(), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if err != nil {
				return fmt.Errorf("an unreadable legacy profile (%s: %v)", child, err)
			}
			var sst unix.Stat_t
			err = unix.Fstat(sub, &sst)
			if err == nil {
				err = rootTreeTrusted(sub, sst, child)
			}
			unix.Close(sub)
			if err != nil {
				return err
			}
			continue
		}
		var est unix.Stat_t
		if err := unix.Fstatat(dirfd, e.Name(), &est, unix.AT_SYMLINK_NOFOLLOW); err != nil {
			return fmt.Errorf("an unreadable legacy profile (%s: %v)", child, err)
		}
		writable := est.Mode&unix.S_IFMT == unix.S_IFREG && est.Mode&0o022 != 0
		if est.Uid != 0 || writable {
			return fmt.Errorf("an untrusted legacy profile (%s: uid %d mode %o)", child, est.Uid, est.Mode&0o7777)
		}
	}
	return nil
}

// handOverTree recursively gives every entry under dirfd to the browser user
// and strips group/other (and setuid/setgid/sticky) bits, never following
// symlinks: directories and regular files are changed through an fd opened
// with O_NOFOLLOW, symlinks only have their own owner changed. A regular file
// with more than one link is unlinked from the profile instead — chowning it
// would also hand over whatever other path shares the inode, and leaving it
// root-owned would leave Chromium unable to write it.
func handOverTree(dirfd int, id browserIdentity) error {
	entries, err := readDirFd(dirfd)
	if err != nil {
		return err
	}
	for _, e := range entries {
		name := e.Name()
		switch {
		case e.Type()&os.ModeSymlink != 0:
			if err := unix.Fchownat(dirfd, name, id.uid, id.gid, unix.AT_SYMLINK_NOFOLLOW); err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
		case e.IsDir():
			sub, err := unix.Openat(dirfd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
			err = handOverTree(sub, id)
			if err == nil {
				err = handOverFd(sub, name, id)
			}
			unix.Close(sub)
			if err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
		case e.Type().IsRegular():
			f, err := unix.Openat(dirfd, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
			if err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
			var st unix.Stat_t
			if err = unix.Fstat(f, &st); err == nil && st.Nlink > 1 {
				unix.Close(f)
				log.Printf("[browser] SECURITY: unlinking %s from profile during handover: %d hard links", name, st.Nlink)
				if err := unix.Unlinkat(dirfd, name, 0); err != nil {
					return fmt.Errorf("%s: %w", name, err)
				}
				continue
			}
			if err == nil {
				err = handOverFd(f, name, id)
			}
			unix.Close(f)
			if err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
		default:
			// Sockets, FIFOs, devices: nothing Chromium needs to keep, and
			// opening a device to fchmod it could have side effects.
			log.Printf("[browser] removing special file %s from profile during handover", name)
			if err := unix.Unlinkat(dirfd, name, 0); err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
		}
	}
	return nil
}

// handOverFd chowns an open file or directory to the browser user and keeps
// only the owner permission bits.
func handOverFd(fd int, name string, id browserIdentity) error {
	var st unix.Stat_t
	if err := unix.Fstat(fd, &st); err != nil {
		return err
	}
	if err := unix.Fchown(fd, id.uid, id.gid); err != nil {
		return err
	}
	return unix.Fchmod(fd, uint32(st.Mode)&0o700)
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
