package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// FileChange is one entry in the comparison tree.
// Status is A, M, D, R, or U for untracked. Added and Deleted are line counts.
type FileChange struct {
	Path    string `json:"path"`
	OldPath string `json:"oldPath,omitempty"`
	Status  string `json:"status"`
	Added   int    `json:"added"`
	Deleted int    `json:"deleted"`
}

// Worktree is one linked checkout of the repository.
type Worktree struct {
	Path     string `json:"path"`
	Branch   string `json:"branch"`
	Head     string `json:"head"`
	Detached bool   `json:"detached"`
	Bare     bool   `json:"bare"`
}

// Commit is one commit between base and HEAD.
type Commit struct {
	Hash    string `json:"hash"`
	Short   string `json:"short"`
	Subject string `json:"subject"`
	Author  string `json:"author"`
	Date    string `json:"date"`
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

// runGitAllowExit runs git where exit code 1 means "differences found" or "conflicts".
func runGitAllowExit(repo string, args ...string) (string, error) {
	cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return string(out), nil
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

// ListRefs returns local branches, remote-tracking branches and tags, to choose the comparison base.
// A local "staging" and a remote "origin/staging" can differ, so both are listed under their own names.
func ListRefs(repo string) ([]string, error) {
	out, err := runGit(repo, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags")
	if err != nil {
		return nil, err
	}
	var refs []string
	for _, full := range splitLines(out) {
		if strings.HasSuffix(full, "/HEAD") {
			// refs/remotes/origin/HEAD only points at the default branch; the branch itself is listed.
			continue
		}
		refs = append(refs, shortRef(full))
	}
	return refs, nil
}

// shortRef drops the refs/heads, refs/remotes or refs/tags prefix from a full ref name.
func shortRef(full string) string {
	for _, prefix := range []string{"refs/heads/", "refs/remotes/", "refs/tags/"} {
		if strings.HasPrefix(full, prefix) {
			return strings.TrimPrefix(full, prefix)
		}
	}
	return full
}

// missingBaseError says what to do when the chosen base is not in this clone.
// Git's own message ("Not a valid commit name") does not say that.
func missingBaseError(base string) error {
	return fmt.Errorf("The base %s is not in this repository. Pick another base, or run git fetch to get it.", shortBase(base))
}

// shortBase shortens a full commit id for messages and labels; other names are returned as they are.
func shortBase(base string) string {
	if len(base) == 40 && strings.Trim(base, "0123456789abcdef") == "" {
		return base[:7]
	}
	return base
}

// ListWorktrees returns every checkout attached to the repository.
func ListWorktrees(repo string) ([]Worktree, error) {
	out, err := runGit(repo, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}
	return parseWorktrees(out), nil
}

// ListCommits returns the commits on HEAD that base does not have, newest first.
func ListCommits(repo, base string) ([]Commit, error) {
	if !hasCommit(repo, base) {
		return nil, missingBaseError(base)
	}
	out, err := runGit(repo, "log", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI", base+"..HEAD")
	if err != nil {
		return nil, err
	}
	return parseCommits(out), nil
}

// MergeBase returns the common ancestor of base and HEAD, the same
// comparison a pull request uses.
func MergeBase(repo, base string) (string, error) {
	if !hasCommit(repo, base) {
		return "", missingBaseError(base)
	}
	out, err := runGit(repo, "merge-base", base, "HEAD")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// ChangedFiles lists the files that differ within scope with their line counts.
// The working-tree scope also includes untracked files.
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

	if s.Commit != "" {
		return changes, nil
	}
	untracked, err := runGit(s.Repo, "ls-files", "--others", "--exclude-standard")
	if err != nil {
		return nil, err
	}
	for _, path := range splitLines(untracked) {
		changes = append(changes, FileChange{Path: path, Status: "U", Added: countLines(filepath.Join(s.Repo, path))})
	}
	return changes, nil
}

// Conflicts returns files that would conflict if HEAD were merged into base.
// It looks at commits only, not uncommitted edits. Needs git 2.38 or newer.
func Conflicts(repo, base string) ([]string, error) {
	out, err := runGitAllowExit(repo, "merge-tree", "--write-tree", "--name-only", "--no-messages", base, "HEAD")
	if err != nil {
		return nil, err
	}
	lines := splitLines(out)
	if len(lines) <= 1 {
		return nil, nil
	}
	// The first line is the result tree; the rest are conflicted paths.
	return lines[1:], nil
}

// FileDiff returns the unified diff of one file within scope.
// Untracked files have no base, so they are diffed against /dev/null.
func FileDiff(s Scope, path string) (string, error) {
	out, err := scopeDiff(s, nil, path)
	if err != nil {
		return "", err
	}
	if out == "" && s.Commit == "" {
		if tracked, _ := runGit(s.Repo, "ls-files", "--error-unmatch", "--", path); tracked == "" {
			return runGitAllowExit(s.Repo, "diff", "--no-index", "--", "/dev/null", path)
		}
	}
	return out, nil
}

// parseCommits parses `git log` lines written with unit separators.
func parseCommits(out string) []Commit {
	var commits []Commit
	scanner := bufio.NewScanner(strings.NewReader(out))
	for scanner.Scan() {
		f := strings.SplitN(scanner.Text(), "\x1f", 5)
		if len(f) != 5 {
			continue
		}
		commits = append(commits, Commit{Hash: f[0], Short: f[1], Subject: f[2], Author: f[3], Date: f[4]})
	}
	return commits
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

// countLines counts newline-terminated lines of a file, for untracked files.
// Unreadable files count as zero.
func countLines(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	return strings.Count(string(data), "\n")
}

// parseWorktrees parses `git worktree list --porcelain`. Each worktree is a
// block of "key value" lines separated by a blank line.
func parseWorktrees(out string) []Worktree {
	var worktrees []Worktree
	var current *Worktree
	flush := func() {
		if current != nil {
			worktrees = append(worktrees, *current)
			current = nil
		}
	}
	scanner := bufio.NewScanner(strings.NewReader(out))
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			flush()
			continue
		}
		key, value, _ := strings.Cut(line, " ")
		if key == "worktree" {
			flush()
			current = &Worktree{Path: value}
			continue
		}
		if current == nil {
			continue
		}
		switch key {
		case "HEAD":
			current.Head = value
		case "branch":
			current.Branch = strings.TrimPrefix(value, "refs/heads/")
		case "detached":
			current.Detached = true
		case "bare":
			current.Bare = true
		}
	}
	flush()
	return worktrees
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
