package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

// ReviewDraft is one comment of a pending review, as the frontend keeps it until the review is
// submitted. Kind is "line" or "file"; Line and Side apply to line comments only.
type ReviewDraft struct {
	Kind string `json:"kind"`
	Path string `json:"path"`
	Line int    `json:"line"`
	Side string `json:"side"` // RIGHT for the head, LEFT for the base
	Body string `json:"body"`
}

// ReviewSubmission is a finished review: the verdict, the summary, and the drafts, posted at Head.
type ReviewSubmission struct {
	Head   string        `json:"head"`
	Event  string        `json:"event"` // COMMENT, APPROVE or REQUEST_CHANGES
	Body   string        `json:"body"`
	Drafts []ReviewDraft `json:"drafts"`
}

// reviewComment is one entry of comments[] in GitHub's create-review request.
type reviewComment struct {
	Path        string `json:"path"`
	Line        int    `json:"line,omitempty"`
	Side        string `json:"side,omitempty"`
	SubjectType string `json:"subject_type,omitempty"`
	Body        string `json:"body"`
}

var reviewEvents = map[string]bool{"COMMENT": true, "APPROVE": true, "REQUEST_CHANGES": true}

// reviewRequestJSON builds the body of POST repos/{owner}/{repo}/pulls/{n}/reviews. It checks the
// shape only; which verdicts need a summary is the frontend's call, and GitHub has the last word.
func reviewRequestJSON(s ReviewSubmission) ([]byte, error) {
	if !commitID.MatchString(s.Head) {
		return nil, fmt.Errorf("%q is not a commit id", s.Head)
	}
	if !reviewEvents[s.Event] {
		return nil, fmt.Errorf("unknown review verdict %q", s.Event)
	}
	comments := make([]reviewComment, 0, len(s.Drafts))
	for _, d := range s.Drafts {
		c, err := draftComment(d)
		if err != nil {
			return nil, err
		}
		comments = append(comments, c)
	}
	return json.Marshal(struct {
		CommitID string          `json:"commit_id"`
		Event    string          `json:"event"`
		Body     string          `json:"body"`
		Comments []reviewComment `json:"comments"`
	}{s.Head, s.Event, s.Body, comments})
}

// draftComment turns one draft into its place in comments[].
func draftComment(d ReviewDraft) (reviewComment, error) {
	if d.Path == "" || strings.TrimSpace(d.Body) == "" {
		return reviewComment{}, fmt.Errorf("a draft comment needs a file and some text")
	}
	switch d.Kind {
	case "line":
		if d.Line < 1 || (d.Side != "LEFT" && d.Side != "RIGHT") {
			return reviewComment{}, fmt.Errorf("draft on %s has no valid line", d.Path)
		}
		return reviewComment{Path: d.Path, Line: d.Line, Side: d.Side, Body: d.Body}, nil
	case "file":
		return reviewComment{Path: d.Path, SubjectType: "file", Body: d.Body}, nil
	default:
		return reviewComment{}, fmt.Errorf("unknown draft kind %q", d.Kind)
	}
}

// reviewsEndpoint is the REST path for a pull request's reviews, from its GitHub URL.
func reviewsEndpoint(prURL string) (string, error) {
	slug, number, ok := parsePRURL(prURL)
	if !ok {
		return "", fmt.Errorf("%q is not a pull request on GitHub", prURL)
	}
	return fmt.Sprintf("repos/%s/pulls/%d/reviews", slug, number), nil
}

// SubmitReview posts the review with all its drafts in one request. Nothing is posted when the
// request cannot be built; when GitHub refuses it, the error says why and nothing was posted.
func SubmitReview(repo, prURL string, s ReviewSubmission) error {
	endpoint, err := reviewsEndpoint(prURL)
	if err != nil {
		return err
	}
	body, err := reviewRequestJSON(s)
	if err != nil {
		return err
	}
	_, err = runGHInput(repo, body, "api", endpoint, "--method", "POST", "--input", "-")
	return err
}
