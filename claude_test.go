package main

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func testTask() claudeTask {
	return claudeTask{
		ID:        "brief-1",
		Kind:      "brief",
		Prompt:    "--help me read this",
		Schema:    `{"type":"object"}`,
		Input:     func() (string, error) { return "the diff", nil },
		Model:     defaultClaudeModel,
		BudgetUSD: 2,
		Tools:     []string{"Read", "Grep", "Glob"},
		Repo:      "/r",
		Head:      testHead,
	}
}

func TestClaudeArgs(t *testing.T) {
	got := claudeArgs(testTask())
	want := []string{
		"-p", "--model", "claude-opus-5-5", "--tools", "Read", "Grep", "Glob",
		"--strict-mcp-config", "--restricted", "--safe-mode",
		"--output-format", "stream-json", "--verbose", "--max-budget-usd", "2.00",
		"--json-schema", `{"type":"object"}`, "--no-session-persistence",
		"--", "--help me read this",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
}

func TestClaudeArgsWithoutToolsWithPartialMessagesAndSessions(t *testing.T) {
	task := testTask()
	task.Tools = nil
	task.Schema = ""
	task.Partial = true
	task.Session = claudeSession{Mode: sessionStart, ID: "0b5e7c3a-1f2d-4e5f-8a9b-0c1d2e3f4a5b"}
	got := strings.Join(claudeArgs(task), " ")
	for _, part := range []string{"--tools  --strict-mcp-config", "--include-partial-messages", "--session-id 0b5e7c3a-1f2d-4e5f-8a9b-0c1d2e3f4a5b --"} {
		if !strings.Contains(got, part) {
			t.Errorf("%q lacks %q", got, part)
		}
	}
	if strings.Contains(got, "--json-schema") || strings.Contains(got, "--no-session-persistence") {
		t.Errorf("unexpected flags in %q", got)
	}
	task.Session.Mode = sessionResume
	if got := strings.Join(claudeArgs(task), " "); !strings.Contains(got, "--resume 0b5e7c3a-1f2d-4e5f-8a9b-0c1d2e3f4a5b --") {
		t.Errorf("resume: %q", got)
	}
}

func TestValidateTaskRejectsWhatCouldReachClaudeAsAFlag(t *testing.T) {
	cases := map[string]func(*claudeTask){
		"id with a slash":   func(c *claudeTask) { c.ID = "../x" },
		"model as a flag":   func(c *claudeTask) { c.Model = "--dangerously-skip-permissions" },
		"model with spaces": func(c *claudeTask) { c.Model = "opus sonnet" },
		"a tool that runs":  func(c *claudeTask) { c.Tools = []string{"Read", "Bash"} },
		"no budget":         func(c *claudeTask) { c.BudgetUSD = 0 },
		"a session id flag": func(c *claudeTask) { c.Session = claudeSession{Mode: sessionResume, ID: "--continue"} },
		"short head":        func(c *claudeTask) { c.Repo, c.Head = "/r", "abc" },
	}
	for name, change := range cases {
		task := testTask()
		change(&task)
		if err := validateTask(task); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if err := validateTask(testTask()); err != nil {
		t.Fatalf("a good task was rejected: %v", err)
	}
}

func TestCacheKeyChangesWithEachPart(t *testing.T) {
	base := cacheKey{Repo: "/r", Base: testHead, Head: testHead, Kind: "brief", Version: "v1", Model: "opus", Subject: "a.go"}
	if base.file() != base.file() {
		t.Fatal("the key is not stable")
	}
	changes := []func(*cacheKey){
		func(k *cacheKey) { k.Repo = "/s" },
		func(k *cacheKey) { k.Base = strings.Repeat("1", 40) },
		func(k *cacheKey) { k.Head = strings.Repeat("2", 40) },
		func(k *cacheKey) { k.Kind = "findings" },
		func(k *cacheKey) { k.Version = "v2" },
		func(k *cacheKey) { k.Model = "sonnet" },
		func(k *cacheKey) { k.Subject = "b.go" },
	}
	for i, change := range changes {
		k := base
		change(&k)
		if k.file() == base.file() {
			t.Errorf("change %d kept the key", i)
		}
	}
}

// fakeClaude puts the stand-in claude on PATH, printing the fixture, and returns the prefix of
// the files it records its calls in.
func fakeClaude(t *testing.T, fixture string) (log string) {
	t.Helper()
	dir := t.TempDir()
	script, err := os.ReadFile("testdata/claude/fake-claude")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "claude"), script, 0o755); err != nil {
		t.Fatal(err)
	}
	abs, err := filepath.Abs("testdata/claude/" + fixture)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("CLAUDE_FIXTURE", abs)
	log = filepath.Join(dir, "call")
	t.Setenv("CLAUDE_LOG", log)
	return log
}

// recorder collects what a runner emits.
type recorder struct {
	mu     sync.Mutex
	events []ClaudeEvent
}

func (rec *recorder) emit(id string, ev ClaudeEvent) {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	rec.events = append(rec.events, ev)
}

func (rec *recorder) all() []ClaudeEvent {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return append([]ClaudeEvent(nil), rec.events...)
}

func kinds(events []ClaudeEvent) string {
	var out []string
	for _, ev := range events {
		out = append(out, ev.Kind)
	}
	return strings.Join(out, ",")
}

// repoTask makes a repository with one commit and a task that runs at it.
func repoTask(t *testing.T) (claudeTask, string) {
	t.Helper()
	repo := t.TempDir()
	git := gitIn(t, repo)
	git("init", "-q", "-b", "main")
	writeFile(t, repo+"/limit.go", "package main\n")
	git("add", ".")
	git("commit", "-q", "-m", "first")
	task := testTask()
	task.Repo, task.Head = repo, git("rev-parse", "HEAD")
	return task, repo
}

func readLog(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(b))
}

func TestRunnerRunsClaudeInAWorktreeAtHeadAndCachesTheResult(t *testing.T) {
	log := fakeClaude(t, "brief.jsonl")
	task, repo := repoTask(t)
	task.Cache = &cacheKey{Repo: repo, Base: task.Head, Head: task.Head, Kind: "brief", Version: "v1"}
	rec := &recorder{}
	r := newClaudeRunner(rec.emit, t.TempDir(), t.TempDir())

	r.run(task)
	got := rec.all()
	if kinds(got) != "tool,tool,result" || string(got[2].JSON) != `{"word":"banana","limit":42}` {
		t.Fatalf("events = %+v", got)
	}
	if readLog(t, log+".stdin") != "the diff" {
		t.Errorf("stdin = %q", readLog(t, log+".stdin"))
	}
	if args := readLog(t, log+".args"); !strings.HasSuffix(args, "--\n--help me read this") {
		t.Errorf("args end %q", args)
	}
	wt := readLog(t, log+".pwd")
	if head := strings.TrimSpace(gitIn(t, wt)("rev-parse", "HEAD")); head != task.Head {
		t.Errorf("claude ran at %s, want the head %s", head, task.Head)
	}
	if _, err := os.Stat(filepath.Join(wt, "limit.go")); err != nil {
		t.Errorf("the worktree lacks the head's files: %v", err)
	}

	// The same task again is answered from the cache, without running claude.
	rec2 := &recorder{}
	r.emit = rec2.emit
	r.run(task)
	if again := rec2.all(); len(again) != 1 || !reflect.DeepEqual(again[0], got[2]) {
		t.Fatalf("cached events = %+v", again)
	}
	if runs := readLog(t, log+".count"); runs != "run" {
		t.Fatalf("claude ran again: %q", runs)
	}
}

// Re-running asks Claude again even when an answer is kept, and keeps the new answer.
func TestRunnerRefreshSkipsTheKeptAnswerAndKeepsTheNewOne(t *testing.T) {
	log := fakeClaude(t, "brief.jsonl")
	task, repo := repoTask(t)
	task.Cache = &cacheKey{Repo: repo, Head: task.Head, Kind: "brief", Version: "v1"}
	rec := &recorder{}
	r := newClaudeRunner(rec.emit, t.TempDir(), t.TempDir())
	r.run(task)
	task.Refresh = true
	r.run(task)
	task.Refresh = false
	r.run(task)
	if runs := readLog(t, log+".count"); runs != "run\nrun" {
		t.Fatalf("runs = %q", runs)
	}
	if kinds(rec.all()) != "tool,tool,result,tool,tool,result,result" {
		t.Fatalf("events = %+v", rec.all())
	}
}

func TestRunnerReusesTheWorktreeAndReplacesABrokenOne(t *testing.T) {
	fakeClaude(t, "text.jsonl")
	task, _ := repoTask(t)
	r := newClaudeRunner((&recorder{}).emit, "", t.TempDir())
	first, err := r.ensureWorktree(task.Repo, task.Head)
	if err != nil {
		t.Fatal(err)
	}
	again, err := r.ensureWorktree(task.Repo, task.Head)
	if err != nil || again != first {
		t.Fatalf("second call: %s, %v; want %s", again, err, first)
	}
	// A crash can leave a folder git no longer knows; it is replaced.
	if err := os.RemoveAll(first); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(first, "junk"), "x")
	fixed, err := r.ensureWorktree(task.Repo, task.Head)
	if err != nil || fixed != first {
		t.Fatalf("after a crash: %s, %v", fixed, err)
	}
	if _, err := os.Stat(filepath.Join(first, "limit.go")); err != nil {
		t.Fatalf("the replaced worktree lacks the head's files: %v", err)
	}
}

func TestRunnerReportsWhatClaudeSaidWhenItFailsWithoutAResult(t *testing.T) {
	fakeClaude(t, "budget.jsonl")
	t.Setenv("CLAUDE_FIXTURE", "/dev/null")
	t.Setenv("CLAUDE_FAIL", "Invalid API key")
	task, _ := repoTask(t)
	rec := &recorder{}
	newClaudeRunner(rec.emit, "", t.TempDir()).run(task)
	got := rec.all()
	if len(got) != 1 || got[0].Kind != "error" || !strings.Contains(got[0].Message, "Invalid API key") {
		t.Fatalf("events = %+v", got)
	}
}

func TestRunnerDoesNotCacheAFailedRun(t *testing.T) {
	log := fakeClaude(t, "budget.jsonl")
	task, repo := repoTask(t)
	task.Cache = &cacheKey{Repo: repo, Head: task.Head, Kind: "brief", Version: "v1"}
	rec := &recorder{}
	r := newClaudeRunner(rec.emit, t.TempDir(), t.TempDir())
	r.run(task)
	r.run(task)
	if runs := readLog(t, log+".count"); runs != "run\nrun" {
		t.Fatalf("runs = %q", runs)
	}
	if kinds(rec.all()) != "error,error" {
		t.Fatalf("events = %+v", rec.all())
	}
}

func TestCancelKillsClaudeAndWhatItStarted(t *testing.T) {
	log := fakeClaude(t, "text.jsonl")
	t.Setenv("CLAUDE_HANG", "1")
	task, _ := repoTask(t)
	rec := &recorder{}
	r := newClaudeRunner(rec.emit, "", t.TempDir())
	done := make(chan struct{})
	go func() {
		r.run(task)
		close(done)
	}()
	child := waitForFile(t, log+".child")
	r.cancel(task.ID)
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the run did not end after cancel")
	}
	if got := rec.all(); len(got) != 1 || !reflect.DeepEqual(got[0], errorEvent("Stopped.")) {
		t.Fatalf("events = %+v", got)
	}
	var pid int
	if _, err := fmt.Sscan(child, &pid); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for syscall.Kill(pid, 0) == nil {
		if time.Now().After(deadline) {
			t.Fatalf("claude's child %d is still running", pid)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestReleaseRemovesIdleWorktreesAndShutdownRemovesAll(t *testing.T) {
	fakeClaude(t, "text.jsonl")
	task, repo := repoTask(t)
	r := newClaudeRunner((&recorder{}).emit, "", t.TempDir())
	wt, err := r.ensureWorktree(repo, task.Head)
	if err != nil {
		t.Fatal(err)
	}
	r.release(repo)
	if _, err := os.Stat(wt); !os.IsNotExist(err) {
		t.Fatalf("the worktree is still there: %v", err)
	}
	if list := gitIn(t, repo)("worktree", "list"); strings.Contains(list, filepath.Base(wt)) {
		t.Fatalf("git still lists it:\n%s", list)
	}

	wt, err = r.ensureWorktree(repo, task.Head)
	if err != nil {
		t.Fatal(err)
	}
	r.shutdown()
	if _, err := os.Stat(wt); !os.IsNotExist(err) {
		t.Fatalf("shutdown left the worktree: %v", err)
	}
}

func TestClaudeStatusFindsClaudeOnPath(t *testing.T) {
	fakeClaude(t, "text.jsonl")
	if got := claudeStatus(); !got.Installed || got.Version != "2.1.318" || got.DefaultModel != defaultClaudeModel {
		t.Fatalf("got %+v", got)
	}
	t.Setenv("PATH", t.TempDir())
	if got := claudeStatus(); got.Installed {
		t.Fatalf("got %+v with no claude on PATH", got)
	}
}

func waitForFile(t *testing.T, path string) string {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if b, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(b))) > 0 {
			return strings.TrimSpace(string(b))
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s never appeared", path)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
