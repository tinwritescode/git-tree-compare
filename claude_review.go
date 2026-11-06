package main

import (
	_ "embed"
	"errors"
	"fmt"
	"strings"
)

// Findings and the re-review: places Claude thinks deserve a comment, and, when a push landed
// after the reviewer's review, whether it answered their open threads.

//go:embed prompts/findings.md
var findingsPrompt string

//go:embed schemas/findings.json
var findingsSchema string

//go:embed prompts/rereview.md
var rereviewPrompt string

//go:embed schemas/rereview.json
var rereviewSchema string

// rereviewInputVersion changes when what goes on stdin changes, to miss answers made from the old input.
const rereviewInputVersion = "1"

// findingsTask asks for findings on the whole change. The frontend keeps only those on a line
// GitHub takes a comment on.
func findingsTask(id string, req ChangeRef) (claudeTask, error) {
	return changeTask(id, req, changeAsk{Kind: "findings", Prompt: findingsPrompt, Schema: findingsSchema, BudgetUSD: findingsBudgetUSD})
}

// SinceRange is a file a push changed after the reviewer marked it reviewed at From.
type SinceRange struct {
	Path string `json:"path"`
	From string `json:"from"`
}

// ThreadText is an open review thread as Claude reads it.
type ThreadText struct {
	ID       string      `json:"id"`
	Path     string      `json:"path"`
	Line     int         `json:"line"`
	Comments []PRComment `json:"comments"`
}

// RereviewRequest asks what changed since the reviewer's review, and whether it answers their threads.
type RereviewRequest struct {
	Change  ChangeRef    `json:"change"`
	PRURL   string       `json:"prUrl"` // where a reviewed commit the clone lacks is fetched from
	Since   []SinceRange `json:"since"`
	Threads []ThreadText `json:"threads"`
}

// rereviewTask is the re-review as a task for the runner. It is kept per commits, ranges and
// threads, so a new reply asks again.
func rereviewTask(id string, req RereviewRequest) (claudeTask, error) {
	c := req.Change
	if !commitID.MatchString(c.Base) {
		return claudeTask{}, fmt.Errorf("%q is not a commit id", c.Base)
	}
	if len(req.Since) == 0 {
		return claudeTask{}, errors.New("no file changed since your review")
	}
	for _, r := range req.Since {
		if r.Path == "" || !commitID.MatchString(r.From) {
			return claudeTask{}, fmt.Errorf("%q at %q is not a file and commit", r.Path, r.From)
		}
	}
	threads := threadsText(req.Threads)
	var subject strings.Builder
	for _, r := range req.Since {
		subject.WriteString(r.Path + "\x00" + r.From + "\x00")
	}
	subject.WriteString(threads)
	return claudeTask{
		ID:        id,
		Kind:      "rereview",
		Prompt:    rereviewPrompt,
		Schema:    rereviewSchema,
		Input:     func() (string, error) { return rereviewInput(req, threads) },
		Model:     c.Model,
		BudgetUSD: rereviewBudgetUSD,
		Tools:     claudeReadTools,
		Repo:      c.Repo,
		Head:      c.Head,
		Cache: &cacheKey{
			Repo: c.Repo, Base: c.Base, Head: c.Head, Kind: "rereview",
			Version: promptVersion(rereviewPrompt, rereviewSchema, rereviewInputVersion), Model: c.Model,
			Subject: subject.String(),
		},
		Refresh: c.Fresh,
	}, nil
}

// rereviewInput is the open threads and each file's diff since its review, each fenced as untrusted.
func rereviewInput(req RereviewRequest, threads string) (string, error) {
	c := req.Change
	var diffs strings.Builder
	for _, r := range req.Since {
		since, err := DiffSince(Scope{Repo: c.Repo, Base: c.Base, Head: c.Head}, r.From, r.Path, req.PRURL)
		if err != nil {
			return "", err
		}
		if !since.Found {
			fmt.Fprintf(&diffs, "%s: the commit it was reviewed at is gone, so this file's changes since then are unknown.\n", r.Path)
			continue
		}
		diffs.WriteString(since.Text)
	}
	return untrustedBlock("threads", capText(threads, maxBriefText)) + "\n\n" +
		untrustedBlock("since-diff", capText(diffs.String(), maxBriefDiff)), nil
}

// threadsText writes the threads as plain text: the id to answer with, the place, and who said what.
func threadsText(threads []ThreadText) string {
	if len(threads) == 0 {
		return "No open threads."
	}
	var b strings.Builder
	for _, t := range threads {
		fmt.Fprintf(&b, "Thread %s on %s:%d\n", t.ID, t.Path, t.Line)
		for _, c := range t.Comments {
			fmt.Fprintf(&b, "%s: %s\n", c.Author, c.Body)
		}
		b.WriteString("\n")
	}
	return b.String()
}
