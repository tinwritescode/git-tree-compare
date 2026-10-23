package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestDiffArgsFullFile(t *testing.T) {
	got := diffArgs(Scope{Base: "main", FullFile: true}, "abc123", nil, "src/a.go")
	want := []string{"diff", "-M", fullFileContext, "abc123", "--", "src/a.go"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("diffArgs() = %v, want %v", got, want)
	}
}

// TestFileDiffFullFile checks that the full-file option adds the lines far from the change,
// both for a tracked file and for an untracked one.
func TestFileDiffFullFile(t *testing.T) {
	repo := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	var lines []string
	for i := 1; i <= 40; i++ {
		lines = append(lines, "line "+strings.Repeat("x", i%3))
	}
	body := strings.Join(lines, "\n") + "\n"
	writeFile(t, filepath.Join(repo, "long.txt"), body)
	git("init", "-q", "-b", "main")
	git("add", ".")
	git("commit", "-q", "-m", "base")
	changed := strings.Replace(body, "line x\n", "CHANGED\n", 1)
	writeFile(t, filepath.Join(repo, "long.txt"), changed)

	compact, err := FileDiff(Scope{Repo: repo, Base: "main"}, "long.txt")
	if err != nil {
		t.Fatal(err)
	}
	full, err := FileDiff(Scope{Repo: repo, Base: "main", FullFile: true}, "long.txt")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(compact, "line xx\n") && strings.Count(compact, "\n") > 12 {
		t.Errorf("compact diff unexpectedly long:\n%s", compact)
	}
	if !strings.Contains(full, " line xx") || !strings.Contains(full, "CHANGED") {
		t.Errorf("full diff misses lines:\n%s", full)
	}
	if strings.Count(full, "\n") <= strings.Count(compact, "\n") {
		t.Errorf("full diff should be longer than compact diff")
	}

	writeFile(t, filepath.Join(repo, "new.txt"), body)
	untracked, err := FileDiff(Scope{Repo: repo, Base: "main", FullFile: true}, "new.txt")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(untracked, "line xx") || strings.Count(untracked, "\n") < 40 {
		t.Errorf("untracked full diff misses lines:\n%s", untracked)
	}
}
