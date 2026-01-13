package fs

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

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
func NewWorkspace(root string) *Workspace {
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
func (w *Workspace) resolvePath(path string) (string, error) {
	// First check: reject any path containing ..
	if strings.Contains(path, "..") {
		return "", ErrPathTraversal
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
		// If the path doesn't exist, check the parent directory instead
		// This allows creating new files while still preventing symlink escapes
		if os.IsNotExist(err) {
			parent := filepath.Dir(fullPath)
			base := filepath.Base(fullPath)

			resolvedParent, parentErr := filepath.EvalSymlinks(parent)
			if parentErr != nil {
				// Parent doesn't exist either - check if it's within workspace
				// Use Abs as fallback for new directory trees
				resolvedParent, parentErr = filepath.Abs(parent)
				if parentErr != nil {
					return "", parentErr
				}
			}

			// Check parent is within workspace
			if !isPathWithin(resolvedParent, w.root) {
				return "", ErrPathTraversal
			}

			return filepath.Join(resolvedParent, base), nil
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
	resolved, err := w.resolvePath(path)
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
	resolved, err := w.resolvePath(path)
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

// Write writes content to a file, creating directories as needed
func (w *Workspace) Write(path string, content []byte) error {
	resolved, err := w.resolvePath(path)
	if err != nil {
		return err
	}

	// Create parent directories
	dir := filepath.Dir(resolved)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	return os.WriteFile(resolved, content, 0644)
}

// Delete removes a file or directory (recursively)
func (w *Workspace) Delete(path string) error {
	resolved, err := w.resolvePath(path)
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
	resolved, err := w.resolvePath(path)
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
	resolved, err := w.resolvePath(path)
	if err != nil {
		return err
	}

	return os.MkdirAll(resolved, 0755)
}

// Exists checks if a file or directory exists
func (w *Workspace) Exists(path string) (bool, error) {
	resolved, err := w.resolvePath(path)
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
	resolved, err := w.resolvePath(path)
	if err != nil {
		return err
	}

	return filepath.WalkDir(resolved, func(walkPath string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
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
