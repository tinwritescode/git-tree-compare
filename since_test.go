package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// sinceRepo makes a pull request's history: base, the head the reviewer marked f.txt at, and a
// later head. The repository lives at .../acme/widget, so the pull request URL below picks it as
// a remote.
func sinceRepo(t *testing.T) (repo string, base, reviewed, head string) {
	t.Helper()
	repo = filepath.Join(t.TempDir(), "acme", "widget")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	git := gitIn(t, repo)
	git("init", "-q", "-b", "main")
	writeFile(t, repo+"/f.txt", "one\n")
	git("add", ".")
	git("commit", "-q", "-m", "base")
	base = git("rev-parse", "HEAD")
	writeFile(t, repo+"/f.txt", "two\n")
	git("commit", "-q", "-am", "reviewed here")
	reviewed = git("rev-parse", "HEAD")
	writeFile(t, repo+"/f.txt", "three\n")
	git("commit", "-q", "-am", "pushed after the review")
	head = git("rev-parse", "HEAD")
	return repo, base, reviewed, head
}

const sincePRURL = "https://github.com/acme/widget/pull/7"

func TestDiffSinceShowsOnlyWhatChangedAfterTheReview(t *testing.T) {
	repo, base, reviewed, head := sinceRepo(t)
	got, err := DiffSince(Scope{Repo: repo, Base: base, Head: head}, reviewed, "f.txt", sincePRURL)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Found {
		t.Fatal("Found = false for a commit in the repository")
	}
	if !strings.Contains(got.Text, "-two") || !strings.Contains(got.Text, "+three") || strings.Contains(got.Text, "one") {
		t.Errorf("diff is not reviewed..head:\n%s", got.Text)
	}
}

// After a force push the reviewed commit is not in the clone. It is fetched from the remote that
// hosts the pull request, the way GitHub serves a commit by id.
func TestDiffSinceFetchesAMissingCommit(t *testing.T) {
	upstream, base, reviewed, _ := sinceRepo(t)
	up := gitIn(t, upstream)
	up("config", "uploadpack.allowAnySHA1InWant", "true")
	// The force push: the branch is rebuilt on base, so the reviewed commit is on no branch.
	up("reset", "-q", "--hard", base)
	writeFile(t, upstream+"/f.txt", "three\n")
	up("commit", "-q", "-am", "rewritten")
	head := up("rev-parse", "HEAD")

	clone := t.TempDir()
	git := gitIn(t, clone)
	git("init", "-q", "-b", "main")
	git("remote", "add", "upstream", upstream)
	git("fetch", "-q", "upstream", "main")
	if hasCommit(clone, reviewed) {
		t.Fatal("setup: the clone already has the reviewed commit")
	}

	got, err := DiffSince(Scope{Repo: clone, Base: base, Head: head}, reviewed, "f.txt", sincePRURL)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Found || !strings.Contains(got.Text, "-two") || !strings.Contains(got.Text, "+three") {
		t.Errorf("got %+v, want the fetched reviewed..head diff", got)
	}
}

func TestDiffSinceReportsACommitThatIsGone(t *testing.T) {
	repo, base, _, head := sinceRepo(t)
	gone := strings.Repeat("ab", 20)
	got, err := DiffSince(Scope{Repo: repo, Base: base, Head: head}, gone, "f.txt", sincePRURL)
	if err != nil {
		t.Fatal(err)
	}
	if got.Found || got.Text != "" {
		t.Errorf("got %+v, want not found", got)
	}
}

func TestDiffSinceRejectsWhatIsNotACommitID(t *testing.T) {
	repo, base, _, head := sinceRepo(t)
	for _, from := range []string{"", "HEAD~1", "--upload-pack=touch x", strings.Repeat("g", 40)} {
		if _, err := DiffSince(Scope{Repo: repo, Base: base, Head: head}, from, "f.txt", sincePRURL); err == nil {
			t.Errorf("DiffSince(from=%q) gave no error", from)
		}
	}
}
