package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newTestRepo makes a temporary directory with a file in it, and a sibling file outside it.
func newTestRepo(t *testing.T) (repo, outside string) {
	t.Helper()
	base := t.TempDir()
	repo = filepath.Join(base, "repo")
	if err := os.Mkdir(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	outside = filepath.Join(base, "secret.txt")
	if err := os.WriteFile(outside, []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return repo, outside
}

func TestReadFileInside(t *testing.T) {
	repo, _ := newTestRepo(t)

	got, err := ReadFile(repo, "main.go")
	if err != nil || got != "package main\n" {
		t.Fatalf("ReadFile() = %q, %v", got, err)
	}
}

func TestReadFileRejectsEscape(t *testing.T) {
	repo, outside := newTestRepo(t)

	for _, rel := range []string{"../secret.txt", filepath.Base(outside), "/etc/hosts"} {
		if _, err := ReadFile(repo, rel); err == nil {
			t.Fatalf("ReadFile(%q) allowed a path outside the repository", rel)
		}
	}
}

func TestReadFileRejectsSymlinkEscape(t *testing.T) {
	repo, outside := newTestRepo(t)
	if err := os.Symlink(outside, filepath.Join(repo, "link.txt")); err != nil {
		t.Fatal(err)
	}

	if _, err := ReadFile(repo, "link.txt"); err == nil {
		t.Fatal("ReadFile followed a symlink out of the repository")
	}
	if err := WriteFile(repo, "link.txt", "changed"); err == nil {
		t.Fatal("WriteFile followed a symlink out of the repository")
	}
}

func TestReadFileRejectsBinary(t *testing.T) {
	repo, _ := newTestRepo(t)
	if err := os.WriteFile(filepath.Join(repo, "img.bin"), []byte{0x89, 0x00, 0x01}, 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := ReadFile(repo, "img.bin"); err == nil || !strings.Contains(err.Error(), "binary") {
		t.Fatalf("ReadFile(binary) error = %v, want a binary-file error", err)
	}
}

func TestWriteFileKeepsMode(t *testing.T) {
	repo, _ := newTestRepo(t)
	path := filepath.Join(repo, "run.sh")
	if err := os.WriteFile(path, []byte("echo hi\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := WriteFile(repo, "run.sh", "echo bye\n"); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("mode = %v, want 0755", info.Mode().Perm())
	}
	got, _ := os.ReadFile(path)
	if string(got) != "echo bye\n" {
		t.Fatalf("content = %q", got)
	}
}

func TestWriteFileDoesNotCreate(t *testing.T) {
	repo, _ := newTestRepo(t)

	if err := WriteFile(repo, "new.go", "package x\n"); err == nil {
		t.Fatal("WriteFile created a file that did not exist")
	}
}

func TestListFilesSkipsIgnored(t *testing.T) {
	repo, _ := newTestRepo(t)
	for _, args := range [][]string{
		{"init", "-q"},
		{"add", "main.go"},
		{"-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"},
	} {
		if out, err := runGit(repo, args...); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	if err := os.WriteFile(filepath.Join(repo, ".gitignore"), []byte("*.log\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "debug.log"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "new.go"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := ListFiles(repo)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"main.go": true, "new.go": true, ".gitignore": true}
	if len(got) != len(want) {
		t.Fatalf("ListFiles() = %v, want %v", got, want)
	}
	for _, p := range got {
		if !want[p] {
			t.Fatalf("ListFiles() included %q", p)
		}
	}
}

func TestDiffAnchor(t *testing.T) {
	// SHA-256 of the empty string.
	if got := DiffAnchor(""); got != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Fatalf("DiffAnchor(\"\") = %s", got)
	}
}
