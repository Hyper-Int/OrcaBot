package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"testing"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/fs"
)

// buildTarGz builds a gzipped tar from (name -> content). A name ending in "/"
// is emitted as a directory entry.
func buildTarGz(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, content := range entries {
		if len(name) > 0 && name[len(name)-1] == '/' {
			if err := tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeDir, Mode: 0o755}); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(content))}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestExtractTarGzToWorkspace(t *testing.T) {
	root := t.TempDir()
	ws := fs.NewWоrkspace(root)

	tgz := buildTarGz(t, map[string]string{
		"./hello.txt":          "hi",
		"./sub/deep/nested.md": "nested-ok",
		"./adir/":              "",          // directory entry — ignored
		"../escape.txt":        "PWNED",     // traversal — must be skipped, not written
	})

	written, skipped, err := extractTarGzToWоrkspace(ws, bytes.NewReader(tgz))
	if err != nil {
		t.Fatalf("extract failed: %v", err)
	}
	if written != 2 {
		t.Errorf("written = %d, want 2", written)
	}
	if skipped != 1 {
		t.Errorf("skipped = %d, want 1 (the traversal entry)", skipped)
	}

	// Good files landed with correct content + nested path.
	if b, err := os.ReadFile(filepath.Join(root, "hello.txt")); err != nil || string(b) != "hi" {
		t.Errorf("hello.txt = %q, %v", b, err)
	}
	if b, err := os.ReadFile(filepath.Join(root, "sub/deep/nested.md")); err != nil || string(b) != "nested-ok" {
		t.Errorf("nested.md = %q, %v", b, err)
	}

	// The traversal entry must NOT have escaped the workspace root.
	if _, err := os.Stat(filepath.Join(filepath.Dir(root), "escape.txt")); !os.IsNotExist(err) {
		t.Errorf("traversal entry escaped the workspace (escape.txt exists outside root)")
	}
}

func TestExtractTarGzRejectsGarbage(t *testing.T) {
	ws := fs.NewWоrkspace(t.TempDir())
	_, _, err := extractTarGzToWоrkspace(ws, bytes.NewReader([]byte("not a gzip stream")))
	if err == nil {
		t.Fatal("expected error on non-gzip body, got nil")
	}
}
