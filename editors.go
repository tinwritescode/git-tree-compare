package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// Editor is a code editor the app can open a file in.
type Editor struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// App is the macOS bundle name, without ".app". `open -a` launches the editor by it.
	App string `json:"app"`
}

// knownEditors lists the editors offered in the app, in the order they are suggested.
var knownEditors = []Editor{
	{ID: "zed", Name: "Zed", App: "Zed"},
	{ID: "vscode", Name: "VS Code", App: "Visual Studio Code"},
	{ID: "cursor", Name: "Cursor", App: "Cursor"},
	{ID: "sublime", Name: "Sublime Text", App: "Sublime Text"},
}

// InstalledEditors returns the known editors whose app is installed for this user or system-wide.
func InstalledEditors() []Editor {
	home, _ := os.UserHomeDir()
	return installedEditors(knownEditors, []string{"/Applications", filepath.Join(home, "Applications")})
}

// installedEditors keeps the editors whose "<App>.app" folder exists in one of dirs.
func installedEditors(editors []Editor, dirs []string) []Editor {
	var found []Editor
	for _, e := range editors {
		for _, dir := range dirs {
			if _, err := os.Stat(filepath.Join(dir, e.App+".app")); err == nil {
				found = append(found, e)
				break
			}
		}
	}
	return found
}

// OpenInEditor opens a file of the repository in the editor with the given ID.
func OpenInEditor(repo, rel, id string) error {
	for _, e := range knownEditors {
		if e.ID != id {
			continue
		}
		full, err := safeFilePath(repo, rel)
		if err != nil {
			return err
		}
		return exec.Command("open", "-a", e.App, full).Run()
	}
	return fmt.Errorf("unknown editor %q", id)
}
