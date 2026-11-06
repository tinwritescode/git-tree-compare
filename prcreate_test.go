package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestPRCreateArgsPutEachValueAfterItsFlag(t *testing.T) {
	got, err := prCreateArgs(PRCreateRequest{Base: "main", Branch: "feat/x", Title: "--web"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"pr", "create", "--base", "main", "--head", "feat/x", "--title", "--web", "--body-file", "-"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
	got, _ = prCreateArgs(PRCreateRequest{Base: "main", Branch: "feat", Title: "  Add limits  "})
	if got[7] != "Add limits" {
		t.Errorf("title = %q", got[7])
	}

	for _, bad := range []PRCreateRequest{
		{Base: "main", Branch: "feat", Title: ""},
		{Base: "main", Branch: "feat", Title: "two\nlines"},
		{Base: "main", Branch: "feat", Title: strings.Repeat("x", 300)},
		{Base: "-main", Branch: "feat", Title: "t"},
		{Base: "main", Branch: "--repo=evil/x", Title: "t"},
		{Base: "main", Branch: "a..b", Title: "t"},
		{Base: "main", Branch: "main", Title: "t"},
		{Base: "", Branch: "feat", Title: "t"},
	} {
		if _, err := prCreateArgs(bad); err == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
}

// pushedRepo is a clone of a bare origin with branch feat pushed, and the head of feat.
func pushedRepo(t *testing.T) (repo, head string, git func(args ...string) string) {
	t.Helper()
	origin := t.TempDir()
	gitIn(t, origin)("init", "-q", "--bare", "-b", "main")
	repo = t.TempDir()
	git = gitIn(t, repo)
	git("init", "-q", "-b", "main")
	git("remote", "add", "origin", origin)
	writeFile(t, repo+"/a.txt", "one\n")
	git("add", ".")
	git("commit", "-q", "-m", "first")
	git("checkout", "-q", "-b", "feat")
	writeFile(t, repo+"/a.txt", "two\n")
	git("commit", "-q", "-am", "feat")
	git("push", "-q", "origin", "main", "feat")
	return repo, git("rev-parse", "HEAD"), git
}

func TestBranchPushStateSaysWhetherOriginHasTheReviewedHead(t *testing.T) {
	repo, head, git := pushedRepo(t)
	if got := BranchPushState(repo, "feat", head); !got.Pushed {
		t.Fatalf("a pushed branch reads as %+v", got)
	}

	writeFile(t, repo+"/a.txt", "three\n")
	git("commit", "-q", "-am", "local only")
	ahead := git("rev-parse", "HEAD")
	if got := BranchPushState(repo, "feat", ahead); got.Pushed || !strings.Contains(got.Message, "origin does not have") {
		t.Fatalf("a branch with an unpushed commit reads as %+v", got)
	}

	git("checkout", "-q", "-b", "fresh")
	if got := BranchPushState(repo, "fresh", ahead); got.Pushed || !strings.Contains(got.Message, "is not on origin") {
		t.Fatalf("a branch origin lacks reads as %+v", got)
	}
}

func TestCreatePRRefusesAnUnpushedBranchBeforeCallingGitHub(t *testing.T) {
	repo, _, git := pushedRepo(t)
	git("checkout", "-q", "-b", "fresh")
	writeFile(t, repo+"/a.txt", "three\n")
	git("commit", "-q", "-am", "local only")
	_, err := CreatePR(repo, PRCreateRequest{Base: "main", Branch: "fresh", Head: git("rev-parse", "HEAD"), Title: "t", Body: "b"})
	if err == nil || !strings.Contains(err.Error(), "is not on origin") {
		t.Fatalf("err = %v", err)
	}
}
