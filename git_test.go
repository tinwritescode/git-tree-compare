package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseNameStatus(t *testing.T) {
	out := "M\tfrontend/src/App.tsx\nA\tgit.go\nD\told.txt\nR087\tsrc/a.go\tsrc/b.go\n"

	got := parseNameStatus(out)

	want := []FileChange{
		{Path: "frontend/src/App.tsx", Status: "M"},
		{Path: "git.go", Status: "A"},
		{Path: "old.txt", Status: "D"},
		{Path: "src/b.go", OldPath: "src/a.go", Status: "R"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseNameStatus() = %+v, want %+v", got, want)
	}
}

func TestParseNameStatusEmpty(t *testing.T) {
	if got := parseNameStatus(""); len(got) != 0 {
		t.Fatalf("parseNameStatus(\"\") = %+v, want empty", got)
	}
}

func TestSplitLines(t *testing.T) {
	got := splitLines("main\n\nfeature/x\n")
	want := []string{"main", "feature/x"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("splitLines() = %v, want %v", got, want)
	}
}

func TestListRefsKeepsLocalAndRemoteBranchesApart(t *testing.T) {
	repo := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		out, err := runGit(repo, args...)
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return out
	}
	git("init", "-q", "-b", "main")
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "a")
	first := strings.TrimSpace(git("rev-parse", "HEAD"))
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "b")
	second := strings.TrimSpace(git("rev-parse", "HEAD"))

	// A local staging and an origin/staging that point at different commits.
	git("branch", "staging", first)
	git("update-ref", "refs/remotes/origin/staging", second)
	git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/staging")

	got, err := ListRefs(repo)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"main", "staging", "origin/staging"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ListRefs = %v, want %v", got, want)
	}
}
