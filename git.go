package main

import (
	"bufio"
	"fmt"
	"os/exec"
	"strings"
)

// FileChange is one entry in the comparison tree.
type FileChange struct {
	Path    string `json:"path"`
	OldPath string `json:"oldPath,omitempty"`
	Status  string `json:"status"`
}

// runGit runs git in repo and returns stdout.
func runGit(repo string, args ...string) (string, error) {
	cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return "", fmt.Errorf("git %s: %s", strings.Join(args, " "), strings.TrimSpace(string(exitErr.Stderr)))
		}
		return "", err
	}
	return string(out), nil
}

// ListRefs returns local branches and tags, to choose the comparison base.
func ListRefs(repo string) ([]string, error) {
	out, err := runGit(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/tags")
	if err != nil {
		return nil, err
	}
	return splitLines(out), nil
}

// MergeBase returns the common ancestor of base and HEAD, the same
// comparison a pull request uses.
func MergeBase(repo, base string) (string, error) {
	out, err := runGit(repo, "merge-base", base, "HEAD")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// ChangedFiles lists files that differ between base's merge-base and the working tree.
func ChangedFiles(repo, base string) ([]FileChange, error) {
	mb, err := MergeBase(repo, base)
	if err != nil {
		return nil, err
	}
	out, err := runGit(repo, "diff", "--name-status", "-M", mb)
	if err != nil {
		return nil, err
	}
	return parseNameStatus(out), nil
}

// FileDiff returns the unified diff of one file against base's merge-base.
func FileDiff(repo, base, path string) (string, error) {
	mb, err := MergeBase(repo, base)
	if err != nil {
		return "", err
	}
	return runGit(repo, "diff", "-M", mb, "--", path)
}

// parseNameStatus parses `git diff --name-status -M` output.
// Renames look like "R100\told\tnew"; every other line is "STATUS\tpath".
func parseNameStatus(out string) []FileChange {
	var changes []FileChange
	scanner := bufio.NewScanner(strings.NewReader(out))
	for scanner.Scan() {
		fields := strings.Split(scanner.Text(), "\t")
		if len(fields) < 2 {
			continue
		}
		change := FileChange{Status: fields[0][:1], Path: fields[1]}
		if change.Status == "R" && len(fields) == 3 {
			change.OldPath = fields[1]
			change.Path = fields[2]
		}
		changes = append(changes, change)
	}
	return changes
}

func splitLines(s string) []string {
	var lines []string
	for _, line := range strings.Split(strings.TrimSpace(s), "\n") {
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}
