package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testHead = "0123456789abcdef0123456789abcdef01234567"

func TestReviewRequestJSONMapsDrafts(t *testing.T) {
	out, err := reviewRequestJSON(ReviewSubmission{
		Head:  testHead,
		Event: "REQUEST_CHANGES",
		Body:  "Two things.",
		Drafts: []ReviewDraft{
			{Kind: "line", Path: "app.go", Line: 12, Side: "RIGHT", Body: "rename this"},
			{Kind: "line", Path: "old.go", Line: 3, Side: "LEFT", Body: "why remove?"},
			{Kind: "file", Path: "go.mod", Body: "bump separately"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"commit_id":"` + testHead + `","event":"REQUEST_CHANGES","body":"Two things.","comments":[` +
		`{"path":"app.go","line":12,"side":"RIGHT","body":"rename this"},` +
		`{"path":"old.go","line":3,"side":"LEFT","body":"why remove?"},` +
		`{"path":"go.mod","subject_type":"file","body":"bump separately"}]}`
	if string(out) != want {
		t.Fatalf("got  %s\nwant %s", out, want)
	}
}

func TestReviewRequestJSONWithoutDrafts(t *testing.T) {
	out, err := reviewRequestJSON(ReviewSubmission{Head: testHead, Event: "APPROVE"})
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	comments, ok := got["comments"].([]any)
	if !ok || len(comments) != 0 {
		t.Fatalf("comments must be an empty list, not null: %s", out)
	}
	if got["body"] != "" || got["event"] != "APPROVE" {
		t.Fatalf("got %s", out)
	}
}

func TestReviewRequestJSONRejectsBadInput(t *testing.T) {
	line := ReviewDraft{Kind: "line", Path: "a.go", Line: 1, Side: "RIGHT", Body: "x"}
	if _, err := reviewRequestJSON(ReviewSubmission{Head: testHead, Event: "COMMENT", Drafts: []ReviewDraft{line}}); err != nil {
		t.Fatalf("a comment on line 1 was rejected: %v", err)
	}
	cases := map[string]ReviewSubmission{
		"short head":    {Head: "abc123", Event: "COMMENT", Drafts: []ReviewDraft{line}},
		"unknown event": {Head: testHead, Event: "PENDING", Drafts: []ReviewDraft{line}},
		"line zero":     {Head: testHead, Event: "COMMENT", Drafts: []ReviewDraft{{Kind: "line", Path: "a.go", Side: "RIGHT", Body: "x"}}},
		"bad side":      {Head: testHead, Event: "COMMENT", Drafts: []ReviewDraft{{Kind: "line", Path: "a.go", Line: 1, Side: "NEW", Body: "x"}}},
		"blank body":    {Head: testHead, Event: "COMMENT", Drafts: []ReviewDraft{{Kind: "file", Path: "a.go", Body: "  \n"}}},
		"no path":       {Head: testHead, Event: "COMMENT", Drafts: []ReviewDraft{{Kind: "file", Body: "x"}}},
		"unknown kind":  {Head: testHead, Event: "COMMENT", Drafts: []ReviewDraft{{Kind: "hunk", Path: "a.go", Body: "x"}}},
	}
	for name, s := range cases {
		if _, err := reviewRequestJSON(s); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

func TestReviewsEndpoint(t *testing.T) {
	got, err := reviewsEndpoint("https://github.com/cli/cli/pull/14960")
	if err != nil || got != "repos/cli/cli/pulls/14960/reviews" {
		t.Fatalf("got %q, %v", got, err)
	}
	for _, bad := range []string{
		"https://github.com/cli/cli/issues/3",
		"https://github.com/cli/cli/pull/0",
		"https://github.com/cli/cli/pull/3/files",
		"https://github.com/-x/cli/pull/3",
		"https://example.com/cli/cli/pull/3",
		"",
	} {
		if got, err := reviewsEndpoint(bad); err == nil {
			t.Errorf("%q: want an error, got %q", bad, got)
		}
	}
}

func TestThreadMutations(t *testing.T) {
	if q := resolveMutation(true); !strings.Contains(q, "resolveReviewThread(input: {threadId: $id})") || strings.Contains(q, "unresolve") {
		t.Fatalf("resolve = %s", q)
	}
	if q := resolveMutation(false); !strings.Contains(q, "unresolveReviewThread(input: {threadId: $id})") {
		t.Fatalf("unresolve = %s", q)
	}
	if !strings.Contains(replyMutation, "pullRequestReviewThreadId: $id") || !strings.Contains(replyMutation, "body: $body") {
		t.Fatalf("reply = %s", replyMutation)
	}
}

func TestThreadInputChecks(t *testing.T) {
	if err := ReplyToThread(".", "", "hi"); err == nil {
		t.Error("a reply without a thread id must fail before gh runs")
	}
	if err := ReplyToThread(".", "PRRT_x", "  "); err == nil {
		t.Error("an empty reply must fail before gh runs")
	}
	if err := SetThreadResolved(".", "", true); err == nil {
		t.Error("resolving without a thread id must fail before gh runs")
	}
}

// A stand-in gh on PATH records what SubmitReview sends, so the request reaches gh on stdin
// exactly as built, and a failure carries what gh printed.
func TestSubmitReviewSendsTheRequestOnStdin(t *testing.T) {
	dir := t.TempDir()
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$GH_ARGS\"\ncat > \"$GH_STDIN\"\n[ -z \"$GH_FAIL\" ] || { echo 'Validation Failed (HTTP 422)' >&2; exit 1; }\n"
	if err := os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("GH_ARGS", filepath.Join(dir, "args"))
	t.Setenv("GH_STDIN", filepath.Join(dir, "stdin"))

	s := ReviewSubmission{Head: testHead, Event: "COMMENT", Body: "ok", Drafts: []ReviewDraft{{Kind: "file", Path: "a.go", Body: "x"}}}
	if err := SubmitReview(dir, "https://github.com/o/r/pull/7", s); err != nil {
		t.Fatal(err)
	}
	args, _ := os.ReadFile(filepath.Join(dir, "args"))
	if got := strings.Fields(string(args)); strings.Join(got, " ") != "api repos/o/r/pulls/7/reviews --method POST --input -" {
		t.Fatalf("args = %q", got)
	}
	stdin, _ := os.ReadFile(filepath.Join(dir, "stdin"))
	want, _ := reviewRequestJSON(s)
	if string(stdin) != string(want) {
		t.Fatalf("stdin = %s\nwant %s", stdin, want)
	}

	t.Setenv("GH_FAIL", "1")
	err := SubmitReview(dir, "https://github.com/o/r/pull/7", s)
	if err == nil || !strings.Contains(err.Error(), "Validation Failed") {
		t.Fatalf("err = %v, want GitHub's message", err)
	}
}
