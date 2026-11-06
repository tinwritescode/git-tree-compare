package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// headRepo commits pkg/f.txt twice and returns the repository and the second commit.
func headRepo(t *testing.T) (repo, head string) {
	t.Helper()
	repo = t.TempDir()
	git := gitIn(t, repo)
	git("init", "-q", "-b", "main")
	writeFile(t, repo+"/pkg/f.txt", "base\n")
	git("add", ".")
	git("commit", "-q", "-m", "base")
	writeFile(t, repo+"/pkg/f.txt", "at head\n")
	git("commit", "-q", "-am", "head")
	head = git("rev-parse", "HEAD")
	// The working copy differs from the head, as it does when another branch is checked out.
	writeFile(t, repo+"/pkg/f.txt", "working copy\n")
	return repo, head
}

func TestHeadCopyPathIsNamedAfterThePullRequestAndHead(t *testing.T) {
	head := strings.Repeat("ab", 20)
	got, err := headCopyPath(headCopyRequest{Tmp: "/tmp", Repo: "/src/widget", Number: 7, Head: head, Path: "pkg/f.txt"})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join("/tmp", "git-tree-compare", repoHash("/src/widget"), "pr-7", head[:12], "pkg", "f.txt")
	if got != want {
		t.Fatalf("headCopyPath() = %q, want %q", got, want)
	}
	other, _ := headCopyPath(headCopyRequest{Tmp: "/tmp", Repo: "/src/other", Number: 7, Head: head, Path: "pkg/f.txt"})
	if other == got {
		t.Fatal("two repositories share a copy")
	}
}

func TestHeadCopyPathRejectsPathsOutsideTheCopy(t *testing.T) {
	head := strings.Repeat("ab", 20)
	for _, bad := range []headCopyRequest{
		{Tmp: "/tmp", Repo: "/r", Number: 7, Head: head, Path: "../x"},
		{Tmp: "/tmp", Repo: "/r", Number: 7, Head: head, Path: "/etc/passwd"},
		{Tmp: "/tmp", Repo: "/r", Number: 7, Head: head, Path: ""},
		{Tmp: "/tmp", Repo: "/r", Number: 7, Head: "--output=x", Path: "f.txt"},
		{Tmp: "/tmp", Repo: "/r", Number: 0, Head: head, Path: "f.txt"},
	} {
		if _, err := headCopyPath(bad); err == nil {
			t.Errorf("headCopyPath(%+v) was accepted", bad)
		}
	}
}

func TestWriteHeadCopyWritesTheHeadVersionReadOnly(t *testing.T) {
	repo, head := headRepo(t)
	req := headCopyRequest{Tmp: t.TempDir(), Repo: repo, Number: 7, Head: head, Path: "pkg/f.txt"}

	path, err := writeHeadCopy(req)
	if err != nil {
		t.Fatal(err)
	}
	if body := readFile(t, path); body != "at head\n" {
		t.Fatalf("copy holds %q, want the head version", body)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o444 {
		t.Fatalf("copy mode = %v, want read-only", info.Mode().Perm())
	}
}

func TestWriteHeadCopyTwiceReplacesAnEditedCopy(t *testing.T) {
	repo, head := headRepo(t)
	req := headCopyRequest{Tmp: t.TempDir(), Repo: repo, Number: 7, Head: head, Path: "pkg/f.txt"}
	path, err := writeHeadCopy(req)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	writeFile(t, path, "edited by hand\n")

	again, err := writeHeadCopy(req)
	if err != nil {
		t.Fatal(err)
	}
	if again != path || readFile(t, path) != "at head\n" {
		t.Fatalf("second copy at %q holds %q", again, readFile(t, again))
	}
}

func TestWriteHeadCopyRefusesASymlinkOutOfTheCopy(t *testing.T) {
	repo, head := headRepo(t)
	req := headCopyRequest{Tmp: t.TempDir(), Repo: repo, Number: 7, Head: head, Path: "pkg/f.txt"}
	path, err := headCopyPath(req)
	if err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Dir(filepath.Dir(path)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Dir(path)); err != nil {
		t.Fatal(err)
	}

	if _, err := writeHeadCopy(req); err == nil {
		t.Fatal("wrote through a symlink")
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatalf("wrote %d files outside the copy", len(entries))
	}
}

func TestWriteHeadCopyFailsForAFileNotAtHead(t *testing.T) {
	repo, head := headRepo(t)
	_, err := writeHeadCopy(headCopyRequest{Tmp: t.TempDir(), Repo: repo, Number: 7, Head: head, Path: "gone.txt"})
	if err == nil || !strings.Contains(err.Error(), "gone.txt") {
		t.Fatalf("err = %v, want one naming the file", err)
	}
}
