package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSafeFilePath(t *testing.T) {
	base := t.TempDir()
	repo := filepath.Join(base, "repo")
	if err := os.Mkdir(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(repo, "main.go"), "package main\n")
	writeFile(t, filepath.Join(base, "secret.txt"), "outside")
	if err := os.Symlink(filepath.Join(base, "secret.txt"), filepath.Join(repo, "link")); err != nil {
		t.Fatal(err)
	}

	if _, err := safeFilePath(repo, "main.go"); err != nil {
		t.Fatalf("inside: %v", err)
	}
	for _, rel := range []string{"../secret.txt", "link", filepath.Join(base, "secret.txt")} {
		if _, err := safeFilePath(repo, rel); err == nil {
			t.Fatalf("%s should be rejected", rel)
		}
	}
}

func TestDiffAnchor(t *testing.T) {
	const want = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" // SHA-256 of "abc"
	if got := DiffAnchor("abc"); got != want {
		t.Fatalf("DiffAnchor() = %q", got)
	}
}
