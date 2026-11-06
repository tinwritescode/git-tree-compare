package main

import (
	_ "embed"
	"errors"
	"fmt"
	"strings"
)

// Explain and Ask: Claude's words on one hunk, and a conversation about the change. Both stream
// their text as Claude writes it.

//go:embed prompts/explain.md
var explainPrompt string

//go:embed prompts/ask.md
var askPrompt string

const (
	// explainInputVersion changes when what goes on stdin changes, to miss explanations made from the old input.
	explainInputVersion = "1"
	// maxHunk caps a hunk sent on stdin: a file shown whole is one hunk. Claude reads the rest from the checkout.
	maxHunk     = 40_000
	maxQuestion = 8_000
)

// ExplainRequest asks Claude to explain one hunk of a file in the change.
type ExplainRequest struct {
	Change ChangeRef `json:"change"`
	Path   string    `json:"path"`
	Hunk   string    `json:"hunk"` // as the diff shows it, from its @@ header on
}

// explainTask is an explanation as a task for the runner. It is kept per commits, file, hunk and model.
func explainTask(id string, req ExplainRequest) (claudeTask, error) {
	c := req.Change
	switch {
	case !commitID.MatchString(c.Base):
		return claudeTask{}, fmt.Errorf("%q is not a commit id", c.Base)
	case req.Path == "":
		return claudeTask{}, errors.New("no file to explain")
	case !strings.HasPrefix(req.Hunk, "@@"):
		return claudeTask{}, errors.New("no hunk to explain")
	}
	input := untrustedBlock("hunk", "File: "+req.Path+"\n\n"+capText(req.Hunk, maxHunk))
	return claudeTask{
		ID:        id,
		Kind:      "explain",
		Prompt:    explainPrompt,
		Input:     func() (string, error) { return input, nil },
		Model:     c.Model,
		BudgetUSD: explainBudgetUSD,
		Tools:     claudeReadTools,
		Partial:   true,
		Repo:      c.Repo,
		Head:      c.Head,
		Cache: &cacheKey{
			Repo: c.Repo, Base: c.Base, Head: c.Head, Kind: "explain",
			Version: promptVersion(explainPrompt, explainInputVersion), Model: c.Model,
			Subject: req.Path + "\x00" + req.Hunk,
		},
		Refresh: c.Fresh,
	}, nil
}

// AskRequest is one question in a conversation about the change.
type AskRequest struct {
	Change   ChangeRef `json:"change"`
	Session  string    `json:"session"` // the conversation's UUID, made by the frontend
	Resume   bool      `json:"resume"`  // a later question: the session already holds the diff
	Question string    `json:"question"`
}

// askTask is a question as a task for the runner. The first one starts the session and sends the
// description and diff; later ones resume it with the question alone. Answers are never kept.
func askTask(id string, req AskRequest) (claudeTask, error) {
	c := req.Change
	question := strings.TrimSpace(req.Question)
	switch {
	case !commitID.MatchString(c.Base):
		return claudeTask{}, fmt.Errorf("%q is not a commit id", c.Base)
	case question == "":
		return claudeTask{}, errors.New("no question to ask")
	case len(question) > maxQuestion:
		return claudeTask{}, fmt.Errorf("a question can be at most %d characters", maxQuestion)
	}
	task := claudeTask{
		ID:        id,
		Kind:      "ask",
		Prompt:    askPrompt + question,
		Input:     func() (string, error) { return changeInput(c) },
		Model:     c.Model,
		BudgetUSD: askBudgetUSD,
		Tools:     claudeReadTools,
		Partial:   true,
		Session:   claudeSession{Mode: sessionStart, ID: req.Session},
		Repo:      c.Repo,
		Head:      c.Head,
	}
	if req.Resume {
		task.Prompt = question
		task.Input = func() (string, error) { return "", nil }
		task.Session.Mode = sessionResume
	}
	return task, nil
}
