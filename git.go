package main

import (
	"bufio"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

// FileChange is one entry in the file tree.
// Status is A, M, D, or R. Added and Deleted are line counts.
type FileChange struct {
	Path    string `json:"path"`
	OldPath string `json:"oldPath,omitempty"`
	Status  string `json:"status"`
	Added   int    `json:"added"`
	Deleted int    `json:"deleted"`
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

// ResolveRepo returns the top-level directory of the repository containing path.
func ResolveRepo(path string) (string, error) {
	out, err := runGit(path, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", fmt.Errorf("%s is not inside a git repository", path)
	}
	return strings.TrimSpace(out), nil
}

// ChangedFiles lists the files that differ within scope with their line counts.
func ChangedFiles(s Scope) ([]FileChange, error) {
	out, err := scopeDiff(s, []string{"--name-status"}, "")
	if err != nil {
		return nil, err
	}
	changes := parseNameStatus(out)

	numstat, err := scopeDiff(s, []string{"--numstat"}, "")
	if err != nil {
		return nil, err
	}
	stats := parseNumstat(numstat)
	for i := range changes {
		if st, ok := stats[changes[i].Path]; ok {
			changes[i].Added, changes[i].Deleted = st[0], st[1]
		}
	}
	return changes, nil
}

// FileDiff returns the unified diff of one file within scope.
func FileDiff(s Scope, path string) (string, error) {
	return scopeDiff(s, nil, path)
}

// parseNameStatus parses `git diff --name-status -M` output.
// Renames look like "R100\told\tnew"; every other line is "STATUS\tpath".
func parseNameStatus(out string) []FileChange {
	var changes []FileChange
	scanner := bufio.NewScanner(strings.NewReader(out))
	for scanner.Scan() {
		fields := strings.Split(scanner.Text(), "\t")
		if len(fields) < 2 || fields[0] == "" {
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

var renameBraces = regexp.MustCompile(`\{[^{}]* => ([^{}]*)\}`)

// parseNumstat parses `git diff --numstat -M` output into added and deleted
// counts keyed by the new path. Binary files report "-" and count as zero.
func parseNumstat(out string) map[string][2]int {
	stats := map[string][2]int{}
	scanner := bufio.NewScanner(strings.NewReader(out))
	for scanner.Scan() {
		fields := strings.SplitN(scanner.Text(), "\t", 3)
		if len(fields) != 3 {
			continue
		}
		added, _ := strconv.Atoi(fields[0])
		deleted, _ := strconv.Atoi(fields[1])
		stats[numstatNewPath(fields[2])] = [2]int{added, deleted}
	}
	return stats
}

// numstatNewPath turns "a => b" or "dir/{a => b}/f" into the new path "b".
func numstatNewPath(p string) string {
	if strings.Contains(p, "{") {
		p = renameBraces.ReplaceAllString(p, "$1")
		return strings.ReplaceAll(p, "//", "/")
	}
	if _, after, ok := strings.Cut(p, " => "); ok {
		return after
	}
	return p
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
