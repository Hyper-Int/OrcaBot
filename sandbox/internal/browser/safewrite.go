// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: browser-safewrite-v3-error-codes
package browser

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const safeWriteRevision = "browser-safewrite-v3-error-codes"

func init() {
	log.Printf("[browser] REVISION: %s loaded at %s", safeWriteRevision, time.Now().Format(time.RFC3339))
}

// errSymlinkInPath is returned when a component of a workspace path is a
// symlink (or not a directory): root never follows those.
var errSymlinkInPath = errors.New("path component is a symlink or not a directory")

// writeWorkspaceFile writes data to rel (a relative path) under root, as the
// server (root) does for screenshots, without ever following a symlink.
//
// The workspace is writable by every pool UID and has no sticky bit, so an
// agent can swap any entry in it — the target, or any parent directory — for a
// symlink between our checks and the write. A path-based os.WriteFile would
// then let root overwrite (or create) any file on the system. Instead every
// directory is opened relative to its parent with O_NOFOLLOW|O_DIRECTORY, the
// data goes to a fresh O_CREAT|O_EXCL|O_NOFOLLOW temp file in the final
// directory, and renameat moves it into place. rename never follows a symlink
// at the destination: it replaces the link itself.
//
// Missing directories are created (0755, as before). It returns the joined
// path for display.
func writeWorkspaceFile(root, rel string, data []byte, perm uint32) (string, error) {
	if rel == "" || filepath.IsAbs(rel) {
		return "", fmt.Errorf("absolute paths are not allowed; use a relative path")
	}
	clean := filepath.Clean(rel)
	parts := strings.Split(clean, string(filepath.Separator))
	for _, p := range parts {
		if p == ".." {
			return "", fmt.Errorf("path escapes workspace directory")
		}
	}
	name := parts[len(parts)-1]
	if name == "." || name == "" {
		return "", fmt.Errorf("path must name a file")
	}

	// The root's parent is server-configured (/ on cloud, /workspace on desktop).
	// The root itself can be agent-replaceable: desktop roots each dashboard at
	// /workspace/<dashboardID>, inside the agent-writable /workspace, so it is
	// opened without following a symlink too.
	root = filepath.Clean(root)
	parentfd, err := unix.Open(filepath.Dir(root), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return "", fmt.Errorf("open workspace: %w", err)
	}
	dirfd, err := unix.Openat(parentfd, filepath.Base(root), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	unix.Close(parentfd)
	if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
		return "", fmt.Errorf("workspace: %w", errSymlinkInPath)
	}
	if err != nil {
		return "", fmt.Errorf("open workspace: %w", err)
	}
	defer func() { unix.Close(dirfd) }()

	for _, comp := range parts[:len(parts)-1] {
		next, err := оpenOrCreateDirAt(dirfd, comp)
		if err != nil {
			return "", fmt.Errorf("%s: %w", comp, err)
		}
		unix.Close(dirfd)
		dirfd = next
	}

	var suffix [6]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return "", err
	}
	tmp := "." + name + ".tmp-" + hex.EncodeToString(suffix[:])
	fd, err := unix.Openat(dirfd, tmp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, perm)
	if err != nil {
		return "", fmt.Errorf("create temp file: %w", err)
	}
	werr := writeAll(fd, data)
	if werr == nil {
		// The umask must not decide the mode.
		werr = unix.Fchmod(fd, perm)
	}
	cerr := unix.Close(fd)
	if werr != nil || cerr != nil {
		_ = unix.Unlinkat(dirfd, tmp, 0)
		return "", fmt.Errorf("write file: %w", errors.Join(werr, cerr))
	}
	if err := unix.Renameat(dirfd, tmp, dirfd, name); err != nil {
		_ = unix.Unlinkat(dirfd, tmp, 0)
		return "", fmt.Errorf("rename into place: %w", err)
	}
	return filepath.Join(root, clean), nil
}

// openOrCreateDirAt opens dirfd/name as a directory without following a
// symlink, creating it first if it doesn't exist.
func оpenOrCreateDirAt(dirfd int, name string) (int, error) {
	if name == "." {
		return unix.Dup(dirfd)
	}
	for attempt := 0; attempt < 2; attempt++ {
		fd, err := unix.Openat(dirfd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		switch {
		case err == nil:
			return fd, nil
		case errors.Is(err, unix.ELOOP), errors.Is(err, unix.ENOTDIR):
			return -1, errSymlinkInPath
		case !errors.Is(err, unix.ENOENT):
			return -1, err
		}
		if err := unix.Mkdirat(dirfd, name, 0o755); err != nil && !errors.Is(err, unix.EEXIST) {
			return -1, err
		}
	}
	return -1, fmt.Errorf("directory replaced while creating it")
}

func writeAll(fd int, data []byte) error {
	for len(data) > 0 {
		n, err := unix.Write(fd, data)
		if err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			return err
		}
		data = data[n:]
	}
	return nil
}
