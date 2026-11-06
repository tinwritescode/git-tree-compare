package main

import (
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
)

const linkScheme = "git-tree-compare"

// slugPattern is owner/name as GitHub writes it. The first character keeps a slug from reading as a flag.
var slugPattern = regexp.MustCompile(`^[A-Za-z0-9][\w.-]*/[\w.-]+$`)

// OpenLink is what a git-tree-compare:// URL asks for: one pull request of a GitHub repository.
type OpenLink struct {
	Slug string `json:"slug"`
	PR   int    `json:"pr"`
}

// parseOpenURL reads git-tree-compare://open?repo=owner/name&pr=N. Any web page can send one of
// these, so it accepts nothing but that exact shape.
func parseOpenURL(raw string) (OpenLink, error) {
	bad := fmt.Errorf("this link cannot be opened: %q", raw)
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != linkScheme || u.Host != "open" {
		return OpenLink{}, bad
	}
	query := u.Query()
	slug := query.Get("repo")
	number, err := strconv.Atoi(query.Get("pr"))
	if err != nil || number < 1 || !slugPattern.MatchString(slug) {
		return OpenLink{}, bad
	}
	return OpenLink{Slug: slug, PR: number}, nil
}

// FindClone returns the local repository with a remote at slug, or "". It looks through the known
// repositories, then the repositories in the same folders. Worktrees of a clone match too.
func FindClone(slug string, known []string) string {
	for _, dir := range cloneCandidates(known) {
		remotes, err := runGit(dir, "remote", "-v")
		if err != nil {
			continue
		}
		if _, ok := remoteMatching(remotes, slug); ok {
			return dir
		}
	}
	return ""
}

// cloneCandidates lists known first, as those are the likeliest, then their sibling repositories.
func cloneCandidates(known []string) []string {
	out := slices.Clone(known)
	for _, dir := range known {
		listing, err := ListDir(filepath.Dir(dir))
		if err != nil {
			continue
		}
		for _, entry := range listing.Entries {
			if entry.IsRepo && !slices.Contains(out, entry.Path) {
				out = append(out, entry.Path)
			}
		}
	}
	return out
}
