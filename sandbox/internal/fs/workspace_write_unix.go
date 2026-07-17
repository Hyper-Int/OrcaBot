// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: workspace-v4-openat-nofollow-write-walk

//go:build unix

package fs

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"os"

	"golang.org/x/sys/unix"
)

// safeWrite writes content to rel (already-validated plain path components) under
// root, walking every component with openat + O_NOFOLLOW relative to the root fd —
// so a symlink component (even one raced in after validation) fails the open with
// ELOOP (surfaced as ErrPathTraversal), making the TOCTOU unwinnable. The final
// file is written to a temp name and renameat'd into place (atomic; never writes
// through a symlink).
func safeWrite(root string, rel []string, content []byte) error {
	// Open the trusted (already-canonicalized) workspace root as a directory fd.
	dirfd, err := unix.Open(root, unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	// dirfd advances down the tree; ensure the fd we currently hold is closed.
	defer func() {
		if dirfd >= 0 {
			unix.Close(dirfd)
		}
	}()

	fileName := rel[len(rel)-1]
	dirs := rel[:len(rel)-1]

	// Create + open each dir component relative to the current fd; O_NOFOLLOW
	// rejects a symlink component so the walk can't leave the workspace.
	for _, comp := range dirs {
		if err := unix.Mkdirat(dirfd, comp, 0755); err != nil && !errors.Is(err, unix.EEXIST) {
			return err
		}
		next, oerr := unix.Openat(dirfd, comp, unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if oerr != nil {
			// Classify the failure while the parent fd is still open, then close.
			cerr := classifyComponentErr(dirfd, comp, oerr)
			unix.Close(dirfd)
			dirfd = -1 // already closed; stop the deferred double-close
			return cerr
		}
		unix.Close(dirfd) // done with the parent; advance
		dirfd = next
	}

	// dirfd is the final directory, reached without traversing a symlink.
	return atomicWriteAt(dirfd, fileName, content)
}

// atomicWriteAt writes content to name inside dirfd atomically: a temp file
// (O_EXCL + O_NOFOLLOW, relative to dirfd) then renameat into place.
func atomicWriteAt(dirfd int, name string, content []byte) error {
	var tmpName string
	var tmpFd int
	for attempt := 0; ; attempt++ {
		tmpName = fmt.Sprintf(".orcawrite-%d-%x.tmp", os.Getpid(), rand.Uint64())
		fd, err := unix.Openat(dirfd, tmpName,
			unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0644)
		if err == nil {
			tmpFd = fd
			break
		}
		if errors.Is(err, unix.EEXIST) && attempt < 100 {
			continue // name collision, retry with a new random suffix
		}
		return err
	}

	f := os.NewFile(uintptr(tmpFd), tmpName)
	if _, err := f.Write(content); err != nil {
		f.Close()
		unix.Unlinkat(dirfd, tmpName, 0)
		return err
	}
	if err := f.Close(); err != nil {
		unix.Unlinkat(dirfd, tmpName, 0)
		return err
	}

	if err := unix.Renameat(dirfd, tmpName, dirfd, name); err != nil {
		unix.Unlinkat(dirfd, tmpName, 0)
		return mapWalkErr(err)
	}
	return nil
}

// mapWalkErr translates a kernel ELOOP (a component was a symlink, refused by
// O_NOFOLLOW) into the workspace's ErrPathTraversal so callers get a stable
// error type regardless of whether the symlink was static or raced in.
func mapWalkErr(err error) error {
	if errors.Is(err, unix.ELOOP) {
		return ErrPathTraversal
	}
	return err
}

// classifyComponentErr maps an openat failure on a symlink component to
// ErrPathTraversal. O_NOFOLLOW reports ELOOP on Linux, ENOTDIR on darwin, so we
// lstat to tell portably. The lstat only picks the error type — the O_NOFOLLOW
// open above is the real gate and has already failed closed.
func classifyComponentErr(dirfd int, comp string, err error) error {
	if errors.Is(err, unix.ELOOP) {
		return ErrPathTraversal
	}
	var st unix.Stat_t
	if serr := unix.Fstatat(dirfd, comp, &st, unix.AT_SYMLINK_NOFOLLOW); serr == nil {
		if st.Mode&unix.S_IFMT == unix.S_IFLNK {
			return ErrPathTraversal
		}
	}
	return err
}
