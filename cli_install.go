package main

import (
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

//go:embed scripts/git-tree-compare
var cliScript string

const (
	cliName = "git-tree-compare"
	// cliMarker is a line every version of the script carries, so the app only ever
	// replaces a command it wrote.
	cliMarker = "# Open a git repository in git-tree-compare"
	// cliDefaultApp is the bundle the script opens unless the installer points it elsewhere.
	cliDefaultApp = "/Applications/git-tree-compare.app"
)

// InstallCLI puts the `git-tree-compare` command on the user's PATH, like VS Code's
// `code` or Zed's `zed`, and returns where it went.
func (a *App) InstallCLI() (string, error) {
	app, err := appBundlePath()
	if err != nil {
		return "", err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return installCLI(cliDirs(home, filepath.SplitList(loginShellPath())), app)
}

// refreshInstalledCLI rewrites an installed command that points at this bundle, so it
// stays in step with the app after an update.
func refreshInstalledCLI() {
	app, err := appBundlePath()
	if err != nil {
		return
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	refreshCLI(cliDirs(home, filepath.SplitList(loginShellPath())), app)
}

// cliScriptFor returns the command's script, opening the bundle at app.
func cliScriptFor(app string) string {
	return strings.Replace(cliScript, cliDefaultApp, app, 1)
}

// cliDirs returns the folders the command may go in that the terminal's PATH lists,
// in order of preference. The user's own bin comes first because it needs no admin rights.
func cliDirs(home string, path []string) []string {
	var dirs []string
	for _, dir := range []string{filepath.Join(home, ".local", "bin"), "/usr/local/bin", "/opt/homebrew/bin"} {
		if slices.Contains(path, dir) {
			dirs = append(dirs, dir)
		}
	}
	return dirs
}

// installCLI writes the command into the first of dirs that takes it. A file of the same
// name that the app did not write is left alone.
func installCLI(dirs []string, app string) (string, error) {
	err := fmt.Errorf("none of ~/.local/bin, /usr/local/bin or /opt/homebrew/bin is on your PATH")
	for _, dir := range dirs {
		target := filepath.Join(dir, cliName)
		if err = writeCLI(target, cliScriptFor(app)); err == nil {
			return target, nil
		}
	}
	return "", fmt.Errorf("could not install the %s command: %w", cliName, err)
}

// refreshCLI rewrites each installed command in dirs that opens app and is out of date.
func refreshCLI(dirs []string, app string) {
	want := cliScriptFor(app)
	for _, dir := range dirs {
		target := filepath.Join(dir, cliName)
		got, err := os.ReadFile(target)
		if err != nil || string(got) == want || !strings.Contains(string(got), ":-"+app+"}") {
			continue
		}
		_ = writeCLI(target, want)
	}
}

// writeCLI replaces target with script through a rename, so a half-written command is never
// on the PATH.
func writeCLI(target, script string) error {
	if old, err := os.ReadFile(target); err == nil && !strings.Contains(string(old), cliMarker) {
		return fmt.Errorf("%s exists and was not installed by this app", target)
	}
	tmp, err := os.CreateTemp(filepath.Dir(target), "."+cliName+"-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(script); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), target)
}
