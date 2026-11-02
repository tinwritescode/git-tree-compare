package main

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"time"
)

// userShell is the user's login shell, zsh when SHELL is unset.
func userShell() string {
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}
	return "/bin/zsh"
}

// loadLoginPath gives the app the PATH the user's terminal has. An app opened from
// Finder or the Dock starts with only /usr/bin:/bin:/usr/sbin:/sbin, so gh and the
// other tools Homebrew installs would not be found.
func loadLoginPath() {
	os.Setenv("PATH", joinPath(loginShellPath(), os.Getenv("PATH"), "/opt/homebrew/bin", "/usr/local/bin"))
}

// loginShellPath asks a login shell for its PATH, or returns "" when it cannot.
func loginShellPath() string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, userShell(), "-l", "-c", `printf '\n%s' "$PATH"`).Output()
	if err != nil {
		return ""
	}
	return lastLine(string(out))
}

// lastLine is the last line of out, past anything a shell profile prints.
func lastLine(out string) string {
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	return lines[len(lines)-1]
}

// joinPath joins PATH lists in order, keeping the first copy of each directory.
func joinPath(lists ...string) string {
	seen := map[string]bool{}
	var dirs []string
	for _, list := range lists {
		for _, dir := range strings.Split(list, ":") {
			if dir != "" && !seen[dir] {
				seen[dir] = true
				dirs = append(dirs, dir)
			}
		}
	}
	return strings.Join(dirs, ":")
}
