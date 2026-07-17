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

// safeWrite writes content to the file named by rel (a slice of already
// lexically-validated, non-empty, non-"."/".." path components) under root.
//
// It walks EVERY path component — intermediate directories and the final file —
// with openat + O_NOFOLLOW relative to the workspace-root file descriptor, so no
// component can be a symlink, even one a process sharing the workspace races in
// between validation and write (TOCTOU). Containment is enforced by the kernel
// at open time rather than by re-checking a string path, which is what makes the
// race unwinnable: there is never a moment where a validated string path is
// re-opened by name (the only way a swapped-in symlink could be followed).
//
// A symlink at any directory component makes openat fail with ELOOP, which we
// surface as ErrPathTraversal (mirroring the pre-existing symlink-escape error
// semantics). The final file is written to a fresh temp name in the final
// directory fd and atomically moved into place with renameat — preserving the
// existing atomic-rename behavior (a reader never sees a half-written file, and
// rename replaces the dir entry without opening a destination that another
// process may be holding open over virtiofs). renameat replaces the destination
// name itself even if it is a symlink, so it never writes *through* a symlink to
// an external target.
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

	// Walk/create each directory component relative to the current fd. mkdirat
	// creates the name in dirfd (it does not follow a symlink), and the openat
	// with O_NOFOLLOW rejects a symlink component (ELOOP) — so a symlink raced
	// into the path can never redirect the walk out of the workspace.
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

	// dirfd now refers to the final directory, reached without traversing any
	// symlink. Write atomically within it.
	return atomicWriteAt(dirfd, fileName, content)
}

// atomicWriteAt writes content to name inside the directory referred to by
// dirfd, atomically: a fresh temp file (created relative to dirfd, O_EXCL +
// O_NOFOLLOW) receives the content, then renameat swaps it into place. All
// operations are relative to dirfd — never by absolute path — so they cannot be
// redirected by a symlink swapped in elsewhere in the tree.
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

// classifyComponentErr turns an openat failure on a directory component into a
// stable error type. Linux reports ELOOP when O_NOFOLLOW refuses a symlink;
// darwin reports ENOTDIR instead (O_DIRECTORY is evaluated first on a non-dir
// symlink). To classify portably we lstat the component: a symlink maps to
// ErrPathTraversal, anything else keeps the original error. The lstat is used
// ONLY for error classification — the O_NOFOLLOW open above is the real security
// gate and has already failed closed, so a race on the lstat cannot let a write
// through.
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
