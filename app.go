package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// Event names sent to the frontend.
const (
	eventRepoOpen  = "repo:open"
	eventRepoError = "repo:error"
)

// OpenRequest asks the frontend to show a repository, optionally with a base,
// or reports why it could not.
type OpenRequest struct {
	Repo  string `json:"repo"`
	Base  string `json:"base"`
	Error string `json:"error"`
}

// App struct
type App struct {
	ctx context.Context

	mu      sync.Mutex
	pending *OpenRequest // last request, kept until the frontend takes it
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// requestRepo resolves path to its repository root and tells the frontend to show it.
// It also stores the request, so a frontend that is not listening yet can take it later.
func (a *App) requestRepo(path, base string) {
	req := OpenRequest{Base: base}
	root, err := ResolveRepo(path)
	if err != nil {
		req.Error = err.Error()
	} else {
		req.Repo = root
	}

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
	path, base := parseLaunchArgs(data.Args)
	if path != "" {
		a.requestRepo(path, base)
	}
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

// Refs returns the branches and tags that can be used as a comparison base.
func (a *App) Refs(repo string) ([]string, error) {
	refs, err := ListRefs(repo)
	return orEmpty(refs), err
}

// DetectBase returns the base of the open pull request for the current branch.
func (a *App) DetectBase(repo string) PRBase {
	return DetectBase(repo)
}

// PRStatus returns the open pull request for the current branch, or nil.
func (a *App) PRStatus(repo string) *PRInfo {
	return PRStatus(repo)
}

// SyncReviewed marks the reviewed files as viewed on the current branch's pull request.
func (a *App) SyncReviewed(repo string, paths []string) (SyncResult, error) {
	return SyncReviewed(repo, paths)
}

// PRComments returns the discussion on the current branch's pull request, read-only.
func (a *App) PRComments(repo string) (PRDiscussion, error) {
	return PRComments(repo)
}

// CheckUpdate reports whether a newer release than this build exists.
func (a *App) CheckUpdate() (UpdateInfo, error) {
	return CheckUpdate()
}

// StopTerminal is bound as a method so the frontend can end the shell when the app closes.
func (a *App) StopTerminal() {
	StopTerminal()
}

// OpenPR opens the current branch's pull request in the browser.
func (a *App) OpenPR(repo string) error {
	return OpenPR(repo)
}

// Worktrees returns the checkouts of the repository that can be compared.
func (a *App) Worktrees(repo string) ([]Worktree, error) {
	list, err := ListWorktrees(repo)
	return orEmpty(list), err
}

// Commits returns the commits between base and HEAD, newest first.
func (a *App) Commits(repo, base string) ([]Commit, error) {
	list, err := ListCommits(repo, base)
	return orEmpty(list), err
}

// Changes returns the files that differ within scope.
func (a *App) Changes(s Scope) ([]FileChange, error) {
	list, err := ChangedFiles(s)
	return orEmpty(list), err
}

// Conflicts returns files that would conflict with base if HEAD were merged.
func (a *App) Conflicts(repo, base string) ([]string, error) {
	list, err := Conflicts(repo, base)
	return orEmpty(list), err
}

// Fingerprint changes when the working-tree comparison may have changed. The frontend polls it.
func (a *App) Fingerprint(repo, base string) (string, error) {
	return Fingerprint(repo, base)
}

// Stamps returns the current stamp of each path, used to reset reviewed marks.
func (a *App) Stamps(repo string, paths []string) map[string]string {
	stamps := Stamps(repo, paths)
	if stamps == nil {
		return map[string]string{}
	}
	return stamps
}

// Diff returns the unified diff of one file within scope.
func (a *App) Diff(s Scope, path string) (string, error) {
	return FileDiff(s, path)
}

// ExportPatch writes the diff within scope to a .patch file the user chooses.
// It returns the saved path, or "" when the dialog was cancelled.
func (a *App) ExportPatch(s Scope) (string, error) {
	out, err := scopeDiff(s, nil, "")
	if err != nil {
		return "", err
	}
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: filepath.Base(s.Repo) + "-" + scopeLabel(s) + ".patch",
		Filters:         []runtime.FileFilter{{DisplayName: "Patch", Pattern: "*.patch"}},
	})
	if err != nil || path == "" {
		return "", err
	}
	return path, os.WriteFile(path, []byte(out), 0o644)
}

// RunCommand runs a shell command in the repository and returns its output.
func (a *App) RunCommand(repo, command string) RunResult {
	return RunCommand(repo, command)
}

// History returns past comparisons, newest first.
func (a *App) History() ([]HistoryEntry, error) {
	path, err := historyPath()
	if err != nil {
		return nil, err
	}
	entries, err := loadHistory(path)
	return orEmpty(entries), err
}

// RecordHistory saves the current comparison in the history.
func (a *App) RecordHistory(repo, base, file string) error {
	path, err := historyPath()
	if err != nil {
		return err
	}
	entries, err := loadHistory(path)
	if err != nil {
		return err
	}
	entry := HistoryEntry{Repo: repo, Base: base, File: file, OpenedAt: time.Now()}
	return saveHistory(path, recordHistory(entries, entry))
}

// RevertToBase restores the given files to the base version. See RevertToBase in git.go.
func (a *App) RevertToBase(s Scope, paths []string) (RevertResult, error) {
	return RevertToBase(s, paths)
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

// ListFiles returns every file in the repository that is not ignored, for the file finder.
func (a *App) ListFiles(repo string) ([]string, error) {
	list, err := ListFiles(repo)
	return orEmpty(list), err
}

// ReadFile returns the text of a repository file for the editor.
func (a *App) ReadFile(repo, path string) (string, error) {
	return ReadFile(repo, path)
}

// WriteFile saves the text of an existing repository file.
func (a *App) WriteFile(repo, path, content string) error {
	return WriteFile(repo, path, content)
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

// orEmpty turns a nil slice into an empty one. Go sends nil as null, and the
// frontend maps over these lists without checking for null.
func orEmpty[T any](items []T) []T {
	if items == nil {
		return []T{}
	}
	return items
}
