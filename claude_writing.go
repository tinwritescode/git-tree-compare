package main

import (
	_ "embed"
	"errors"
	"fmt"
	"strings"
)

// Claude's help with the reviewer's own words: polishing a draft comment, drafting the review's
// summary, and drafting a pull request's title and body for a branch. Nothing here posts anything;
// the reviewer reads, edits and sends.

//go:embed prompts/polish.md
var polishPrompt string

//go:embed prompts/summary.md
var summaryPrompt string

//go:embed prompts/prdesc.md
var prDescriptionPrompt string

//go:embed schemas/prdesc.json
var prDescriptionSchema string

// maxDraft caps a draft comment sent to be polished.
const maxDraft = 8_000

// PolishRequest asks Claude to rewrite one draft comment.
type PolishRequest struct {
	Change ChangeRef `json:"change"`
	Body   string    `json:"body"`
}

// polishTask rewrites a draft with no tools: it needs only the words. Each polish asks again.
func polishTask(id string, req PolishRequest) (claudeTask, error) {
	body := strings.TrimSpace(req.Body)
	switch {
	case body == "":
		return claudeTask{}, errors.New("no draft to polish")
	case len(body) > maxDraft:
		return claudeTask{}, fmt.Errorf("a draft can be at most %d characters to polish", maxDraft)
	}
	return wordsTask(id, req.Change, "polish", polishPrompt, polishBudgetUSD, untrustedBlock("draft", body)), nil
}

// SummaryRequest asks Claude for the review's summary, from its verdict and draft comments.
type SummaryRequest struct {
	Change  ChangeRef     `json:"change"`
	Verdict string        `json:"verdict"` // COMMENT, APPROVE or REQUEST_CHANGES
	Drafts  []ReviewDraft `json:"drafts"`
}

// summaryTask drafts the review's summary with no tools. Each draft asks again.
func summaryTask(id string, req SummaryRequest) (claudeTask, error) {
	input, err := summaryInput(req.Verdict, req.Drafts)
	if err != nil {
		return claudeTask{}, err
	}
	return wordsTask(id, req.Change, "summary", summaryPrompt, summaryBudgetUSD, input), nil
}

// verdictWords is each verdict as the Finish sheet names it.
var verdictWords = map[string]string{"COMMENT": "Comment", "APPROVE": "Approve", "REQUEST_CHANGES": "Request changes"}

// summaryInput is the verdict, which the app sets, then the reviewer's drafts fenced as data.
func summaryInput(verdict string, drafts []ReviewDraft) (string, error) {
	words, ok := verdictWords[verdict]
	if !ok {
		return "", fmt.Errorf("unknown review verdict %q", verdict)
	}
	var b strings.Builder
	for _, d := range drafts {
		switch {
		case d.Kind == "file":
			fmt.Fprintf(&b, "%s (whole file)\n", d.Path)
		case d.Side == "LEFT":
			fmt.Fprintf(&b, "%s:%d (old side)\n", d.Path, d.Line)
		default:
			fmt.Fprintf(&b, "%s:%d\n", d.Path, d.Line)
		}
		b.WriteString(d.Body + "\n\n")
	}
	if len(drafts) == 0 {
		b.WriteString("No draft comments.")
	}
	return "Verdict: " + words + "\n\n" + untrustedBlock("drafts", capText(b.String(), maxBriefText)), nil
}

// wordsTask is a task that writes words from what is on stdin alone: no tools, nothing kept.
func wordsTask(id string, c ChangeRef, kind, prompt string, budget float64, input string) claudeTask {
	return claudeTask{
		ID:        id,
		Kind:      kind,
		Prompt:    prompt,
		Input:     func() (string, error) { return input, nil },
		Model:     c.Model,
		BudgetUSD: budget,
		Repo:      c.Repo,
		Head:      c.Head,
	}
}

// prDescriptionTask drafts a title and body for a pull request of the branch under review.
func prDescriptionTask(id string, req ChangeRef) (claudeTask, error) {
	return changeTask(id, req, changeAsk{Kind: "prdesc", Prompt: prDescriptionPrompt, Schema: prDescriptionSchema, BudgetUSD: prDescriptionBudgetUSD})
}
