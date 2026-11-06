package main

import (
	"fmt"
	"regexp"
)

// SinceDiff is one file's diff from the head the reviewer last marked it reviewed at to the
// current head. Found is false when that commit is not here and could not be fetched, as after a
// force push that GitHub has since cleaned up; the caller then shows the whole pull request.
type SinceDiff struct {
	Text  string `json:"text"`
	Found bool   `json:"found"`
}

// commitID matches a full SHA-1 or SHA-256 commit id, so a stored value can never reach git as an option.
var commitID = regexp.MustCompile(`^([0-9a-f]{40}|[0-9a-f]{64})$`)

// hasCommit reports whether repo has the commit id in its object store.
func hasCommit(repo, id string) bool {
	_, err := runGit(repo, "cat-file", "-e", id+"^{commit}")
	return err == nil
}

// DiffSince returns the diff of path from the commit `from` to the scope's head, with the scope's
// whitespace and full-file options. A commit missing from the clone is fetched by id from the
// remote that hosts the pull request at prURL.
func DiffSince(s Scope, from, path, prURL string) (SinceDiff, error) {
	if !commitID.MatchString(from) {
		return SinceDiff{}, fmt.Errorf("%q is not a commit id", from)
	}
	if !hasCommit(s.Repo, from) {
		remotes, err := runGit(s.Repo, "remote", "-v")
		if err != nil {
			return SinceDiff{}, err
		}
		// A failed fetch is the answer, not an error: the commit is gone.
		_, _ = runGit(s.Repo, "fetch", "--quiet", "--no-tags", remoteForPR(remotes, prURL), from)
		if !hasCommit(s.Repo, from) {
			return SinceDiff{}, nil
		}
	}
	s.Base = from
	text, err := scopeDiff(s, nil, path)
	if err != nil {
		return SinceDiff{}, err
	}
	return SinceDiff{Text: text, Found: true}, nil
}
