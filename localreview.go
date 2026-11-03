package main

import (
	"errors"
	"fmt"
	"strings"
)

// LocalReview is a commit or a branch reviewed from git alone, with no pull request behind it.
// Marks stay on this machine.
type LocalReview struct {
	Title  string `json:"title"`  // "a1b2c3d Fix the parser", or "feat/x into main"
	Detail string `json:"detail"` // author and age of a commit, or how many commits a branch adds
	Base   string `json:"base"`
	Head   string `json:"head"`
}

// RefList is what the in-app pickers offer: branches, newest first, and recent commits.
type RefList struct {
	Branches    []string    `json:"branches"`
	DefaultBase string      `json:"defaultBase"` // "" when the repository has no main or master
	Commits     []CommitRef `json:"commits"`
}

// CommitRef is one commit in the commit picker.
type CommitRef struct {
	Hash    string `json:"hash"`
	Short   string `json:"short"`
	Subject string `json:"subject"`
	Author  string `json:"author"`
	When    string `json:"when"`
}

// pickerCommits caps how many recent commits the commit picker lists.
const pickerCommits = 300

// launchReview turns --commit or --branch from the command line into a review. Neither means
// the pull request list.
func launchReview(repo string, l Launch) (*LocalReview, error) {
	var (
		r   LocalReview
		err error
	)
	switch {
	case l.Commit != "" && l.Branch != "":
		return nil, errors.New("use --commit or --branch, not both")
	case l.Base != "" && l.Branch == "":
		return nil, errors.New("--base goes with --branch")
	case l.Commit != "":
		r, err = ReviewCommit(repo, l.Commit)
	case l.Branch != "":
		r, err = ReviewBranch(repo, l.Branch, l.Base)
	default:
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// ReviewCommit reviews what one commit changed, against its first parent. A root commit is
// compared with the empty tree, so every file shows as added.
func ReviewCommit(repo, rev string) (LocalReview, error) {
	head, err := resolveCommit(repo, rev)
	if err != nil {
		return LocalReview{}, fmt.Errorf("no commit %q in this repository", rev)
	}
	base, err := resolveCommit(repo, head+"^")
	if err != nil {
		out, treeErr := runGit(repo, "hash-object", "-t", "tree", "/dev/null")
		if treeErr != nil {
			return LocalReview{}, treeErr
		}
		base = strings.TrimSpace(out)
	}
	info, err := runGit(repo, "log", "-1", "--format=%h %s%x00%an, %ar", head)
	if err != nil {
		return LocalReview{}, err
	}
	title, detail, _ := strings.Cut(strings.TrimSpace(info), "\x00")
	return LocalReview{Title: title, Detail: detail, Base: base, Head: head}, nil
}

// ReviewBranch reviews what branch adds over base, from their merge base as a pull request
// would. An empty base means the repository's default branch. The branch is read locally
// first, then from origin; a base that origin has as a branch is read from origin first,
// which is likelier to be current.
func ReviewBranch(repo, branch, base string) (LocalReview, error) {
	heads := []string{branch}
	if remote, ok := originBranch(repo, branch); ok {
		heads = append(heads, remote)
	}
	headName, head, err := resolveFirst(repo, heads...)
	if err != nil {
		return LocalReview{}, fmt.Errorf("no branch %q in this repository", branch)
	}
	bases := defaultBases(repo)
	if base != "" {
		bases = []string{base}
		if remote, ok := originBranch(repo, base); ok {
			bases = []string{remote, base}
		}
	}
	baseName, baseHead, err := resolveFirst(repo, bases...)
	if err != nil {
		if base == "" {
			return LocalReview{}, errors.New("found no main or master to compare with; choose a base")
		}
		return LocalReview{}, fmt.Errorf("no branch %q in this repository", base)
	}
	out, err := runGit(repo, "merge-base", baseHead, head)
	if err != nil {
		return LocalReview{}, fmt.Errorf("%s and %s share no history", headName, baseName)
	}
	from := strings.TrimSpace(out)
	count, err := runGit(repo, "rev-list", "--count", from+".."+head)
	if err != nil {
		return LocalReview{}, err
	}
	return LocalReview{
		Title:  headName + " into " + baseName,
		Detail: plural(strings.TrimSpace(count), "commit"),
		Base:   from,
		Head:   head,
	}, nil
}

// ListRefs lists the branches and recent commits the in-app pickers offer.
func ListRefs(repo string) (RefList, error) {
	out, err := runGit(repo, "for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes")
	if err != nil {
		return RefList{}, err
	}
	list := RefList{}
	for _, ref := range splitLines(out) {
		if strings.HasPrefix(ref, "refs/remotes/") && strings.HasSuffix(ref, "/HEAD") {
			continue
		}
		name := strings.TrimPrefix(strings.TrimPrefix(ref, "refs/heads/"), "refs/remotes/")
		list.Branches = append(list.Branches, name)
	}
	if name, _, err := resolveFirst(repo, defaultBases(repo)...); err == nil {
		list.DefaultBase = strings.TrimPrefix(name, "origin/")
	}
	log, err := runGit(repo, "log", fmt.Sprintf("-n%d", pickerCommits), "--format=%H%x00%h%x00%s%x00%an%x00%ar",
		"HEAD", "--branches", "--remotes")
	if err != nil {
		return list, nil // a repository with no commits has nothing to pick
	}
	for _, line := range splitLines(log) {
		f := strings.Split(line, "\x00")
		if len(f) == 5 {
			list.Commits = append(list.Commits, CommitRef{Hash: f[0], Short: f[1], Subject: f[2], Author: f[3], When: f[4]})
		}
	}
	return list, nil
}

// defaultBases lists where the default branch may be, most likely first: what origin/HEAD
// points at, then main and master.
func defaultBases(repo string) []string {
	var names []string
	if out, err := runGit(repo, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"); err == nil {
		names = append(names, strings.TrimSpace(out))
	}
	return append(names, "origin/main", "main", "origin/master", "master")
}

// originBranch names origin's branch called name, and reports whether origin has one. It
// matches whole branch names only, so a rev such as HEAD~1 is never read as origin/HEAD~1.
func originBranch(repo, name string) (string, bool) {
	_, err := runGit(repo, "show-ref", "--verify", "--quiet", "refs/remotes/origin/"+name)
	return "origin/" + name, err == nil
}

// resolveFirst returns the first of names that is a commit, with its full id.
func resolveFirst(repo string, names ...string) (string, string, error) {
	for _, name := range names {
		if id, err := resolveCommit(repo, name); err == nil {
			return name, id, nil
		}
	}
	return "", "", fmt.Errorf("none of %v is a commit", names)
}

// resolveCommit returns the full id of the commit rev names.
func resolveCommit(repo, rev string) (string, error) {
	out, err := runGit(repo, "rev-parse", "--verify", "--quiet", "--end-of-options", rev+"^{commit}")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// plural writes "1 commit" or "3 commits" from a count git printed.
func plural(count, noun string) string {
	if count == "1" {
		return "1 " + noun
	}
	return count + " " + noun + "s"
}
