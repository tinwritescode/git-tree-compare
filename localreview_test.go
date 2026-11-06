package main

import (
	"reflect"
	"slices"
	"strings"
	"testing"
)

// gitIn returns a function that runs git in dir as a test committer and fails the test on error.
func gitIn(t *testing.T, dir string) func(args ...string) string {
	return func(args ...string) string {
		t.Helper()
		out, err := runGit(dir, append([]string{"-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return strings.TrimSpace(out)
	}
}

// branchRepo makes main with two commits and a branch feat cut from the first, so main has
// moved on since feat started.
func branchRepo(t *testing.T) (repo string, git func(args ...string) string) {
	t.Helper()
	repo = t.TempDir()
	git = gitIn(t, repo)
	git("init", "-q", "-b", "main")
	writeFile(t, repo+"/a.txt", "one\n")
	git("add", ".")
	git("commit", "-q", "-m", "first")
	git("checkout", "-q", "-b", "feat")
	writeFile(t, repo+"/f.txt", "feature\n")
	git("add", ".")
	git("commit", "-q", "-m", "add feature")
	git("checkout", "-q", "main")
	writeFile(t, repo+"/a.txt", "two\n")
	writeFile(t, repo+"/b.txt", "new\n")
	git("add", ".")
	git("commit", "-q", "-m", "second")
	return repo, git
}

func changedPaths(t *testing.T, repo string, r LocalReview) []string {
	t.Helper()
	files, err := ChangedFiles(Scope{Repo: repo, Base: r.Base, Head: r.Head})
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, f := range files {
		paths = append(paths, f.Status+" "+f.Path)
	}
	slices.Sort(paths)
	return paths
}

func TestReviewCommitShowsOnlyThatCommit(t *testing.T) {
	repo, git := branchRepo(t)

	r, err := ReviewCommit(repo, "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if got := changedPaths(t, repo, r); !reflect.DeepEqual(got, []string{"A b.txt", "M a.txt"}) {
		t.Fatalf("changed = %v", got)
	}
	if want := git("rev-parse", "--short", "HEAD") + " second"; r.Title != want {
		t.Fatalf("title = %q, want %q", r.Title, want)
	}
	if !strings.HasPrefix(r.Detail, "t, ") {
		t.Fatalf("detail = %q, want the author first", r.Detail)
	}
}

func TestReviewCommitOfTheFirstCommit(t *testing.T) {
	repo, git := branchRepo(t)

	r, err := ReviewCommit(repo, git("rev-list", "--max-parents=0", "HEAD"))
	if err != nil {
		t.Fatal(err)
	}
	if got := changedPaths(t, repo, r); !reflect.DeepEqual(got, []string{"A a.txt"}) {
		t.Fatalf("changed = %v", got)
	}
}

func TestReviewCommitUnknown(t *testing.T) {
	repo, _ := branchRepo(t)
	if _, err := ReviewCommit(repo, "nope"); err == nil || !strings.Contains(err.Error(), "nope") {
		t.Fatalf("err = %v, want it to name the commit", err)
	}
}

// Like a pull request, a branch shows only what it adds, not what its base gained since.
func TestReviewBranchFromMergeBase(t *testing.T) {
	repo, _ := branchRepo(t)

	for _, base := range []string{"", "main"} {
		r, err := ReviewBranch(repo, "feat", base)
		if err != nil {
			t.Fatal(err)
		}
		if got := changedPaths(t, repo, r); !reflect.DeepEqual(got, []string{"A f.txt"}) {
			t.Fatalf("base %q: changed = %v", base, got)
		}
		if r.Title != "feat into main" || r.Detail != "1 commit" {
			t.Fatalf("base %q: title %q, detail %q", base, r.Title, r.Detail)
		}
	}
}

// In a clone, a branch that exists only on the remote opens, and the base defaults to origin's.
func TestReviewBranchInAClone(t *testing.T) {
	src, _ := branchRepo(t)
	clone := t.TempDir()
	gitIn(t, clone)("clone", "-q", src, ".")

	r, err := ReviewBranch(clone, "feat", "")
	if err != nil {
		t.Fatal(err)
	}
	if r.Title != "origin/feat into origin/main" {
		t.Fatalf("title = %q", r.Title)
	}
	if got := changedPaths(t, clone, r); !reflect.DeepEqual(got, []string{"A f.txt"}) {
		t.Fatalf("changed = %v", got)
	}
}

// A base that is not a branch name, such as HEAD~1, means the local commit, never origin's.
func TestReviewBranchWithARevAsBase(t *testing.T) {
	src, _ := branchRepo(t)
	clone := t.TempDir()
	git := gitIn(t, clone)
	git("clone", "-q", src, ".")
	writeFile(t, clone+"/local.txt", "only here\n")
	git("add", ".")
	git("commit", "-q", "-m", "local")

	r, err := ReviewBranch(clone, "main", "HEAD~1")
	if err != nil {
		t.Fatal(err)
	}
	if r.Title != "main into HEAD~1" {
		t.Fatalf("title = %q", r.Title)
	}
	if got := changedPaths(t, clone, r); !reflect.DeepEqual(got, []string{"A local.txt"}) {
		t.Fatalf("changed = %v", got)
	}
}

func TestReviewBranchUnknown(t *testing.T) {
	repo, _ := branchRepo(t)
	if _, err := ReviewBranch(repo, "nope", ""); err == nil || !strings.Contains(err.Error(), "nope") {
		t.Fatalf("err = %v, want it to name the branch", err)
	}
	if _, err := ReviewBranch(repo, "feat", "gone"); err == nil || !strings.Contains(err.Error(), "gone") {
		t.Fatalf("err = %v, want it to name the base", err)
	}
}

func TestLaunchReview(t *testing.T) {
	repo, _ := branchRepo(t)

	if r, err := launchReview(repo, Launch{Path: repo}); r != nil || err != nil {
		t.Fatalf("plain launch = %v, %v", r, err)
	}
	if r, err := launchReview(repo, Launch{Path: repo, Commit: "HEAD"}); err != nil || !strings.HasSuffix(r.Title, " second") {
		t.Fatalf("commit launch = %+v, %v", r, err)
	}
	if r, err := launchReview(repo, Launch{Path: repo, Branch: "feat", Base: "main"}); err != nil || r.Title != "feat into main" {
		t.Fatalf("branch launch = %+v, %v", r, err)
	}
	if _, err := launchReview(repo, Launch{Commit: "HEAD", Branch: "feat"}); err == nil {
		t.Fatal("want an error for --commit with --branch")
	}
	if _, err := launchReview(repo, Launch{Commit: "HEAD", Base: "main"}); err == nil {
		t.Fatal("want an error for --base without --branch")
	}
}

func TestListRefs(t *testing.T) {
	repo, _ := branchRepo(t)

	refs, err := ListRefs(repo)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(refs.Branches, "feat") || !slices.Contains(refs.Branches, "main") {
		t.Fatalf("branches = %v", refs.Branches)
	}
	if refs.DefaultBase != "main" {
		t.Fatalf("default base = %q", refs.DefaultBase)
	}
	var subjects []string
	for _, c := range refs.Commits {
		subjects = append(subjects, c.Subject)
	}
	if !reflect.DeepEqual(subjects, []string{"second", "add feature", "first"}) && !reflect.DeepEqual(subjects, []string{"add feature", "second", "first"}) {
		t.Fatalf("commits = %v", subjects)
	}
}

func TestListLocalOffersTheCheckedOutBranchAndRecentCommits(t *testing.T) {
	repo, git := branchRepo(t)
	git("checkout", "-q", "feat")

	local := ListLocal(repo)
	if local.Branch == nil || *local.Branch != (LocalBranch{Name: "feat", Base: "main", Ahead: 1}) {
		t.Fatalf("branch = %+v", local.Branch)
	}
	var subjects []string
	for _, c := range local.Commits {
		subjects = append(subjects, c.Subject)
	}
	if !reflect.DeepEqual(subjects, []string{"add feature", "first"}) {
		t.Fatalf("commits = %v, want only the commits on HEAD", subjects)
	}
}

func TestListLocalCapsCommitsAndSkipsTheDefaultBranch(t *testing.T) {
	repo, git := branchRepo(t)
	for i := 0; i < 6; i++ {
		git("commit", "-q", "--allow-empty", "-m", "more")
	}

	local := ListLocal(repo)
	if local.Branch != nil {
		t.Fatalf("branch = %+v, want none on the default branch", local.Branch)
	}
	if len(local.Commits) != inboxCommits {
		t.Fatalf("got %d commits, want %d", len(local.Commits), inboxCommits)
	}
}

func TestListLocalSkipsABranchWithNothingNew(t *testing.T) {
	repo, git := branchRepo(t)
	git("checkout", "-q", "-b", "empty", "main")

	local := ListLocal(repo)
	if local.Branch != nil {
		t.Fatalf("branch = %+v, want none when it adds no commits", local.Branch)
	}
}

func TestListLocalInAnEmptyRepository(t *testing.T) {
	repo := t.TempDir()
	gitIn(t, repo)("init", "-q", "-b", "main")

	if local := ListLocal(repo); local.Branch != nil || len(local.Commits) != 0 {
		t.Fatalf("local = %+v", local)
	}
}
