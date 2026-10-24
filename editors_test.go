package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInstalledEditorsFindsAppBundles(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "Cursor.app"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "Zed.app"), 0o755); err != nil {
		t.Fatal(err)
	}

	got := installedEditors(knownEditors, []string{t.TempDir(), dir})

	if len(got) != 2 || got[0].ID != "zed" || got[1].ID != "cursor" {
		t.Fatalf("installedEditors() = %+v, want zed then cursor", got)
	}
}

func TestOpenInEditorRejectsUnknownID(t *testing.T) {
	repo, _ := newTestRepo(t)

	if err := OpenInEditor(repo, "main.go", "notepad"); err == nil {
		t.Fatal("OpenInEditor accepted an unknown editor")
	}
}
