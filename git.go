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
// Generated and WhitespaceOnly are facts only git knows; the frontend decides from them what to fold.
type FileChange struct {
	Path           string `json:"path"`
	OldPath        string `json:"oldPath,omitempty"`
	Status         string `json:"status"`
	Added          int    `json:"added"`
	Deleted        int    `json:"deleted"`
	Generated      bool   `json:"generated,omitempty"`      // linguist-generated at head
	WhitespaceOnly bool   `json:"whitespaceOnly,omitempty"` // modified, but nothing is left with -w
}

// runGit runs git in repo and returns stdout.
func runGit(repo string, args ...string) (string, error) {
	return runGitInput(repo, "", args...)
}

// runGitInput runs git in repo with input on stdin and returns stdout.
func runGitInput(repo, input string, args ...string) (string, error) {
	cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
	cmd.Stdin = strings.NewReader(input)
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

	// Line counts with and without whitespace: the scope picks which to show, and a file that
	// changes only in the first is whitespace only.
	var stats [2]map[string][2]int
	for i, ignoreWS := range []bool{false, true} {
		numstat, err := scopeDiff(Scope{Repo: s.Repo, Base: s.Base, Head: s.Head, IgnoreWS: ignoreWS}, []string{"--numstat"}, "")
		if err != nil {
			return nil, err
		}
		stats[i] = parseNumstat(numstat)
	}
	shown := stats[0]
	if s.IgnoreWS {
		shown = stats[1]
	}
	for i := range changes {
		c := &changes[i]
		if st, ok := shown[c.Path]; ok {
			c.Added, c.Deleted = st[0], st[1]
		}
		c.WhitespaceOnly = isWhitespaceOnly(stats[0][c.Path], stats[1][c.Path])
	}
	if err := markGenerated(s.Repo, s.Head, changes); err != nil {
		return nil, err
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
