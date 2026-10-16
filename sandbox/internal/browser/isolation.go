// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: browser-isolation-v8-error-codes
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
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const isolationRevision = "browser-isolation-v8-error-codes"

func init() {
	log.Printf("[browser] REVISION: %s loaded at %s", isolationRevision, time.Now().Format(time.RFC3339))
}

// Chromium runs as this unprivileged user (docker/Dockerfile), never root; the
// display side of the stack runs as VNCUser. Chromium needs --no-sandbox in the VM, so a root Chromium with a
// DevTools port reachable over loopback let any agent read and write files as
// root (file:// pages, Browser.setDownloadBehavior). As this user, CDP access
// is worth no more than the browser itself.
const BrowserUser = "orcabot-browser"

// VNCUser runs the display side of the stack (Xvfb, x11vnc, websockify), so
// Chromium does not. Chromium runs whatever pages load, and page JavaScript
// (or an agent's browser_evaluate) can fetch or navigate to any loopback port
// its user can connect to: as one user, dashboard A's page could open
// dashboard B's unauthenticated websockify/noVNC (view and drive its screen)
// on desktop, where one VM runs every dashboard's browser. With the split,
// iptables rejects every connection from BrowserUser to the browser port range
// (setupBrowserUserPortBlock, cmd/server/egress_linux.go): Chromium only
// listens there (DevTools) and never connects; websockify (this user) is the
// one client of x11vnc. Not in the sandbox group, like BrowserUser.
const VNCUser = "orcabot-vnc"

// Ports for x11vnc, websockify and Chromium's DevTools come from this range so
// iptables can block pool UIDs from all of them (cmd/server/egress_linux.go).
const (
	PortRangeStart = 6100
	PortRangeEnd   = 6299
)

type browserIdentity struct {
	uid, gid int
	home     string
	name     string // user name; empty in tests that build an identity by hand
}

// lookupBrowserIdentity is the Chromium user.
func lookupBrowserIdentity() (browserIdentity, error) {
	return lооkupStackIdentity(BrowserUser)
}

// lookupVNCIdentity is the Xvfb / x11vnc / websockify user.
func lookupVNCIdentity() (browserIdentity, error) {
	return lооkupStackIdentity(VNCUser)
}

func lооkupStackIdentity(name string) (browserIdentity, error) {
	u, err := user.Lookup(name)
	if err != nil {
		return browserIdentity{}, fmt.Errorf("browser user %q missing (rebuild the sandbox image): %w", name, err)
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
		return browserIdentity{}, fmt.Errorf("browser user %q must not be root", name)
	}
	return browserIdentity{uid: uid, gid: gid, home: u.HomeDir, name: name}, nil
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
		"USER=" + id.userName(),
		"DISPLAY=" + display,
		"XAUTHORITY=" + xauthority,
		"LANG=C.UTF-8",
	}
}

func (id browserIdentity) userName() string {
	if id.name == "" {
		return BrowserUser
	}
	return id.name
}

// Ports handed out by freePortInRange stay reserved process-wide until the
// stack that owns them stops (releasePorts). The probe below closes its
// listener before the browser process binds the port, so without this two
// concurrent Starts (two dashboards on desktop) could pick the same port and
// one controller would end up driving the other's Chromium: DialBrowser only
// checks the listener belongs to the browser user, and both stacks do.
var (
	portReserveMu sync.Mutex
	reservedPorts = map[int]struct{}{}
)

// freePortInRange reserves a free 127.0.0.1 port in [PortRangeStart,
// PortRangeEnd] that no other controller holds, skipping ports already chosen
// for this start. The caller must releasePorts it when the stack stops or its
// start fails.
func freePortInRange(skip ...int) (int, error) {
	portReserveMu.Lock()
	defer portReserveMu.Unlock()
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
		if _, held := reservedPorts[port]; taken || held {
			continue
		}
		l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			continue
		}
		_ = l.Close()
		reservedPorts[port] = struct{}{}
		return port, nil
	}
	return 0, fmt.Errorf("no free port in %d-%d", PortRangeStart, PortRangeEnd)
}

// releasePorts returns ports to the pool (zero and unreserved ports are ignored).
func releasePorts(ports ...int) {
	portReserveMu.Lock()
	defer portReserveMu.Unlock()
	for _, p := range ports {
		delete(reservedPorts, p)
	}
}

// reserveBrowserPorts reserves the websockify, x11vnc and DevTools ports,
// releasing any it got if it can't get all three.
func rеserveBrowserPorts() (wsPort, vncPort, debugPort int, err error) {
	if wsPort, err = freePortInRange(); err != nil {
		return 0, 0, 0, err
	}
	if vncPort, err = freePortInRange(wsPort); err != nil {
		releasePorts(wsPort)
		return 0, 0, 0, err
	}
	if debugPort, err = freePortInRange(wsPort, vncPort); err != nil {
		releasePorts(wsPort, vncPort)
		return 0, 0, 0, err
	}
	return wsPort, vncPort, debugPort, nil
}

func nеwXCookie() ([]byte, error) {
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
	return filepath.Join(profilesPath(id), profileName(workspace))
}

func profileName(workspace string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(workspace)))
	return hex.EncodeToString(sum[:16])
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
		return fmt.Errorf("browser user home %s must be owned by %s with mode 0700 (uid %d mode %o)", home, id.userName(), st.Uid, st.Mode&0o7777)
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

// prepareProfile makes the workspace's profile ready for Chromium and returns
// its path. Every step works through directory fds: the home is opened by
// walking each component from / with O_NOFOLLOW|O_DIRECTORY, and profiles/
// and the profile itself are created, checked and adopted relative to their
// parent's fd. Swapping profiles/ for a symlink between steps therefore can't
// make root mkdir or chown anywhere else.
func prepareProfile(id browserIdentity, workspace string) (string, error) {
	homeFd, err := openDirNoFollow(id.home)
	if err != nil {
		return "", fmt.Errorf("browser home: %w", err)
	}
	defer unix.Close(homeFd)
	profilesFd, err := prepareDirAt(homeFd, profilesDirName, profilesPath(id), id)
	if err != nil {
		return "", err
	}
	defer unix.Close(profilesFd)
	path := profilePath(id, workspace)
	fd, err := prepareDirAt(profilesFd, profileName(workspace), path, id)
	if err != nil {
		return "", err
	}
	defer unix.Close(fd)
	if err := finishProfileDir(fd, id); err != nil {
		return "", fmt.Errorf("profile %s: %w", path, err)
	}
	return path, nil
}

// prepareProfileDir prepares the profile at an absolute path (tests, and any
// caller outside prepareProfile): its parent is reached with openDirNoFollow.
func prepareProfileDir(path string, id browserIdentity) error {
	parentFd, err := openDirNoFollow(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer unix.Close(parentFd)
	fd, err := prepareDirAt(parentFd, filepath.Base(path), path, id)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	return finishProfileDir(fd, id)
}

// openDirNoFollow opens an absolute directory path component by component
// from /, each with O_NOFOLLOW|O_DIRECTORY, so a symlink anywhere on the path
// fails the open instead of being followed.
func openDirNoFollow(path string) (int, error) {
	if !filepath.IsAbs(path) {
		return -1, fmt.Errorf("%s is not an absolute path", path)
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	for _, comp := range strings.Split(filepath.Clean(path), "/") {
		if comp == "" {
			continue
		}
		next, err := unix.Openat(fd, comp, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(fd)
		if err != nil {
			return -1, fmt.Errorf("open %s (at %q): %w", path, comp, err)
		}
		fd = next
	}
	return fd, nil
}

// prepareDirAt makes name (in parentFd, inside the browser user's private
// home, see checkBrowserHome) a real directory owned by the browser user
// (0700) and returns an fd for it. Only root and the browser user can write
// the home, so the one party that could have planted a symlink or a foreign
// directory there is the browser itself; root still works only through fds
// opened with O_NOFOLLOW and moves anything that isn't a browser- or
// root-owned directory aside rather than adopting it. A root-owned directory
// can only be the one root just created. display is the full path, for logs.
func prepareDirAt(parentFd int, name, display string, id browserIdentity) (int, error) {
	for attempt := 0; ; attempt++ {
		fd, err := openProfileDirAt(parentFd, name, display)
		if err != nil {
			return -1, err
		}
		var st unix.Stat_t
		if err := unix.Fstat(fd, &st); err != nil {
			unix.Close(fd)
			return -1, err
		}
		if int(st.Uid) != id.uid && st.Uid != 0 {
			unix.Close(fd)
			why := fmt.Sprintf("owned by uid %d", st.Uid)
			if attempt > 0 {
				return -1, fmt.Errorf("profile %s replaced while preparing it (%s)", display, why)
			}
			if err := moveAsideAt(parentFd, name, display, why); err != nil {
				return -1, err
			}
			continue
		}
		if err := unix.Fchown(fd, id.uid, id.gid); err != nil {
			unix.Close(fd)
			return -1, err
		}
		if err := unix.Fchmod(fd, 0o700); err != nil {
			unix.Close(fd)
			return -1, err
		}
		return fd, nil
	}
}

// openProfileDirAt moves a non-directory (or symlink) named name in parentFd
// aside, creates the directory if missing, and opens it without following
// symlinks — all relative to parentFd.
func openProfileDirAt(parentFd int, name, display string) (int, error) {
	var st unix.Stat_t
	err := unix.Fstatat(parentFd, name, &st, unix.AT_SYMLINK_NOFOLLOW)
	switch {
	case errors.Is(err, unix.ENOENT):
	case err != nil:
		return -1, fmt.Errorf("stat %s: %w", display, err)
	case st.Mode&unix.S_IFMT != unix.S_IFDIR:
		if err := moveAsideAt(parentFd, name, display, fmt.Sprintf("not a directory (mode %o)", st.Mode)); err != nil {
			return -1, err
		}
	}
	if err := unix.Mkdirat(parentFd, name, 0o700); err != nil && !errors.Is(err, unix.EEXIST) {
		return -1, fmt.Errorf("mkdir %s: %w", display, err)
	}
	fd, err := unix.Openat(parentFd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, fmt.Errorf("open profile dir %s: %w", display, err)
	}
	return fd, nil
}

// moveAsideAt renames name in parentFd (whatever it is; rename never follows a
// symlink) out of the way so a fresh profile can be created.
func moveAsideAt(parentFd int, name, display, why string) error {
	var suffix [4]byte
	_, _ = rand.Read(suffix[:])
	aside := fmt.Sprintf("%s.invalid-%d-%s", name, time.Now().Unix(), hex.EncodeToString(suffix[:]))
	log.Printf("[browser] SECURITY: %s is %s — moving it to %s", display, why, filepath.Join(filepath.Dir(display), aside))
	if err := unix.Renameat(parentFd, name, parentFd, aside); err != nil {
		return fmt.Errorf("move aside %s: %w", display, err)
	}
	return nil
}

// singletonFiles are Chromium's profile lock: SingletonLock is a symlink to
// "<hostname>-<pid>" of the Chromium that has the profile open.
var singletonFiles = []string{"SingletonLock", "SingletonSocket", "SingletonCookie"}

// errProfileInUse: a live Chromium still holds the profile. Its lock files are
// left alone — removing them let a second Chromium open the same profile and
// corrupt it.
var errProfileInUse = errors.New("browser profile is in use by another Chromium")

// procRoot is /proc; a var so tests can fake process state.
var procRoot = "/proc"

// finishProfileDir clears a stale profile lock and crash state. A lock that
// names a live Chromium of the browser user on this host is not stale: it is
// another browser on this profile (one left behind by an earlier server, say),
// and starting a second one on it would corrupt the profile, so it fails.
func finishProfileDir(fd int, id browserIdentity) error {
	if pid := livеSingletonPid(fd, id); pid > 0 {
		return fmt.Errorf("%w (pid %d)", errProfileInUse, pid)
	}
	for _, name := range singletonFiles {
		_ = unix.Unlinkat(fd, name, 0)
	}
	clеanCrashStateAt(fd, id)
	return nil
}

// liveSingletonPid returns the pid SingletonLock names if that process is
// alive on this host, runs as the browser user and is a Chromium; else 0.
func livеSingletonPid(fd int, id browserIdentity) int {
	buf := make([]byte, 256)
	n, err := unix.Readlinkat(fd, "SingletonLock", buf)
	if err != nil || n <= 0 || n >= len(buf) {
		return 0
	}
	target := string(buf[:n])
	i := strings.LastIndexByte(target, '-')
	if i <= 0 {
		return 0
	}
	pid, err := strconv.Atoi(target[i+1:])
	if err != nil || pid <= 0 {
		return 0
	}
	if host, err := os.Hostname(); err == nil && host != target[:i] {
		return 0 // another machine's lock (e.g. from an image build)
	}
	if !isBrowserChromium(pid, id.uid) {
		return 0
	}
	return pid
}

// isBrowserChromium reports whether pid is a live process running as uid
// whose name starts with "chrom". /proc/<pid>/status is world-readable (unlike
// /proc/<pid>/fd, which needs CAP_SYS_PTRACE the container doesn't have).
func isBrowserChromium(pid, uid int) bool {
	data, err := os.ReadFile(filepath.Join(procRoot, strconv.Itoa(pid), "status"))
	if err != nil {
		return false
	}
	var name string
	ruid := -1
	for _, line := range strings.Split(string(data), "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		switch k {
		case "Name":
			name = v
		case "State":
			if strings.HasPrefix(v, "Z") || strings.HasPrefix(v, "X") {
				return false // exited, not yet reaped
			}
		case "Uid":
			if f := strings.Fields(v); len(f) > 0 {
				ruid, _ = strconv.Atoi(f[0])
			}
		}
	}
	return ruid == uid && strings.HasPrefix(name, "chrom")
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
	if err := rеmoveTreeAt(fd); err != nil {
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
func rеmoveTreeAt(dirfd int) error {
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
			err = rеmoveTreeAt(sub)
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
func clеanCrashStateAt(profileFd int, id browserIdentity) {
	defFd, err := unix.Openat(profileFd, "Default", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return // fresh profile
	}
	defer unix.Close(defFd)

	data, err := readPrefsAt(defFd)
	if err != nil {
		if !errors.Is(err, unix.ENOENT) {
			log.Printf("[browser] cleanCrashState: %v", err)
		}
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

// maxPrefsSize caps how much of Preferences root reads.
const maxPrefsSize = 16 << 20

// readPrefsAt reads Default/Preferences, which the browser user controls. It
// is opened O_NONBLOCK so a FIFO planted there can't hang Start (which holds
// the controller lock), and only a regular file within maxPrefsSize is read.
func readPrefsAt(defFd int) ([]byte, error) {
	inFd, err := unix.Openat(defFd, "Preferences", unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	var st unix.Stat_t
	if err := unix.Fstat(inFd, &st); err != nil {
		unix.Close(inFd)
		return nil, err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG {
		unix.Close(inFd)
		return nil, fmt.Errorf("Preferences is not a regular file (mode %o)", st.Mode)
	}
	if st.Size > maxPrefsSize {
		unix.Close(inFd)
		return nil, fmt.Errorf("Preferences is too large (%d bytes)", st.Size)
	}
	in := os.NewFile(uintptr(inFd), "Preferences")
	defer in.Close()
	return io.ReadAll(io.LimitReader(in, maxPrefsSize))
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
