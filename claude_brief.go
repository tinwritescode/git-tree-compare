package main

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
)

// The brief: what a change does, where its risk is, and the order to read it in.

//go:embed prompts/brief.md
var briefPrompt string

//go:embed schemas/brief.json
var briefSchema string

const (
	briefBudgetUSD = 3.0
	// briefInputVersion changes when what goes on stdin changes, to miss briefs made from the old input.
	briefInputVersion = "1"
	// maxBriefDiff caps the diff sent on stdin. Claude reads the rest from the checkout.
	maxBriefDiff = 400_000
	maxBriefText = 20_000
)

// BriefRequest asks for the brief of a pull request or a local branch.
type BriefRequest struct {
	Repo  string `json:"repo"`
	Base  string `json:"base"`
	Head  string `json:"head"`
	PR    int    `json:"pr"`    // the pull request's number, or 0 for a local branch
	Title string `json:"title"` // what the review is called on screen
	Model string `json:"model"`
}

// briefTask is the brief as a task for the runner. It reads the checkout and is kept per commits.
func briefTask(id string, req BriefRequest) (claudeTask, error) {
	if !commitID.MatchString(req.Base) {
		return claudeTask{}, fmt.Errorf("%q is not a commit id", req.Base)
	}
	return claudeTask{
		ID:        id,
		Kind:      "brief",
		Prompt:    briefPrompt,
		Schema:    briefSchema,
		Input:     func() (string, error) { return briefInput(req) },
		Model:     req.Model,
		BudgetUSD: briefBudgetUSD,
		Tools:     claudeReadTools,
		Repo:      req.Repo,
		Head:      req.Head,
		Cache: &cacheKey{
			Repo: req.Repo, Base: req.Base, Head: req.Head, Kind: "brief",
			Version: promptVersion(briefPrompt, briefSchema, briefInputVersion),
		},
	}, nil
}

// briefInput is what Claude reads on stdin: the description and the diff, each fenced as untrusted.
func briefInput(req BriefRequest) (string, error) {
	diff, err := scopeDiff(Scope{Repo: req.Repo, Base: req.Base, Head: req.Head}, nil, "")
	if err != nil {
		return "", err
	}
	return untrustedBlock("description", capText(describeChange(req), maxBriefText)) + "\n\n" +
		untrustedBlock("diff", capText(diff, maxBriefDiff)), nil
}

// describeChange is the pull request's title and body, or a branch's commit messages. Without
// them the brief still works from the diff, so a failure here leaves just the title.
func describeChange(req BriefRequest) string {
	if req.PR > 0 {
		out, err := runGH(req.Repo, "pr", "view", strconv.Itoa(req.PR), "--json", "title,body")
		var pr struct {
			Title string `json:"title"`
			Body  string `json:"body"`
		}
		if err == nil && json.Unmarshal(out, &pr) == nil {
			return pr.Title + "\n\n" + pr.Body
		}
		return req.Title
	}
	log, err := runGit(req.Repo, "log", "--format=%B", req.Base+".."+req.Head)
	if err != nil {
		return req.Title
	}
	return req.Title + "\n\n" + log
}

// untrustedBlock fences data for a prompt. The tag ends with a hash of the data, which the data
// cannot contain, so nothing inside can close the fence early.
func untrustedBlock(name, data string) string {
	sum := sha256.Sum256([]byte(data))
	tag := "untrusted-" + name + "-" + hex.EncodeToString(sum[:6])
	return "<" + tag + ">\n" + data + "\n</" + tag + ">"
}

// capText keeps the first max bytes of s and says how much it left out.
func capText(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + fmt.Sprintf("\n[%d more bytes left out; read the files in the working directory instead]", len(s)-max)
}
