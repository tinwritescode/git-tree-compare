package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// prListFields are the pull request fields read from `gh pr list`.
const prListFields = "id,number,title,url,author,headRefName,headRefOid,baseRefName,isDraft,additions,deletions,changedFiles,updatedAt,reviewDecision,mergeable"

// prListLimit caps how many open pull requests are listed.
const prListLimit = 100

// PR groups, in the order the list shows them.
const (
	groupRequested = "requested" // waiting for the viewer's review
	groupMine      = "mine"      // opened by the viewer
	groupOther     = "other"
)

// PRInfo is one open pull request. Mergeable is MERGEABLE, CONFLICTING, or UNKNOWN as reported by GitHub.
type PRInfo struct {
	ID             string `json:"id"`
	Number         int    `json:"number"`
	Title          string `json:"title"`
	URL            string `json:"url"`
	Author         string `json:"author"`
	HeadRef        string `json:"headRefName"`
	HeadOID        string `json:"headRefOid"`
	BaseRef        string `json:"baseRefName"`
	IsDraft        bool   `json:"isDraft"`
	Additions      int    `json:"additions"`
	Deletions      int    `json:"deletions"`
	ChangedFiles   int    `json:"changedFiles"`
	UpdatedAt      string `json:"updatedAt"`
	ReviewDecision string `json:"reviewDecision"`
	Mergeable      string `json:"mergeable"`
	Group          string `json:"group"`
	IsMine         bool   `json:"isMine"` // opened by the viewer, who cannot approve it or request changes on it
}

// ReviewTarget is the pair of commits a pull request's diff is taken between.
// Base is the merge base, so the diff matches GitHub's Files tab even when the base branch has moved.
type ReviewTarget struct {
	Base string `json:"base"`
	Head string `json:"head"`
}

// parsePRList reads `gh pr list --json` output and sorts each pull request into its group.
func parsePRList(out []byte, viewer string, requested map[int]bool) ([]PRInfo, error) {
	var raw []struct {
		PRInfo
		Author *struct {
			Login string `json:"login"`
		} `json:"author"`
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, err
	}
	prs := make([]PRInfo, 0, len(raw))
	for _, r := range raw {
		pr := r.PRInfo
		pr.Author = "ghost"
		if r.Author != nil && r.Author.Login != "" {
			pr.Author = r.Author.Login
		}
		pr.IsMine = pr.Author == viewer
		switch {
		case requested[pr.Number]:
			pr.Group = groupRequested
		case pr.Author == viewer:
			pr.Group = groupMine
		default:
			pr.Group = groupOther
		}
		prs = append(prs, pr)
	}
	return prs, nil
}

// runGH runs the gh CLI in repo. Its error message says what GitHub or gh reported.
func runGH(repo string, args ...string) ([]byte, error) {
	return runGHInput(repo, nil, args...)
}

// runGHInput runs the gh CLI in repo with input on stdin, such as a request body for `--input -`.
func runGHInput(repo string, input []byte, args ...string) ([]byte, error) {
	cmd := exec.Command("gh", args...)
	cmd.Dir = repo
	if input != nil {
		cmd.Stdin = bytes.NewReader(input)
	}
	out, err := cmd.Output()
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok && len(exit.Stderr) > 0 {
			return nil, fmt.Errorf("GitHub said: %s", strings.TrimSpace(string(exit.Stderr)))
		}
		return nil, err
	}
	return out, nil
}

// ListPRs returns the repository's open pull requests, grouped for the viewer.
func ListPRs(repo string) ([]PRInfo, error) {
	limit := strconv.Itoa(prListLimit)
	out, err := runGH(repo, "pr", "list", "--state", "open", "--limit", limit, "--json", prListFields)
	if err != nil {
		return nil, err
	}
	login, err := runGH(repo, "api", "user", "--jq", ".login")
	if err != nil {
		return nil, err
	}
	asked, err := runGH(repo, "pr", "list", "--state", "open", "--limit", limit, "--search", "review-requested:@me", "--json", "number")
	if err != nil {
		return nil, err
	}
	var numbers []struct {
		Number int `json:"number"`
	}
	if err := json.Unmarshal(asked, &numbers); err != nil {
		return nil, err
	}
	requested := make(map[int]bool, len(numbers))
	for _, n := range numbers {
		requested[n.Number] = true
	}
	return parsePRList(out, strings.TrimSpace(string(login)), requested)
}

// CurrentPRNumber returns the open pull request of the checked-out branch, or 0 when it has none.
func CurrentPRNumber(repo string) int {
	out, err := runGH(repo, "pr", "view", "--json", "number,state")
	if err != nil {
		return 0
	}
	var pr struct {
		Number int    `json:"number"`
		State  string `json:"state"`
	}
	if json.Unmarshal(out, &pr) != nil || pr.State != "OPEN" {
		return 0
	}
	return pr.Number
}

// remoteForPR picks the remote that hosts the pull request, so forks with an `upstream` work.
// remotes is `git remote -v` output. It falls back to origin.
func remoteForPR(remotes, prURL string) string {
	slug, _, found := parsePRURL(prURL)
	if !found {
		return "origin"
	}
	if name, ok := remoteMatching(remotes, slug); ok {
		return name
	}
	return "origin"
}

// parsePRURL reads owner/name and the number from https://github.com/owner/name/pull/N.
func parsePRURL(prURL string) (string, int, bool) {
	path, ok := strings.CutPrefix(prURL, "https://github.com/")
	if !ok {
		return "", 0, false
	}
	slug, rest, ok := strings.Cut(path, "/pull/")
	number, err := strconv.Atoi(rest)
	if !ok || err != nil || number < 1 || !slugPattern.MatchString(slug) {
		return "", 0, false
	}
	return slug, number, true
}

// remoteMatching returns the first remote whose URL ends in slug, such as owner/name.
// remotes is `git remote -v` output.
func remoteMatching(remotes, slug string) (string, bool) {
	for _, line := range splitLines(remotes) {
		name, rest, ok := strings.Cut(line, "\t")
		if !ok {
			continue
		}
		url, _, _ := strings.Cut(rest, " ")
		url = strings.TrimSuffix(url, ".git")
		if strings.HasSuffix(url, "/"+slug) || strings.HasSuffix(url, ":"+slug) {
			return name, true
		}
	}
	return "", false
}

// PrepareReview fetches a pull request into refs of the app's own and returns the commits to diff.
// It reads refs/pull/N/head, which also exists for forks, and never touches the checkout or its branches.
func PrepareReview(repo string, pr PRInfo) (ReviewTarget, error) {
	remotes, err := runGit(repo, "remote", "-v")
	if err != nil {
		return ReviewTarget{}, err
	}
	headRef := fmt.Sprintf("refs/git-tree-compare/pr/%d/head", pr.Number)
	baseRef := fmt.Sprintf("refs/git-tree-compare/pr/%d/base", pr.Number)
	if _, err := runGit(repo, "fetch", "--quiet", "--no-tags", remoteForPR(remotes, pr.URL),
		fmt.Sprintf("+refs/pull/%d/head:%s", pr.Number, headRef),
		fmt.Sprintf("+refs/heads/%s:%s", pr.BaseRef, baseRef),
	); err != nil {
		return ReviewTarget{}, err
	}
	head, err := runGit(repo, "rev-parse", headRef)
	if err != nil {
		return ReviewTarget{}, err
	}
	base, err := runGit(repo, "merge-base", baseRef, headRef)
	if err != nil {
		return ReviewTarget{}, err
	}
	return ReviewTarget{Base: strings.TrimSpace(base), Head: strings.TrimSpace(head)}, nil
}
