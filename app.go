package main

import (
	"context"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App struct
type App struct {
	ctx context.Context
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

// PickRepo opens a folder dialog and returns the chosen path, or "" if cancelled.
func (a *App) PickRepo() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Choose a git repository",
	})
}

// Refs returns the branches and tags that can be used as a comparison base.
func (a *App) Refs(repo string) ([]string, error) {
	return ListRefs(repo)
}

// Changes returns the files that differ from base.
func (a *App) Changes(repo, base string) ([]FileChange, error) {
	return ChangedFiles(repo, base)
}

// Diff returns the unified diff of one file against base.
func (a *App) Diff(repo, base, path string) (string, error) {
	return FileDiff(repo, base, path)
}
