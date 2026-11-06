package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func testChange() ChangeRef {
	return ChangeRef{Repo: "/r", Base: strings.Repeat("1", 40), Head: testHead, PR: 7, Title: "Fix", Model: "sonnet"}
}

// Findings and the PR description read the whole change as the brief does, each kept under its own kind.
func TestFindingsAndPRDescriptionReadTheWholeChange(t *testing.T) {
	req := testChange()
	for _, tc := range []struct {
		kind   string
		build  func(string, ChangeRef) (claudeTask, error)
		budget float64
	}{
		{"findings", findingsTask, findingsBudgetUSD},
		{"prdesc", prDescriptionTask, prDescriptionBudgetUSD},
	} {
		task, err := tc.build("t-1", req)
		if err != nil {
			t.Fatal(err)
		}
		if err := validateTask(task); err != nil {
			t.Fatalf("%s: %v", tc.kind, err)
		}
		if task.Kind != tc.kind || task.BudgetUSD != tc.budget || len(task.Tools) != 3 || !json.Valid([]byte(task.Schema)) {
			t.Fatalf("%s task = %+v", tc.kind, task)
		}
		if task.Cache == nil || task.Cache.Kind != tc.kind || task.Cache.Model != "sonnet" || task.Cache.Head != testHead {
			t.Fatalf("%s cache = %+v", tc.kind, task.Cache)
		}
		bad := req
		bad.Base = "--output=/tmp/x"
		if _, err := tc.build("t-1", bad); err == nil {
			t.Fatalf("%s took a base that is not a commit id", tc.kind)
		}
	}
}

// featRepo is a repository whose branch feat has two commits after main, touching f.txt twice and g.txt once.
func featRepo(t *testing.T) (repo, base, first, head string) {
	t.Helper()
	repo = t.TempDir()
	git := gitIn(t, repo)
	git("init", "-q", "-b", "main")
	writeFile(t, repo+"/f.txt", "one\n")
	writeFile(t, repo+"/g.txt", "keep\n")
	git("add", ".")
	git("commit", "-q", "-m", "first")
	base = git("rev-parse", "HEAD")
	git("checkout", "-q", "-b", "feat")
	writeFile(t, repo+"/f.txt", "one\nreviewed-line\n")
	writeFile(t, repo+"/g.txt", "keep\nearly-g\n")
	git("commit", "-q", "-am", "reviewed")
	first = git("rev-parse", "HEAD")
	writeFile(t, repo+"/f.txt", "one\nreviewed-line\nnew-since\n")
	git("commit", "-q", "-am", "after review")
	head = git("rev-parse", "HEAD")
	return repo, base, first, head
}

// The re-review reads only what changed after the reviewed head, and the open threads, all fenced.
func TestRereviewInputHasTheChangesSinceTheReviewAndTheThreads(t *testing.T) {
	repo, base, first, head := featRepo(t)
	req := RereviewRequest{
		Change:  ChangeRef{Repo: repo, Base: base, Head: head, PR: 3, Model: defaultClaudeModel},
		Since:   []SinceRange{{Path: "f.txt", From: first}},
		Threads: []ThreadText{{ID: "PRRT_1", Path: "f.txt", Line: 2, Comments: []PRComment{{Author: "ann", Body: "Please handle the empty case"}}}},
	}
	task, err := rereviewTask("rr-1", req)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateTask(task); err != nil {
		t.Fatal(err)
	}
	input, err := task.Input()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"<untrusted-threads-", "PRRT_1", "f.txt:2", "ann: Please handle the empty case", "<untrusted-since-diff-", "+new-since"} {
		if !strings.Contains(input, want) {
			t.Errorf("input lacks %q:\n%s", want, input)
		}
	}
	for _, unwanted := range []string{"+reviewed-line", "early-g"} {
		if strings.Contains(input, unwanted) {
			t.Errorf("input has %q, which the reviewer already saw:\n%s", unwanted, input)
		}
	}
	if task.Cache == nil || task.Cache.Kind != "rereview" || task.Cache.Subject == "" {
		t.Fatalf("cache = %+v", task.Cache)
	}
	// A new reply on a thread asks again.
	req.Threads[0].Comments = append(req.Threads[0].Comments, PRComment{Author: "bob", Body: "Done"})
	again, _ := rereviewTask("rr-1", req)
	if again.Cache.file() == task.Cache.file() {
		t.Error("a new reply kept the old answer")
	}

	for _, bad := range []RereviewRequest{
		{Change: req.Change},
		{Change: req.Change, Since: []SinceRange{{Path: "f.txt", From: "--all"}}},
		{Change: req.Change, Since: []SinceRange{{Path: "", From: first}}},
	} {
		if _, err := rereviewTask("rr-1", bad); err == nil {
			t.Errorf("accepted %+v", bad.Since)
		}
	}
}

// Polish and the review summary write words, not code: Claude gets no tools and keeps nothing.
func TestPolishAndSummaryRunWithoutTools(t *testing.T) {
	polish, err := polishTask("p-1", PolishRequest{Change: testChange(), Body: "this is wrong fix it"})
	if err != nil {
		t.Fatal(err)
	}
	summary, err := summaryTask("s-1", SummaryRequest{Change: testChange(), Verdict: "APPROVE"})
	if err != nil {
		t.Fatal(err)
	}
	for _, task := range []claudeTask{polish, summary} {
		if err := validateTask(task); err != nil {
			t.Fatal(err)
		}
		args := strings.Join(claudeArgs(task), "\x00")
		if len(task.Tools) != 0 || !strings.Contains(args, "--tools\x00\x00") || task.Schema != "" || task.Cache != nil {
			t.Fatalf("%s task = %+v", task.Kind, task)
		}
	}
	input, _ := polish.Input()
	if !strings.Contains(input, "<untrusted-draft-") || !strings.Contains(input, "this is wrong fix it") {
		t.Errorf("polish input = %q", input)
	}
	if _, err := polishTask("p-1", PolishRequest{Change: testChange(), Body: "  "}); err == nil {
		t.Error("polished a blank draft")
	}
	if _, err := polishTask("p-1", PolishRequest{Change: testChange(), Body: strings.Repeat("d", maxDraft)}); err != nil {
		t.Errorf("a draft of the largest size was rejected: %v", err)
	}
	if _, err := polishTask("p-1", PolishRequest{Change: testChange(), Body: strings.Repeat("d", maxDraft+1)}); err == nil {
		t.Error("polished a draft over the largest size")
	}
	if _, err := summaryTask("s-1", SummaryRequest{Change: testChange(), Verdict: "MERGE"}); err == nil {
		t.Error("took an unknown verdict")
	}
}

func TestSummaryInputNamesTheVerdictAndEveryDraft(t *testing.T) {
	got, err := summaryInput("REQUEST_CHANGES", []ReviewDraft{
		{Kind: "line", Path: "limit.go", Line: 12, Side: "RIGHT", Body: "This can overflow."},
		{Kind: "line", Path: "limit.go", Line: 3, Side: "LEFT", Body: "Why was this check removed?"},
		{Kind: "file", Path: "README.md", Body: "Document the flag."},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"Verdict: Request changes",
		"<untrusted-drafts-",
		"limit.go:12\nThis can overflow.",
		"limit.go:3 (old side)\nWhy was this check removed?",
		"README.md (whole file)\nDocument the flag.",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("input lacks %q:\n%s", want, got)
		}
	}
	none, _ := summaryInput("APPROVE", nil)
	if !strings.Contains(none, "Verdict: Approve") || !strings.Contains(none, "No draft comments.") {
		t.Errorf("input without drafts = %q", none)
	}
}

// A findings answer passes through the runner as Claude wrote it; the frontend checks it.
func TestRunnerReturnsFindingsAsWritten(t *testing.T) {
	fakeClaude(t, "findings.jsonl")
	repo, base, _, head := featRepo(t)
	task, err := findingsTask("findings-1", ChangeRef{Repo: repo, Base: base, Head: head, Model: defaultClaudeModel})
	if err != nil {
		t.Fatal(err)
	}
	rec := &recorder{}
	newClaudeRunner(rec.emit, "", t.TempDir()).run(task)
	got := rec.all()
	if kinds(got) != "tool,result" {
		t.Fatalf("events = %+v", got)
	}
	var answer struct {
		Findings []struct {
			Path string `json:"path"`
			Line int    `json:"line"`
			Kind string `json:"kind"`
		} `json:"findings"`
	}
	if err := json.Unmarshal(got[1].JSON, &answer); err != nil || len(answer.Findings) != 2 || answer.Findings[0].Path != "f.txt" || answer.Findings[0].Kind != "bug" {
		t.Fatalf("answer = %s (%v)", got[1].JSON, err)
	}
}
