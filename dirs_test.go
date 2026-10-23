package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestListDir(t *testing.T) {
	root := t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(root, "repo", ".git"), 0o755))
	must(os.MkdirAll(filepath.Join(root, "plain"), 0o755))
	must(os.MkdirAll(filepath.Join(root, ".hidden"), 0o755))
	must(os.WriteFile(filepath.Join(root, "file.txt"), []byte("x"), 0o644))

	list, err := ListDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if list.IsRepo {
		t.Fatalf("root marked as repo: %+v", list)
	}
	if len(list.Entries) != 2 || list.Entries[0].Name != "plain" || list.Entries[1].Name != "repo" {
		t.Fatalf("entries = %+v", list.Entries)
	}
	if list.Entries[0].IsRepo || !list.Entries[1].IsRepo {
		t.Fatalf("repo flags wrong: %+v", list.Entries)
	}

	inside, err := ListDir(filepath.Join(root, "repo"))
	if err != nil {
		t.Fatal(err)
	}
	if !inside.IsRepo || inside.Parent != root {
		t.Fatalf("ListDir(repo) = %+v", inside)
	}
}

func TestListDirMissing(t *testing.T) {
	if _, err := ListDir(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Fatal("expected an error for a missing folder")
	}
}
