// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: workspace-v4-openat-nofollow-write-walk

//go:build !unix

package fs

import (
	"os"
	"path/filepath"
)

// safeWrite is the non-Unix fallback. It cannot use openat + O_NOFOLLOW, so it
// falls back to the historical path-based create-dirs + atomic temp-file+rename
// behavior. The sandbox only ships on Linux (VM) and macOS (host tooling), both
// of which use the hardened Unix implementation; this exists only so the package
// keeps compiling on other platforms.
func safeWrite(root string, rel []string, content []byte) error {
	full := root
	for _, c := range rel {
		full = filepath.Join(full, c)
	}
	dir := filepath.Dir(full)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".orcawrite-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(content); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Chmod(tmpName, 0644); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, full); err != nil {
		os.Remove(tmpName)
		return err
	}
	return nil
}
