package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestParsePRList(t *testing.T) {
	out := []byte(`[
	 {"id":"PR_1","number":1,"title":"Mine","url":"https://github.com/o/r/pull/1","author":{"login":"me"},"headRefName":"a","baseRefName":"main","isDraft":true,"additions":3,"deletions":1,"changedFiles":2,"updatedAt":"2026-11-02T00:00:00Z","reviewDecision":"","mergeable":"MERGEABLE"},
	 {"id":"PR_2","number":2,"title":"Asked","author":{"login":"sam"}},
	 {"id":"PR_3","number":3,"title":"Other","author":null}
	]`)

	prs, err := parsePRList(out, "me", map[int]bool{2: true})
	if err != nil {
		t.Fatal(err)
	}
	groups := []string{prs[0].Group, prs[1].Group, prs[2].Group}
	if !reflect.DeepEqual(groups, []string{"mine", "requested", "other"}) {
		t.Fatalf("groups = %v", groups)
	}
	if prs[0].Author != "me" || !prs[0].IsDraft || prs[0].ChangedFiles != 2 || prs[0].HeadRef != "a" {
		t.Fatalf("first PR = %+v", prs[0])
	}
	if prs[2].Author != "ghost" {
		t.Fatalf("deleted account author = %q", prs[2].Author)
	}
}

func TestParsePRListPrefersRequestedOverMine(t *testing.T) {
	prs, err := parsePRList([]byte(`[{"number":1,"author":{"login":"me"}}]`), "me", map[int]bool{1: true})
	if err != nil {
		t.Fatal(err)
	}
	if prs[0].Group != "requested" {
		t.Fatalf("group = %q", prs[0].Group)
	}
}

func TestRemoteForPR(t *testing.T) {
	remotes := "origin\tgit@github.com:me/r.git (fetch)\n" +
		"origin\tgit@github.com:me/r.git (push)\n" +
		"upstream\thttps://github.com/o/r.git (fetch)\n"
	if got := remoteForPR(remotes, "https://github.com/o/r/pull/9"); got != "upstream" {
		t.Fatalf("got %q, want the remote that hosts the PR", got)
	}
	if got := remoteForPR(remotes, "https://github.com/me/r/pull/9"); got != "origin" {
		t.Fatalf("got %q", got)
	}
	if got := remoteForPR(remotes, "https://github.com/x/y/pull/9"); got != "origin" {
		t.Fatalf("no match should fall back to origin, got %q", got)
	}
}

func TestViewedMutation(t *testing.T) {
	mark := viewedMutation(true, 2)
	if strings.Count(mark, "markFileAsViewed") != 2 || !strings.Contains(mark, "$p1: String!") {
		t.Fatalf("mark mutation = %s", mark)
	}
	unmark := viewedMutation(false, 1)
	if !strings.Contains(unmark, "unmarkFileAsViewed") || strings.Contains(unmark, " markFileAsViewed") {
		t.Fatalf("unmark mutation = %s", unmark)
	}
}

// A pull request is reviewed from its own refs: the checkout stays as it was, uncommitted work included.
func TestPrepareReviewLeavesTheCheckoutAlone(t *testing.T) {
	remote := t.TempDir()
	r := func(args ...string) string {
		t.Helper()
		out, err := runGit(remote, append([]string{"-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return strings.TrimSpace(out)
	}
	r("init", "-q", "-b", "main")
	writeFile(t, remote+"/a.txt", "one\n")
	r("add", ".")
	r("commit", "-q", "-m", "base")
	r("checkout", "-q", "-b", "feature")
	writeFile(t, remote+"/a.txt", "two\n")
	writeFile(t, remote+"/b.txt", "new\n")
	r("add", ".")
	r("commit", "-q", "-m", "change")
	head := r("rev-parse", "HEAD")
	r("update-ref", "refs/pull/7/head", head)
	r("checkout", "-q", "main")
	r("branch", "-D", "feature")
	r("merge-base", "main", "main")
	base := r("rev-parse", "main")
	// main moves on after the branch point; the diff must still show only the PR's changes.
	writeFile(t, remote+"/c.txt", "later\n")
	r("add", ".")
	r("commit", "-q", "-m", "later on main")

	clone := t.TempDir()
	if _, err := runGit(clone, "clone", "-q", "--branch", "main", remote, "."); err != nil {
		t.Fatal(err)
	}
	writeFile(t, clone+"/a.txt", "my uncommitted work\n")

	target, err := PrepareReview(clone, PRInfo{Number: 7, BaseRef: "main", URL: "https://github.com/o/r/pull/7"})
	if err != nil {
		t.Fatal(err)
	}
	if target.Head != head || target.Base != base {
		t.Fatalf("target = %+v, want head %s base %s", target, head, base)
	}

	files, err := ChangedFiles(Scope{Repo: clone, Base: target.Base, Head: target.Head})
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, f := range files {
		paths = append(paths, f.Path)
	}
	if !reflect.DeepEqual(paths, []string{"a.txt", "b.txt"}) {
		t.Fatalf("paths = %v", paths)
	}
	diff, err := FileDiff(Scope{Repo: clone, Base: target.Base, Head: target.Head}, "a.txt")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(diff, "+two") || strings.Contains(diff, "uncommitted") {
		t.Fatalf("diff = %s", diff)
	}

	status, _ := runGit(clone, "status", "--porcelain")
	if strings.TrimSpace(status) != "M a.txt" {
		t.Fatalf("status = %q, checkout should be untouched", status)
	}
	again, err := PrepareReview(clone, PRInfo{Number: 7, BaseRef: "main", URL: "https://github.com/o/r/pull/7"})
	if err != nil || again != target {
		t.Fatalf("second run = %+v, %v", again, err)
	}
}
