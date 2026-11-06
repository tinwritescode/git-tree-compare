package main

// The Claude runner: the one place the app starts claude. A task says what to ask and how; the
// runner checks its cache, checks the head out in a worktree, runs claude there, streams what it
// does as claude:<taskId> events, and can stop it. Each kind of task (brief, and later others)
// only builds a claudeTask; nothing here knows about kinds.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	defaultClaudeModel = "claude-opus-5-5"
	eventClaudePrefix  = "claude:" // + task id
	claudeTimeout      = 15 * time.Minute
	maxClaudeBudgetUSD = 20.0
)

// claudeReadTools are the only tools a task may give Claude: they read the checkout and change nothing.
var claudeReadTools = []string{"Read", "Grep", "Glob"}

// ClaudeInfo says whether claude can run here, and the model tasks use unless the user picked another.
type ClaudeInfo struct {
	Installed    bool   `json:"installed"`
	Version      string `json:"version"`
	DefaultModel string `json:"defaultModel"`
}

// claudeStatus looks for claude on PATH, which main sets to the login shell's.
func claudeStatus() ClaudeInfo {
	info := ClaudeInfo{DefaultModel: defaultClaudeModel}
	bin, err := exec.LookPath("claude")
	if err != nil {
		return info
	}
	info.Installed = true
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, bin, "--version").Output(); err == nil {
		info.Version, _, _ = strings.Cut(strings.TrimSpace(string(out)), " ")
	}
	return info
}

// sessionMode says whether Claude keeps the conversation. Most tasks are one-shot.
type sessionMode int

const (
	sessionNone   sessionMode = iota // --no-session-persistence
	sessionStart                     // --session-id: a conversation later tasks resume
	sessionResume                    // --resume: carry on with one
)

type claudeSession struct {
	Mode sessionMode
	ID   string // a UUID, for start and resume
}

// claudeTask is one run of claude.
type claudeTask struct {
	ID        string                 // names the claude:<id> events, and the run to cancel
	Kind      string                 // brief, ...; part of the cache key
	Prompt    string                 // the instructions; passed after "--", so it is never read as a flag
	Schema    string                 // a JSON schema the answer must match, or "" for a text answer
	Input     func() (string, error) // what claude reads on stdin, built only when claude runs
	Model     string
	BudgetUSD float64
	Tools     []string // from claudeReadTools; none disables every tool
	Partial   bool     // stream text as it is written
	Session   claudeSession
	Repo      string // claude runs in a detached worktree of Repo at Head
	Head      string
	Cache     *cacheKey // where a finished answer is kept; nil runs every time
}

var (
	taskIDPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)
	taskKind       = regexp.MustCompile(`^[a-z]{1,20}$`)
	modelPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,63}$`)
	sessionPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

// validateTask checks every value that becomes an argument, so none can be taken for a flag.
func validateTask(t claudeTask) error {
	switch {
	case !taskIDPattern.MatchString(t.ID):
		return fmt.Errorf("%q is not a task id", t.ID)
	case !taskKind.MatchString(t.Kind):
		return fmt.Errorf("%q is not a task kind", t.Kind)
	case !modelPattern.MatchString(t.Model):
		return fmt.Errorf("%q is not a Claude model", t.Model)
	case t.BudgetUSD <= 0 || t.BudgetUSD > maxClaudeBudgetUSD:
		return fmt.Errorf("a budget of $%.2f is out of range", t.BudgetUSD)
	case t.Session.Mode != sessionNone && !sessionPattern.MatchString(t.Session.ID):
		return fmt.Errorf("%q is not a session id", t.Session.ID)
	case !commitID.MatchString(t.Head):
		return fmt.Errorf("%q is not a commit id", t.Head)
	case t.Repo == "":
		return errors.New("no repository")
	}
	for _, tool := range t.Tools {
		if !slices.Contains(claudeReadTools, tool) {
			return fmt.Errorf("Claude may not use %s", tool)
		}
	}
	return nil
}

// claudeArgs is the command line for a task. --restricted and --safe-mode keep the checkout's own
// .claude settings, hooks and CLAUDE.md out of the run: the pull request wrote them.
func claudeArgs(t claudeTask) []string {
	args := []string{"-p", "--model", t.Model, "--tools"}
	if len(t.Tools) == 0 {
		args = append(args, "")
	} else {
		args = append(args, t.Tools...)
	}
	args = append(args,
		"--strict-mcp-config", "--restricted", "--safe-mode",
		"--output-format", "stream-json", "--verbose",
		"--max-budget-usd", fmt.Sprintf("%.2f", t.BudgetUSD))
	if t.Schema != "" {
		args = append(args, "--json-schema", t.Schema)
	}
	if t.Partial {
		args = append(args, "--include-partial-messages")
	}
	switch t.Session.Mode {
	case sessionNone:
		args = append(args, "--no-session-persistence")
	case sessionStart:
		args = append(args, "--session-id", t.Session.ID)
	case sessionResume:
		args = append(args, "--resume", t.Session.ID)
	}
	return append(args, "--", t.Prompt)
}

// cacheKey names a finished answer: the same question about the same commits gets the same answer.
// Version changes when the prompt or schema does.
type cacheKey struct {
	Repo, Base, Head, Kind, Version string
}

func (k cacheKey) file() string {
	sum := sha256.Sum256([]byte(strings.Join([]string{k.Repo, k.Base, k.Head, k.Kind, k.Version}, "\x00")))
	return k.Kind + "-" + hex.EncodeToString(sum[:16]) + ".json"
}

// promptVersion names a prompt and schema pair, so changing either one misses the old cache.
func promptVersion(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:6])
}

// claudeCacheDir is where finished answers are kept: the app's folder in Application Support.
func claudeCacheDir() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "git-tree-compare", "claude-cache")
}

// claudeRunner runs tasks. It owns the running processes and the worktrees they run in; mu guards
// both, so a worktree is never removed between being checked out and claude starting in it.
type claudeRunner struct {
	emit     func(taskID string, ev ClaudeEvent)
	cacheDir string // "" keeps no answers
	tmp      string // worktrees go in <tmp>/git-tree-compare/<repo-hash>/

	mu        sync.Mutex
	running   map[string]*claudeRun
	worktrees map[string]string // folder -> repository
}

type claudeRun struct {
	cmd    *exec.Cmd
	dir    string
	reason atomic.Pointer[string] // why it was stopped, once it was
}

// stop kills claude and everything it started: it leads its own process group.
func (run *claudeRun) stop(reason string) {
	run.reason.CompareAndSwap(nil, &reason)
	_ = syscall.Kill(-run.cmd.Process.Pid, syscall.SIGKILL)
}

func newClaudeRunner(emit func(string, ClaudeEvent), cacheDir, tmp string) *claudeRunner {
	return &claudeRunner{emit: emit, cacheDir: cacheDir, tmp: tmp, running: map[string]*claudeRun{}, worktrees: map[string]string{}}
}

// start checks the task and runs it in the background.
func (r *claudeRunner) start(t claudeTask) error {
	if err := validateTask(t); err != nil {
		return err
	}
	go r.run(t)
	return nil
}

// run runs a task to its end. Tool and text events are sent as they come; the last event is
// always one result or one error.
func (r *claudeRunner) run(t claudeTask) {
	if err := validateTask(t); err != nil {
		r.emit(t.ID, errorEvent(err.Error()))
		return
	}
	if ev, ok := r.readCache(t.Cache); ok {
		r.emit(t.ID, ev)
		return
	}
	r.emit(t.ID, r.execute(t))
}

// execute runs claude and returns how it ended.
func (r *claudeRunner) execute(t claudeTask) ClaudeEvent {
	input, err := t.Input()
	if err != nil {
		return errorEvent(err.Error())
	}
	run, stdout, stderr, err := r.spawn(t, input)
	if err != nil {
		return errorEvent(err.Error())
	}
	defer r.forget(t.ID, run)
	timer := time.AfterFunc(claudeTimeout, func() {
		run.stop(fmt.Sprintf("Claude took longer than %s, so it was stopped.", claudeTimeout))
	})
	defer timer.Stop()

	parser := streamParser{roots: folderNames(run.dir), partial: t.Partial}
	var final *ClaudeEvent
	reader := bufio.NewReader(stdout)
	for {
		line, readErr := reader.ReadBytes('\n')
		for _, ev := range parser.parse(line) {
			if ev.Kind == "result" || ev.Kind == "error" {
				final = &ev
				continue
			}
			r.emit(t.ID, ev)
		}
		if readErr != nil {
			break
		}
	}
	waitErr := run.cmd.Wait()
	switch {
	case run.reason.Load() != nil:
		return errorEvent(*run.reason.Load())
	case final != nil:
		if final.Kind == "result" {
			r.writeCache(t.Cache, *final)
		}
		return *final
	default:
		return errorEvent(claudeFailure(waitErr, stderr.String()))
	}
}

// claudeFailure says why claude ended without an answer, in its own words when it printed any.
func claudeFailure(err error, stderr string) string {
	if msg := strings.TrimSpace(stderr); msg != "" {
		return "Claude said: " + lastLine(msg)
	}
	if err != nil {
		return "Claude stopped: " + err.Error()
	}
	return "Claude stopped without an answer."
}

// folderNames is dir as given and with symlinks resolved; claude reports either.
func folderNames(dir string) []string {
	names := []string{dir}
	if real, err := filepath.EvalSymlinks(dir); err == nil && real != dir {
		names = append(names, real)
	}
	return names
}

// spawn checks the head out and starts claude in it, holding mu so release cannot remove the
// worktree in between. A run with the same task id is stopped first.
func (r *claudeRunner) spawn(t claudeTask, input string) (*claudeRun, *bufio.Reader, *bytes.Buffer, error) {
	bin, err := exec.LookPath("claude")
	if err != nil {
		return nil, nil, nil, errors.New("claude is not installed")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	dir, err := r.worktreeLocked(t.Repo, t.Head)
	if err != nil {
		return nil, nil, nil, err
	}
	cmd := exec.Command(bin, claudeArgs(t)...)
	cmd.Dir = dir
	cmd.Stdin = strings.NewReader(input)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, nil, nil, fmt.Errorf("could not start claude: %w", err)
	}
	if old := r.running[t.ID]; old != nil {
		old.stop("Stopped.")
	}
	run := &claudeRun{cmd: cmd, dir: dir}
	r.running[t.ID] = run
	return run, bufio.NewReader(stdout), &stderr, nil
}

func (r *claudeRunner) forget(id string, run *claudeRun) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.running[id] == run {
		delete(r.running, id)
	}
}

// cancel stops a running task. Its run ends with the error "Stopped.".
func (r *claudeRunner) cancel(id string) {
	r.mu.Lock()
	run := r.running[id]
	delete(r.running, id)
	r.mu.Unlock()
	if run != nil {
		run.stop("Stopped.")
	}
}

// release removes the repository's worktrees that no running task uses, when its review closes.
func (r *claudeRunner) release(repo string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	busy := map[string]bool{}
	for _, run := range r.running {
		busy[run.dir] = true
	}
	for dir, owner := range r.worktrees {
		if owner == repo && !busy[dir] {
			removeWorktree(owner, dir)
			delete(r.worktrees, dir)
		}
	}
}

// shutdown stops every task and removes every worktree, as the app quits.
func (r *claudeRunner) shutdown() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, run := range r.running {
		run.stop("Stopped.")
		delete(r.running, id)
	}
	for dir, repo := range r.worktrees {
		removeWorktree(repo, dir)
		delete(r.worktrees, dir)
	}
}

// ensureWorktree returns a worktree of repo checked out at head, making it when needed.
func (r *claudeRunner) ensureWorktree(repo, head string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.worktreeLocked(repo, head)
}

// worktreeLocked reuses the worktree at head when it is sound, and otherwise clears whatever a
// crash left there and checks it out again, so calling it any number of times ends the same way.
// The repository's hooks are off: this checkout is the app's, not the user's.
func (r *claudeRunner) worktreeLocked(repo, head string) (string, error) {
	dir := filepath.Join(r.tmp, "git-tree-compare", repoHash(repo), "worktree-"+head)
	if !worktreeAt(dir, head) {
		removeWorktree(repo, dir)
		if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
			return "", err
		}
		if _, err := runGit(repo, "-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", dir, head); err != nil {
			return "", fmt.Errorf("could not check out %s for Claude: %w", head[:7], err)
		}
	}
	r.worktrees[dir] = repo
	return dir, nil
}

// worktreeAt reports whether dir is the top of a checkout at head.
func worktreeAt(dir, head string) bool {
	out, err := runGit(dir, "rev-parse", "--show-toplevel", "HEAD")
	if err != nil {
		return false
	}
	lines := splitLines(out)
	if len(lines) != 2 || lines[1] != head {
		return false
	}
	top, err1 := filepath.EvalSymlinks(lines[0])
	want, err2 := filepath.EvalSymlinks(dir)
	return err1 == nil && err2 == nil && top == want
}

// removeWorktree removes a worktree and git's record of it, even when the folder is half gone.
func removeWorktree(repo, dir string) {
	_, _ = runGit(repo, "worktree", "remove", "--force", dir)
	_ = os.RemoveAll(dir)
	_, _ = runGit(repo, "worktree", "prune")
}

func (r *claudeRunner) readCache(k *cacheKey) (ClaudeEvent, bool) {
	if k == nil || r.cacheDir == "" {
		return ClaudeEvent{}, false
	}
	body, err := os.ReadFile(filepath.Join(r.cacheDir, k.file()))
	if err != nil {
		return ClaudeEvent{}, false
	}
	var ev ClaudeEvent
	if json.Unmarshal(body, &ev) != nil || ev.Kind != "result" {
		return ClaudeEvent{}, false
	}
	return ev, true
}

// writeCache keeps a finished answer. It writes a temp file and renames it, so a crash never
// leaves half an answer. Failing to keep it costs only a later run.
func (r *claudeRunner) writeCache(k *cacheKey, ev ClaudeEvent) {
	if k == nil || r.cacheDir == "" {
		return
	}
	body, err := json.Marshal(ev)
	if err != nil || os.MkdirAll(r.cacheDir, 0o700) != nil {
		return
	}
	f, err := os.CreateTemp(r.cacheDir, ".answer-*")
	if err != nil {
		return
	}
	defer os.Remove(f.Name()) // a no-op once renamed
	_, err = f.Write(body)
	if closeErr := f.Close(); err == nil && closeErr == nil {
		_ = os.Rename(f.Name(), filepath.Join(r.cacheDir, k.file()))
	}
}
