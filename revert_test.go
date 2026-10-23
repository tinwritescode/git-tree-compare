package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestRevertToBase checks that revert restores modified and deleted files to the base
// and skips added files, which have no base version.
func TestRevertToBase(t *testing.T) {
	repo := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(repo, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	git("init", "-q", "-b", "main")
	write("keep.txt", "base\n")
	write("gone.txt", "base\n")
	git("add", ".")
	git("commit", "-q", "-m", "base")
	git("checkout", "-q", "-b", "feat")
	write("keep.txt", "changed\n")
	write("new.txt", "added\n")
	git("add", "new.txt")
	git("commit", "-q", "-am", "feature")
	write("keep.txt", "local edit\n")
	os.Remove(filepath.Join(repo, "gone.txt"))
	write("untracked.txt", "x\n")

	s := Scope{Repo: repo, Base: "main"}
	result, err := RevertToBase(s, []string{"keep.txt", "gone.txt", "new.txt", "untracked.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(repo, "keep.txt")); string(got) != "base\n" {
		t.Errorf("keep.txt = %q, want base content", got)
	}
	if _, err := os.Stat(filepath.Join(repo, "gone.txt")); err != nil {
		t.Errorf("gone.txt not restored: %v", err)
	}
	if len(result.Reverted) != 2 || len(result.Skipped) != 2 {
		t.Errorf("result = %+v, want 2 reverted and 2 skipped", result)
	}

	if _, err := RevertToBase(Scope{Repo: repo, Base: "main", Commit: "abc"}, []string{"keep.txt"}); err == nil {
		t.Error("expected an error for a commit scope")
	}
}
