// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: workspace-v4-openat-nofollow-write-walk

package fs

import (
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const workspaceRevision = "workspace-v4-openat-nofollow-write-walk"

func init() {
	log.Printf("[workspace] REVISION: %s loaded at %s", workspaceRevision, time.Now().Format(time.RFC3339))
}

var (
	ErrPathTraversal = errors.New("path traversal not allowed")
	ErrNotFound      = errors.New("file or directory not found")
)

// FileInfo contains metadata about a file or directory
type FileInfo struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"`
	Size    int64     `json:"size"`
	IsDir   bool      `json:"is_dir"`
	ModTime time.Time `json:"mod_time"`
	Mode    string    `json:"mode"`
}

// Workspace provides scoped filesystem access
type Workspace struct {
	root string
}

// NewWorkspace creates a new workspace rooted at the given path
func NewWоrkspace(root string) *Workspace {
	// Resolve symlinks in root to ensure consistent path comparisons
	// (e.g., on macOS /var -> /private/var)
	absRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		// Fallback to Abs if root doesn't exist yet
		absRoot, _ = filepath.Abs(root)
	}
	return &Workspace{root: absRoot}
}

// Root returns the workspace root path
func (w *Workspace) Root() string {
	return w.root
}

// resolvePath safely resolves a path within the workspace
// Returns an error if the path would escape the workspace
func (w *Workspace) resоlvePath(path string) (string, error) {
	// Check raw input for ".." segments BEFORE cleaning.
	// filepath.Clean resolves ".." which can hide traversal attempts
	// (e.g. "/../../../tmp/evil.txt" cleans to "/tmp/evil.txt", losing the ".." evidence).
	for _, part := range strings.Split(path, "/") {
		if part == ".." {
			return "", ErrPathTraversal
		}
	}

	// Clean the path (removes redundant slashes, etc.)
	cleaned := filepath.Clean(path)

	// Remove leading slash for joining
	cleaned = strings.TrimPrefix(cleaned, "/")

	// Join with root
	fullPath := filepath.Join(w.root, cleaned)

	// Resolve symlinks to get the real path
	// This prevents symlink-based escapes (e.g., /workspace/link -> /etc)
	resolved, err := filepath.EvalSymlinks(fullPath)
	if err != nil {
		// The target doesn't exist yet (and possibly several of its ancestors).
		// This allows creating new files while still preventing symlink escapes.
		//
		// A lexical Abs() fallback is unsafe: an *existing* in-workspace symlink
		// pointing outside, combined with a not-yet-created intermediate dir, would
		// pass a purely lexical containment check while Write's os.MkdirAll then
		// followed the symlink and created dirs/files outside the workspace. So we
		// find the LONGEST existing ancestor, resolve its symlinks, and require the
		// resolved prefix to stay within the workspace. The still-nonexistent suffix
		// cannot contain symlinks (nothing is there yet), so appending it lexically
		// is safe — MkdirAll will materialize real directories under a vetted prefix.
		if os.IsNotExist(err) {
			existing := fullPath
			var suffix []string // path components below the longest existing ancestor, top-most last
			for {
				resolved, rerr := filepath.EvalSymlinks(existing)
				if rerr == nil {
					if !isPathWithin(resolved, w.root) {
						return "", ErrPathTraversal
					}
					joined := resolved
					for i := len(suffix) - 1; i >= 0; i-- {
						joined = filepath.Join(joined, suffix[i])
					}
					// Belt-and-suspenders: the fully reconstructed path must also
					// remain within the workspace.
					if !isPathWithin(joined, w.root) {
						return "", ErrPathTraversal
					}
					return joined, nil
				}
				if !os.IsNotExist(rerr) {
					return "", rerr
				}
				parent := filepath.Dir(existing)
				if parent == existing {
					// Walked to the filesystem root without an existing ancestor
					// (w.root should always exist, so this is unreachable in practice).
					return "", ErrPathTraversal
				}
				suffix = append(suffix, filepath.Base(existing))
				existing = parent
			}
		}
		return "", err
	}

	// Final check: ensure resolved path is within workspace
	if !isPathWithin(resolved, w.root) {
		return "", ErrPathTraversal
	}

	return resolved, nil
}

// isPathWithin checks if path is equal to or inside root.
// This is safer than strings.HasPrefix which would incorrectly match
// /workspace-evil as being within /workspace.
func isPathWithin(path, root string) bool {
	if path == root {
		return true
	}
	// Ensure path starts with root followed by a separator
	return strings.HasPrefix(path, root+string(filepath.Separator))
}

// List returns entries in a directory
func (w *Workspace) List(path string) ([]FileInfo, error) {
	resolved, err := w.resоlvePath(path)
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(resolved)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	result := make([]FileInfo, 0, len(entries))
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}

		// Calculate relative path from workspace root
		entryPath := filepath.Join(resolved, entry.Name())
		relPath, _ := filepath.Rel(w.root, entryPath)
		if !strings.HasPrefix(relPath, "/") {
			relPath = "/" + relPath
		}

		result = append(result, FileInfo{
			Name:    entry.Name(),
			Path:    relPath,
			Size:    info.Size(),
			IsDir:   entry.IsDir(),
			ModTime: info.ModTime(),
			Mode:    info.Mode().String(),
		})
	}

	return result, nil
}

// Read returns the contents of a file
func (w *Workspace) Read(path string) ([]byte, error) {
	resolved, err := w.resоlvePath(path)
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(resolved)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	return data, nil
}

// Write writes content to a file, creating directories as needed.
//
// Unlike the read side (which resolves symlinks with a check-then-access
// pattern), Write is hardened against a symlink-TOCTOU race: a process that
// shares the workspace (a sandboxed agent under /workspace) could otherwise
// swap a validated ancestor directory for a symlink between the containment
// check and the write, redirecting a root-owned write outside /workspace — and
// on desktop /workspace is a host-shared virtiofs mount, so that escapes to the
// host. Any check-then-path-write pattern is fundamentally racy.
//
// Instead of validating a string path and then writing to it, we walk every
// path component with openat + O_NOFOLLOW (see safeWrite). Containment is
// enforced by the kernel at open time: each component is opened relative to the
// previous component's file descriptor, never by absolute path string, and a
// symlink at any component makes openat fail with ELOOP. There is no window in
// which a raced-in symlink could be traversed, so the TOCTOU is unwinnable.
func (w *Workspace) Write(path string, content []byte) error {
	// Cheap lexical pre-filter (reject raw "..", re-root, split into
	// components). The kernel-enforced O_NOFOLLOW walk below is the real
	// containment guard; this just rejects obviously-bad input early and
	// produces the relative component list to walk.
	rel, err := w.relComponents(path)
	if err != nil {
		return err
	}
	return safeWrite(w.root, rel, content)
}

// relComponents applies the lexical containment guard used across the workspace
// (reject raw ".." before Clean, re-root absolute paths) and returns the path's
// components relative to the workspace root. It returns ErrPathTraversal for any
// input that does not name a file strictly within the workspace.
func (w *Workspace) relComponents(path string) ([]string, error) {
	// Check raw input for ".." segments BEFORE cleaning. filepath.Clean
	// resolves ".." which can hide traversal attempts (e.g. "/../../tmp/evil"
	// cleans to "/tmp/evil", losing the ".." evidence).
	for _, part := range strings.Split(path, "/") {
		if part == ".." {
			return nil, ErrPathTraversal
		}
	}

	cleaned := filepath.Clean(path)
	cleaned = strings.TrimPrefix(cleaned, "/")
	// "" or "." means the workspace root itself — no file component to write.
	if cleaned == "" || cleaned == "." {
		return nil, ErrPathTraversal
	}

	out := make([]string, 0)
	for _, c := range strings.Split(cleaned, "/") {
		if c == "" || c == "." {
			continue
		}
		if c == ".." { // belt-and-suspenders: Clean shouldn't leave these
			return nil, ErrPathTraversal
		}
		out = append(out, c)
	}
	if len(out) == 0 {
		return nil, ErrPathTraversal
	}
	return out, nil
}

// Delete removes a file or directory (recursively)
func (w *Workspace) Delete(path string) error {
	resolved, err := w.resоlvePath(path)
	if err != nil {
		return err
	}

	// Don't allow deleting the workspace root itself
	if resolved == w.root {
		return errors.New("cannot delete workspace root")
	}

	// Check if exists
	_, err = os.Stat(resolved)
	if err != nil {
		if os.IsNotExist(err) {
			return ErrNotFound
		}
		return err
	}

	return os.RemoveAll(resolved)
}

// Stat returns information about a file or directory
func (w *Workspace) Stat(path string) (*FileInfo, error) {
	resolved, err := w.resоlvePath(path)
	if err != nil {
		return nil, err
	}

	info, err := os.Stat(resolved)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	// Calculate relative path
	relPath, _ := filepath.Rel(w.root, resolved)
	if !strings.HasPrefix(relPath, "/") {
		relPath = "/" + relPath
	}

	return &FileInfo{
		Name:    info.Name(),
		Path:    relPath,
		Size:    info.Size(),
		IsDir:   info.IsDir(),
		ModTime: info.ModTime(),
		Mode:    info.Mode().String(),
	}, nil
}

// Mkdir creates a directory
func (w *Workspace) Mkdir(path string) error {
	resolved, err := w.resоlvePath(path)
	if err != nil {
		return err
	}

	return os.MkdirAll(resolved, 0755)
}

// Exists checks if a file or directory exists
func (w *Workspace) Exists(path string) (bool, error) {
	resolved, err := w.resоlvePath(path)
	if err != nil {
		return false, err
	}

	_, err = os.Stat(resolved)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}

	return true, nil
}

// Walk walks the workspace tree
func (w *Workspace) Walk(path string, fn func(path string, info FileInfo) error) error {
	resolved, err := w.resоlvePath(path)
	if err != nil {
		return err
	}

	return filepath.WalkDir(resolved, func(walkPath string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		// Skip the root directory itself — callers only want its contents
		if walkPath == resolved {
			return nil
		}

		info, err := d.Info()
		if err != nil {
			return err
		}

		relPath, _ := filepath.Rel(w.root, walkPath)
		if !strings.HasPrefix(relPath, "/") {
			relPath = "/" + relPath
		}

		return fn(relPath, FileInfo{
			Name:    d.Name(),
			Path:    relPath,
			Size:    info.Size(),
			IsDir:   d.IsDir(),
			ModTime: info.ModTime(),
			Mode:    info.Mode().String(),
		})
	})
}
