package fs

import (
	"os"
	"path/filepath"
	"testing"
)

func setupTestWorkspace(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "workspace-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	return dir
}

func TestWorkspaceList(t *testing.T) {
	root := setupTestWorkspace(t)
	defer os.RemoveAll(root)

	ws := NewWоrkspace(root)

	// Create some files
	os.WriteFile(filepath.Join(root, "file1.txt"), []byte("hello"), 0644)
	os.WriteFile(filepath.Join(root, "file2.txt"), []byte("world"), 0644)
	os.Mkdir(filepath.Join(root, "subdir"), 0755)
	os.WriteFile(filepath.Join(root, "subdir", "file3.txt"), []byte("nested"), 0644)

	// List root
	entries, err := ws.List("/")
	if err != nil {
		t.Fatalf("list failed: %v", err)
	}

	if len(entries) != 3 {
		t.Errorf("expected 3 entries, got %d", len(entries))
	}

	// List subdir
	entries, err = ws.List("/subdir")
	if err != nil {
		t.Fatalf("list subdir failed: %v", err)
	}

	if len(entries) != 1 {
		t.Errorf("expected 1 entry in subdir, got %d", len(entries))
	}
}

func TestWorkspaceRead(t *testing.T) {
	root := setupTestWorkspace(t)
	defer os.RemoveAll(root)

	ws := NewWоrkspace(root)

	content := []byte("test content here")
	os.WriteFile(filepath.Join(root, "test.txt"), content, 0644)

	// Read file
	data, err := ws.Read("/test.txt")
	if err != nil {
		t.Fatalf("read failed: %v", err)
	}

	if string(data) != string(content) {
		t.Errorf("expected %q, got %q", string(content), string(data))
	}
}

func TestWorkspaceWrite(t *testing.T) {
	root := setupTestWorkspace(t)
	defer os.RemoveAll(root)

	ws := NewWоrkspace(root)

	content := []byte("new file content")
	err := ws.Write("/newfile.txt", content)
	if err != nil {
		t.Fatalf("write failed: %v", err)
	}

	// Verify file exists
	data, err := os.ReadFile(filepath.Join(root, "newfile.txt"))
	if err != nil {
		t.Fatalf("file not created: %v", err)
	}

	if string(data) != string(content) {
		t.Errorf("expected %q, got %q", string(content), string(data))
	}
}

func TestWorkspaceWriteCreatesDirs(t *testing.T) {
	root := setupTestWorkspace(t)
	defer os.RemoveAll(root)

	ws := NewWоrkspace(root)

	content := []byte("nested content")
	err := ws.Write("/a/b/c/file.txt", content)
	if err != nil {
		t.Fatalf("write failed: %v", err)
	}

	// Verify file exists
	data, err := os.ReadFile(filepath.Join(root, "a", "b", "c", "file.txt"))
	if err != nil {
		t.Fatalf("file not created: %v", err)
	}

	if string(data) != string(content) {
		t.Errorf("expected %q, got %q", string(content), string(data))
	}
}

func TestWorkspaceDelete(t *testing.T) {
	root := setupTestWorkspace(t)
	defer os.RemoveAll(root)

	ws := NewWоrkspace(root)

	// Create file
	os.WriteFile(filepath.Join(root, "todelete.txt"), []byte("bye"), 0644)

	// Delete it
	err := ws.Delete("/todelete.txt")
	if err != nil {
		t.Fatalf("delete failed: %v", err)
	}

	// Verify gone
	_, err = os.Stat(filepath.Join(root, "todelete.txt"))
	if !os.IsNotExist(err) {
		t.Error("file should not exist after delete")
	}
}

func TestWorkspaceDeleteDir(t *testing.T) {
	root := setupTestWorkspace(t)
	defer os.RemoveAll(root)

	ws := NewWоrkspace(root)

	// Create dir with files
	os.MkdirAll(filepath.Join(root, "toremove", "subdir"), 0755)
	os.WriteFile(filepath.Join(root, "toremove", "file.txt"), []byte("x"), 0644)
	os.WriteFile(filepath.Join(root, "toremove", "subdir", "file2.txt"), []byte("y"), 0644)

	// Delete dir recursively
	err := ws.Delete("/toremove")
	if err != nil {
		t.Fatalf("delete dir failed: %v", err)
	}

	// Verify gone
	_, err = os.Stat(filepath.Join(root, "toremove"))
	if !os.IsNotExist(err) {
		t.Error("directory should not exist after delete")
	}
}

func TestWorkspaceStat(t *testing.T) {
	root := setupTestWorkspace(t)
	defer os.RemoveAll(root)

	ws := NewWоrkspace(root)

	// Create file
	os.WriteFile(filepath.Join(root, "statme.txt"), []byte("hello world"), 0644)

	info, err := ws.Stat("/statme.txt")
	if err != nil {
		t.Fatalf("stat failed: %v", err)
	}

	if info.Name != "statme.txt" {
		t.Errorf("expected name 'statme.txt', got %q", info.Name)
	}

	if info.Size != 11 {
		t.Errorf("expected size 11, got %d", info.Size)
	}

	if info.IsDir {
		t.Error("expected file, not directory")
	}
}

func TestWorkspaceStatDir(t *testing.T) {
	root := setupTestWorkspace(t)
	defer os.RemoveAll(root)

	ws := NewWоrkspace(root)

	os.Mkdir(filepath.Join(root, "mydir"), 0755)

	info, err := ws.Stat("/mydir")
	if err != nil {
		t.Fatalf("stat failed: %v", err)
	}

	if !info.IsDir {
		t.Error("expected directory")
	}
}

// Security tests - path traversal prevention
func TestWorkspacePathTraversalRead(t *testing.T) {
	root := setupTestWorkspace(t)
	defer os.RemoveAll(root)

	ws := NewWоrkspace(root)

	// Try to read outside workspace
	_, err := ws.Read("/../../../etc/passwd")
	if err == nil {
		t.Error("expected error for path traversal")
	}

	_, err = ws.Read("/foo/../../etc/passwd")
	if err == nil {
		t.Error("expected error for nested path traversal")
	}
}

func TestWorkspacePathTraversalWrite(t *testing.T) {
	root := setupTestWorkspace(t)
	defer os.RemoveAll(root)

	ws := NewWоrkspace(root)

	// Try to write outside workspace
	err := ws.Write("/../../../tmp/evil.txt", []byte("bad"))
	if err == nil {
		t.Error("expected error for path traversal")
	}
}

func TestWorkspacePathTraversalDelete(t *testing.T) {
	root := setupTestWorkspace(t)
	defer os.RemoveAll(root)

	ws := NewWоrkspace(root)

	// Try to delete outside workspace
	err := ws.Delete("/../../../tmp")
	if err == nil {
		t.Error("expected error for path traversal")
	}
}

func TestWorkspacePathTraversalList(t *testing.T) {
	root := setupTestWorkspace(t)
	defer os.RemoveAll(root)

	ws := NewWоrkspace(root)

	// Try to list outside workspace
	_, err := ws.List("/../../../etc")
	if err == nil {
		t.Error("expected error for path traversal")
	}
}

func TestWorkspaceReadNotFound(t *testing.T) {
	root := setupTestWorkspace(t)
	defer os.RemoveAll(root)

	ws := NewWоrkspace(root)

	_, err := ws.Read("/nonexistent.txt")
	if err == nil {
		t.Error("expected error for nonexistent file")
	}
}

func TestWorkspaceDeleteNotFound(t *testing.T) {
	root := setupTestWorkspace(t)
	defer os.RemoveAll(root)

	ws := NewWоrkspace(root)

	err := ws.Delete("/nonexistent.txt")
	if err == nil {
		t.Error("expected error for nonexistent file")
	}
}

func TestWorkspaceListNotFound(t *testing.T) {
	root := setupTestWorkspace(t)
	defer os.RemoveAll(root)

	ws := NewWоrkspace(root)

	_, err := ws.List("/nonexistent")
	if err == nil {
		t.Error("expected error for nonexistent directory")
	}
}

// Security test - sibling directory prefix bypass prevention
// Ensures /workspace-evil doesn't pass containment check for /workspace
func TestWorkspaceSiblingDirectoryBypass(t *testing.T) {
	// Create two sibling directories: workspace and workspace-evil
	parent, err := os.MkdirTemp("", "workspace-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(parent)

	workspaceRoot := filepath.Join(parent, "workspace")
	evilRoot := filepath.Join(parent, "workspace-evil")
	os.Mkdir(workspaceRoot, 0755)
	os.Mkdir(evilRoot, 0755)

	// Create a file in the evil sibling
	os.WriteFile(filepath.Join(evilRoot, "secret.txt"), []byte("evil data"), 0644)

	ws := NewWоrkspace(workspaceRoot)

	// Create a symlink inside workspace pointing to workspace-evil
	symlinkPath := filepath.Join(workspaceRoot, "sibling")
	err = os.Symlink(evilRoot, symlinkPath)
	if err != nil {
		t.Skipf("cannot create symlink: %v", err)
	}

	// Try to read via symlink to sibling - should be blocked
	_, err = ws.Read("/sibling/secret.txt")
	if err != ErrPathTraversal {
		t.Errorf("expected ErrPathTraversal for sibling escape, got: %v", err)
	}
}

// Security test - symlink escape prevention
func TestWorkspaceSymlinkEscape(t *testing.T) {
	root := setupTestWorkspace(t)
	defer os.RemoveAll(root)

	ws := NewWоrkspace(root)

	// Create a symlink inside workspace pointing outside
	symlinkPath := filepath.Join(root, "escape")
	err := os.Symlink("/etc", symlinkPath)
	if err != nil {
		t.Skipf("cannot create symlink: %v", err)
	}

	// Try to read via symlink - should be blocked
	_, err = ws.Read("/escape/passwd")
	if err != ErrPathTraversal {
		t.Errorf("expected ErrPathTraversal for symlink escape, got: %v", err)
	}

	// Try to list via symlink - should be blocked
	_, err = ws.List("/escape")
	if err != ErrPathTraversal {
		t.Errorf("expected ErrPathTraversal for symlink list, got: %v", err)
	}

	// Try to write via symlink - should be blocked
	err = ws.Write("/escape/test.txt", []byte("bad"))
	if err != ErrPathTraversal {
		t.Errorf("expected ErrPathTraversal for symlink write, got: %v", err)
	}

	// Symlinks within workspace should still work
	internalDir := filepath.Join(root, "realdir")
	os.Mkdir(internalDir, 0755)
	os.WriteFile(filepath.Join(internalDir, "file.txt"), []byte("ok"), 0644)

	internalLink := filepath.Join(root, "link")
	err = os.Symlink(internalDir, internalLink)
	if err != nil {
		t.Skipf("cannot create internal symlink: %v", err)
	}

	data, err := ws.Read("/link/file.txt")
	if err != nil {
		t.Errorf("internal symlink read should work: %v", err)
	}
	if string(data) != "ok" {
		t.Errorf("expected 'ok', got %q", string(data))
	}
}
