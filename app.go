package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// Event names sent to the frontend.
const (
	eventRepoOpen  = "repo:open"
	eventRepoError = "repo:error"
)

// OpenRequest asks the frontend to show a repository, or reports why it could not.
// Review is set when the command line asked for a commit or a branch. Link is set instead of Repo
// when a URL asked for a pull request: only the frontend knows which repositories were opened before.
type OpenRequest struct {
	Repo   string       `json:"repo"`
	Error  string       `json:"error"`
	Review *LocalReview `json:"review,omitempty"`
	Link   *OpenLink    `json:"link,omitempty"`
}

// App struct
type App struct {
	ctx context.Context

	mu      sync.Mutex
	pending *OpenRequest // last request, kept until the frontend takes it

	claude *claudeRunner
}

// NewApp creates a new App application struct
func NewApp() *App {
	a := &App{}
	a.claude = newClaudeRunner(a.emitClaude, claudeCacheDir(), os.TempDir())
	return a
}

// emitClaude sends a Claude task's progress to the frontend as claude:<taskID>.
func (a *App) emitClaude(taskID string, ev ClaudeEvent) {
	if a.ctx != nil {
		runtime.EventsEmit(a.ctx, eventClaudePrefix+taskID, ev)
	}
}

// shutdown runs as the app quits: Claude stops, and its worktrees are removed.
func (a *App) shutdown(ctx context.Context) {
	a.claude.shutdown()
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	go refreshInstalledCLI()
}

// requestOpen resolves the launch path to its repository root, and any commit or branch in it,
// and tells the frontend to show them. It also stores the request, so a frontend that is not
// listening yet can take it later.
func (a *App) requestOpen(l Launch) {
	req := OpenRequest{}
	root, err := ResolveRepo(l.Path)
	if err == nil {
		req.Review, err = launchReview(root, l)
	}
	if err != nil {
		req.Error = err.Error()
	} else {
		req.Repo = root
	}
	a.publish(req)
}

// onURL handles a git-tree-compare:// link, which macOS delivers to the running app or starts it with.
func (a *App) onURL(raw string) {
	link, err := parseOpenURL(raw)
	if err != nil {
		a.publish(OpenRequest{Error: err.Error()})
	} else {
		a.publish(OpenRequest{Link: &link})
	}
	if a.ctx != nil {
		a.showWindow()
	}
}

func (a *App) publish(req OpenRequest) {
	a.mu.Lock()
	a.pending = &req
	a.mu.Unlock()

	if a.ctx == nil {
		return
	}
	if req.Error != "" {
		runtime.EventsEmit(a.ctx, eventRepoError, req.Error)
		return
	}
	runtime.EventsEmit(a.ctx, eventRepoOpen, req)
}

// onSecondInstance handles `git-tree-compare <path>` run while the app is already open.
// The new process hands its arguments here and exits.
func (a *App) onSecondInstance(data options.SecondInstanceData) {
	if l := parseLaunchArgs(data.Args); l.Path != "" {
		a.requestOpen(l)
	}
	a.showWindow()
}

func (a *App) showWindow() {
	runtime.WindowUnminimise(a.ctx)
	runtime.WindowShow(a.ctx)
}

// TakePendingRepo returns and clears the last open request, if any.
// The frontend calls it on mount to pick up a repo passed on the command line.
func (a *App) TakePendingRepo() *OpenRequest {
	a.mu.Lock()
	defer a.mu.Unlock()
	req := a.pending
	a.pending = nil
	return req
}

// HomeDir returns the user's home folder, where the in-app picker starts.
func (a *App) HomeDir() (string, error) {
	return os.UserHomeDir()
}

// ListDir returns the subfolders of path for the in-app repository picker.
func (a *App) ListDir(path string) (DirListing, error) {
	return ListDir(path)
}

// ResolveRepo returns the repository root that contains path.
func (a *App) ResolveRepo(path string) (string, error) {
	return ResolveRepo(path)
}

// FindClone returns the local repository with a remote at slug, or "".
func (a *App) FindClone(slug string, known []string) string {
	return FindClone(slug, known)
}

// ListPRs returns the repository's open pull requests.
func (a *App) ListPRs(repo string) ([]PRInfo, error) {
	list, err := ListPRs(repo)
	return orEmpty(list), err
}

// CurrentPRNumber returns the open pull request of the checked-out branch, or 0.
func (a *App) CurrentPRNumber(repo string) int {
	return CurrentPRNumber(repo)
}

// PrepareReview fetches a pull request and returns the commits to diff, leaving the checkout alone.
func (a *App) PrepareReview(repo string, pr PRInfo) (ReviewTarget, error) {
	return PrepareReview(repo, pr)
}

// ReviewCommit returns the diff of one commit, to review without a pull request.
func (a *App) ReviewCommit(repo, rev string) (LocalReview, error) {
	return ReviewCommit(repo, rev)
}

// ReviewBranch returns what a branch adds over base ("" for the default branch).
func (a *App) ReviewBranch(repo, branch, base string) (LocalReview, error) {
	return ReviewBranch(repo, branch, base)
}

// ListRefs lists the branches and recent commits the review pickers offer.
func (a *App) ListRefs(repo string) (RefList, error) {
	return ListRefs(repo)
}

// ListLocal lists the checked-out branch and the latest commits, which the inbox offers to review.
func (a *App) ListLocal(repo string) LocalSubjects {
	local := ListLocal(repo)
	local.Commits = orEmpty(local.Commits)
	return local
}

// PRViewedStates returns the viewer's state of every file in the pull request.
func (a *App) PRViewedStates(repo, prID string) (map[string]string, error) {
	return PRViewedStates(repo, prID)
}

// SetViewed marks files as viewed on the pull request, or removes the mark.
func (a *App) SetViewed(repo, prID string, paths []string, viewed bool) error {
	return SetViewed(repo, prID, paths, viewed)
}

// PRComments returns the discussion on a pull request, read-only.
func (a *App) PRComments(repo, prID string) (PRDiscussion, error) {
	return PRComments(repo, prID)
}

// SubmitReview posts a review with its verdict, summary and draft comments to the pull request at prURL.
func (a *App) SubmitReview(repo, prURL string, s ReviewSubmission) error {
	return SubmitReview(repo, prURL, s)
}

// ReplyToThread posts a reply on a review thread.
func (a *App) ReplyToThread(repo, threadID, body string) error {
	return ReplyToThread(repo, threadID, body)
}

// SetThreadResolved resolves a review thread, or opens it again.
func (a *App) SetThreadResolved(repo, threadID string, resolved bool) error {
	return SetThreadResolved(repo, threadID, resolved)
}

// BranchPushState says whether origin has the reviewed commits of a branch, so a pull request can be opened.
func (a *App) BranchPushState(repo, branch, head string) PushState {
	return BranchPushState(repo, branch, head)
}

// CreatePR opens a pull request for a branch on origin and returns its URL. It never pushes.
func (a *App) CreatePR(repo string, req PRCreateRequest) (string, error) {
	return CreatePR(repo, req)
}

// ExportPatch writes the review's diff to a .patch file the user chooses. name, such as "pr-12",
// goes into the suggested file name. It returns the saved path, or "" when the dialog was cancelled.
func (a *App) ExportPatch(s Scope, name string) (string, error) {
	out, err := scopeDiff(s, nil, "")
	if err != nil {
		return "", err
	}
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: fmt.Sprintf("%s-%s.patch", filepath.Base(s.Repo), name),
		Filters:         []runtime.FileFilter{{DisplayName: "Patch", Pattern: "*.patch"}},
	})
	if err != nil || path == "" {
		return "", err
	}
	return path, os.WriteFile(path, []byte(out), 0o644)
}

// CheckUpdate reports whether a newer release than this build exists.
func (a *App) CheckUpdate() (UpdateInfo, error) {
	return CheckUpdate()
}

// StopTerminal is bound as a method so the frontend can end the shell when the app closes.
func (a *App) StopTerminal() {
	StopTerminal()
}

// Changes returns the files that differ within scope.
func (a *App) Changes(s Scope) ([]FileChange, error) {
	list, err := ChangedFiles(s)
	return orEmpty(list), err
}

// Diff returns the unified diff of one file within scope.
func (a *App) Diff(s Scope, path string) (string, error) {
	return FileDiff(s, path)
}

// DiffSince returns one file's diff from the commit the reviewer marked it at to the scope's head.
func (a *App) DiffSince(s Scope, from, path, prURL string) (SinceDiff, error) {
	return DiffSince(s, from, path, prURL)
}

// RunCommand runs a shell command in the repository and returns its output.
func (a *App) RunCommand(repo, command string) RunResult {
	return RunCommand(repo, command)
}

// InstallUpdate downloads the latest release, replaces this app with it, and relaunches.
// The app quits on success, so the caller gets an error only when nothing was changed.
func (a *App) InstallUpdate() error {
	appPath, err := appBundlePath()
	if err != nil {
		return err
	}
	release, err := fetchLatestRelease()
	if err != nil {
		return err
	}
	if err := installRelease(release, appPath); err != nil {
		return err
	}
	if err := relaunchAfterQuit(appPath); err != nil {
		return fmt.Errorf("the update is installed, but the app could not restart: %w", err)
	}
	runtime.Quit(a.ctx)
	return nil
}

// SearchFiles searches the pull request's files as they are at head, for the search dialog.
func (a *App) SearchFiles(repo, head string, paths []string, q SearchQuery) (SearchResult, error) {
	return SearchFiles(repo, head, paths, q)
}

// DiffAnchor returns the GitHub anchor for a file on a pull request's Files tab.
func (a *App) DiffAnchor(path string) string {
	return DiffAnchor(path)
}

// InstalledEditors returns the editors on this machine that the app can open files in.
func (a *App) InstalledEditors() []Editor {
	return orEmpty(InstalledEditors())
}

// OpenInEditor opens a file of the repository in the editor with the given ID.
func (a *App) OpenInEditor(repo, path, editor string) error {
	return OpenInEditor(repo, path, editor)
}

// OpenAtHead opens a read-only copy of a pull request's file at its head commit in the editor.
func (a *App) OpenAtHead(repo string, number int, head, path, editor string) error {
	return OpenAtHead(repo, number, head, path, editor)
}

// PRChecks lists the CI checks on a pull request's head.
func (a *App) PRChecks(repo string, number int) ([]Check, error) {
	return PRChecks(repo, number)
}

// ClaudeStatus reports whether claude is installed, and the model tasks use by default.
func (a *App) ClaudeStatus() ClaudeInfo {
	return claudeStatus()
}

// StartBrief writes the brief of a review in the background. Its progress arrives as
// claude:<taskID> events, ending with one result or one error.
func (a *App) StartBrief(taskID string, req ChangeRef) error {
	return a.startClaude(briefTask(taskID, req))
}

// StartExplain explains one hunk in the background, streamed as claude:<taskID> events.
func (a *App) StartExplain(taskID string, req ExplainRequest) error {
	return a.startClaude(explainTask(taskID, req))
}

// StartAsk puts one question to the review's conversation with Claude, streamed as
// claude:<taskID> events.
func (a *App) StartAsk(taskID string, req AskRequest) error {
	return a.startClaude(askTask(taskID, req))
}

// StartFindings looks for places worth a comment, in the background.
func (a *App) StartFindings(taskID string, req ChangeRef) error {
	return a.startClaude(findingsTask(taskID, req))
}

// StartRereview sums up what changed since the reviewer's review, and checks their open threads against it.
func (a *App) StartRereview(taskID string, req RereviewRequest) error {
	return a.startClaude(rereviewTask(taskID, req))
}

// StartPolish rewrites a draft comment. The reviewer chooses whether to keep the rewrite.
func (a *App) StartPolish(taskID string, req PolishRequest) error {
	return a.startClaude(polishTask(taskID, req))
}

// StartReviewSummary drafts the review's summary from its verdict and draft comments.
func (a *App) StartReviewSummary(taskID string, req SummaryRequest) error {
	return a.startClaude(summaryTask(taskID, req))
}

// StartPRDescription drafts a title and body for a pull request of the branch under review.
func (a *App) StartPRDescription(taskID string, req ChangeRef) error {
	return a.startClaude(prDescriptionTask(taskID, req))
}

// startClaude starts a task a builder made, or returns why the builder refused.
func (a *App) startClaude(task claudeTask, err error) error {
	if err != nil {
		return err
	}
	return a.claude.start(task)
}

// CancelClaude stops a running Claude task.
func (a *App) CancelClaude(taskID string) {
	a.claude.cancel(taskID)
}

// ReleaseClaude removes the checkouts Claude read for a repository, once its review closes.
func (a *App) ReleaseClaude(repo string) {
	a.claude.release(repo)
}

// orEmpty turns a nil slice into an empty one. Go sends nil as null, and the
// frontend maps over these lists without checking for null.
func orEmpty[T any](items []T) []T {
	if items == nil {
		return []T{}
	}
	return items
}
