package main

import (
	"encoding/json"
	"os/exec"
	"strings"
)

// PRInfo is the open pull request for the repository's current branch.
// Mergeable is MERGEABLE, CONFLICTING, or UNKNOWN as reported by GitHub.
type PRInfo struct {
	ID        string `json:"id"`
	Number    int    `json:"number"`
	Title     string `json:"title"`
	URL       string `json:"url"`
	BaseRef   string `json:"baseRefName"`
	HeadOID   string `json:"headRefOid"`
	BaseOID   string `json:"baseRefOid"`
	Mergeable string `json:"mergeable"`
	State     string `json:"state"`
}

// parsePRInfo reads `gh pr view --json ...` output.
func parsePRInfo(out []byte) (*PRInfo, error) {
	var pr PRInfo
	if err := json.Unmarshal(out, &pr); err != nil {
		return nil, err
	}
	return &pr, nil
}

// PRStatus returns the open pull request for the current branch, or nil when
// there is none or gh is missing or not logged in.
func PRStatus(repo string) *PRInfo {
	cmd := exec.Command("gh", "pr", "view", "--json", "id,number,title,url,baseRefName,baseRefOid,headRefOid,mergeable,state")
	cmd.Dir = repo
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	pr, err := parsePRInfo(out)
	if err != nil {
		return nil
	}
	return pr
}

// OpenPR opens the current branch's pull request in the browser.
func OpenPR(repo string) error {
	cmd := exec.Command("gh", "pr", "view", "--web")
	cmd.Dir = repo
	return cmd.Start()
}

// PRBase is the branch a pull request merges into, resolved to the commit to compare against.
// Fetched is false when that commit is not in this clone; Commit then falls back to a local or
// remote branch of the same name, which may be behind the pull request's base.
type PRBase struct {
	Name    string `json:"name"`
	Commit  string `json:"commit"`
	Fetched bool   `json:"fetched"`
}

// DetectBase resolves the open pull request's base. It prefers the exact commit the pull request
// merges into, so the comparison matches what GitHub shows.
func DetectBase(repo string) PRBase {
	return resolvePRBase(repo, PRStatus(repo))
}

// resolvePRBase is DetectBase for a known pull request.
func resolvePRBase(repo string, pr *PRInfo) PRBase {
	if pr == nil || pr.BaseRef == "" {
		return PRBase{}
	}
	name := strings.TrimSpace(pr.BaseRef)
	if oid := strings.TrimSpace(pr.BaseOID); oid != "" && hasCommit(repo, oid) {
		return PRBase{Name: name, Commit: oid, Fetched: true}
	}
	for _, candidate := range []string{name, "origin/" + name} {
		if hasCommit(repo, candidate) {
			return PRBase{Name: name, Commit: candidate}
		}
	}
	return PRBase{Name: name}
}

// hasCommit reports whether ref names a commit in the repository.
func hasCommit(repo, ref string) bool {
	_, err := runGit(repo, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	return err == nil
}
