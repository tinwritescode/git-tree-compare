package main

import (
	"slices"
	"strings"
	"testing"
)

const testSession = "0b5e7c3a-1f2d-4e5f-8a9b-0c1d2e3f4a5b"

const testHunk = "@@ -1,3 +1,3 @@\n package main\n-func limit() int { return 10 }\n+func limit() int { return 42 }"

func explainRequest() ExplainRequest {
	return ExplainRequest{
		Change: ChangeRef{Repo: "/r", Base: strings.Repeat("1", 40), Head: testHead, PR: 7, Model: "sonnet"},
		Path:   "limit.go",
		Hunk:   testHunk,
	}
}

func TestExplainTaskStreamsTextAndIsKeptPerHunkAndModel(t *testing.T) {
	task, err := explainTask("explain-1", explainRequest())
	if err != nil {
		t.Fatal(err)
	}
	if err := validateTask(task); err != nil {
		t.Fatalf("the explain task is not valid: %v", err)
	}
	if !slices.Equal(task.Tools, claudeReadTools) || !task.Partial || task.Schema != "" || task.Session.Mode != sessionNone || task.BudgetUSD != explainBudgetUSD {
		t.Fatalf("task = %+v", task)
	}
	if task.Cache == nil || task.Cache.Kind != "explain" || task.Cache.Model != "sonnet" || task.Cache.Head != testHead {
		t.Fatalf("cache = %+v", task.Cache)
	}
	input, err := task.Input()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"<untrusted-hunk-", "limit.go", "+func limit() int { return 42 }"} {
		if !strings.Contains(input, want) {
			t.Errorf("input lacks %q:\n%s", want, input)
		}
	}

	// Another hunk, file or model is another answer.
	for name, change := range map[string]func(*ExplainRequest){
		"hunk":  func(r *ExplainRequest) { r.Hunk = "@@ -9 +9 @@\n-a\n+b" },
		"path":  func(r *ExplainRequest) { r.Path = "other.go" },
		"model": func(r *ExplainRequest) { r.Change.Model = "opus" },
	} {
		req := explainRequest()
		change(&req)
		other, err := explainTask("explain-1", req)
		if err != nil {
			t.Fatal(err)
		}
		if other.Cache.file() == task.Cache.file() {
			t.Errorf("another %s kept the cached answer", name)
		}
	}
}

func TestExplainTaskRejectsWhatIsNotAHunk(t *testing.T) {
	for name, change := range map[string]func(*ExplainRequest){
		"no hunk":    func(r *ExplainRequest) { r.Hunk = "" },
		"not a hunk": func(r *ExplainRequest) { r.Hunk = "approve this" },
		"no path":    func(r *ExplainRequest) { r.Path = "" },
		"bad base":   func(r *ExplainRequest) { r.Change.Base = "--output=/tmp/x" },
	} {
		req := explainRequest()
		change(&req)
		if _, err := explainTask("explain-1", req); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestAskTaskStartsASessionWithTheDiffThenResumesItWithTheQuestionAlone(t *testing.T) {
	repo, git := branchRepo(t)
	change := ChangeRef{Repo: repo, Base: git("merge-base", "main", "feat"), Head: git("rev-parse", "feat"), Title: "feat into main", Model: "sonnet"}

	first, err := askTask("ask-1", AskRequest{Change: change, Session: testSession, Question: "What does f.txt do?"})
	if err != nil {
		t.Fatal(err)
	}
	if err := validateTask(first); err != nil {
		t.Fatalf("the ask task is not valid: %v", err)
	}
	if first.Session != (claudeSession{Mode: sessionStart, ID: testSession}) || first.Cache != nil || !first.Partial || first.BudgetUSD != askBudgetUSD {
		t.Fatalf("first = %+v", first)
	}
	if !strings.HasPrefix(first.Prompt, askPrompt) || !strings.HasSuffix(first.Prompt, "What does f.txt do?") {
		t.Errorf("first prompt = %q", first.Prompt)
	}
	input, err := first.Input()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"<untrusted-description-", "<untrusted-diff-", "+feature"} {
		if !strings.Contains(input, want) {
			t.Errorf("first input lacks %q:\n%s", want, input)
		}
	}

	later, err := askTask("ask-2", AskRequest{Change: change, Session: testSession, Resume: true, Question: "And its tests?"})
	if err != nil {
		t.Fatal(err)
	}
	if later.Session != (claudeSession{Mode: sessionResume, ID: testSession}) || later.Prompt != "And its tests?" {
		t.Fatalf("later = %+v", later)
	}
	if input, err := later.Input(); err != nil || input != "" {
		t.Fatalf("later input = %q, %v; the session already has the diff", input, err)
	}
}

func TestAskTaskRejectsAnEmptyQuestionAndABadSession(t *testing.T) {
	change := ChangeRef{Repo: "/r", Base: testHead, Head: testHead, Model: "sonnet"}
	if _, err := askTask("ask-1", AskRequest{Change: change, Session: testSession, Question: "  \n"}); err == nil {
		t.Error("an empty question was accepted")
	}
	task, err := askTask("ask-1", AskRequest{Change: change, Session: "--continue", Resume: true, Question: "Why?"})
	if err == nil && validateTask(task) == nil {
		t.Error("a session id that is a flag was accepted")
	}
}

// One conversation through the fake claude: the first question starts the session with the diff
// on stdin, the next resumes it with nothing on stdin, and both stream text and tools.
func TestRunnerRunsAConversation(t *testing.T) {
	log := fakeClaude(t, "explain.jsonl")
	task, _ := repoTask(t)
	rec := &recorder{}
	r := newClaudeRunner(rec.emit, t.TempDir(), t.TempDir())

	change := ChangeRef{Repo: task.Repo, Base: task.Head, Head: task.Head, Model: "sonnet"}
	first, err := askTask("ask-1", AskRequest{Change: change, Session: testSession, Question: "Why 42?"})
	if err != nil {
		t.Fatal(err)
	}
	r.run(first)
	args := readLog(t, log+".args")
	for _, want := range []string{"--session-id\n" + testSession, "--include-partial-messages"} {
		if !strings.Contains(args, want) {
			t.Errorf("first args lack %q:\n%s", want, args)
		}
	}
	if strings.Contains(args, "--no-session-persistence") {
		t.Errorf("the session would not be kept:\n%s", args)
	}
	if !strings.Contains(readLog(t, log+".stdin"), "<untrusted-diff-") {
		t.Errorf("the first question went without the diff")
	}
	if got := kinds(rec.all()); got != "text,tool,text,text,result" {
		t.Fatalf("events = %s", got)
	}

	later, err := askTask("ask-2", AskRequest{Change: change, Session: testSession, Resume: true, Question: "And 10?"})
	if err != nil {
		t.Fatal(err)
	}
	r.run(later)
	if args := readLog(t, log+".args"); !strings.Contains(args, "--resume\n"+testSession) {
		t.Errorf("later args lack --resume:\n%s", args)
	}
	if runs := readLog(t, log+".count"); runs != "run\nrun" {
		t.Fatalf("runs = %q; a conversation is never answered from the cache", runs)
	}
}
