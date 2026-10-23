package main

import "fmt"

// Scope says what is being compared: the working tree against base, or one commit.
type Scope struct {
	Repo     string `json:"repo"`
	Base     string `json:"base"`
	Commit   string `json:"commit"`
	IgnoreWS bool   `json:"ignoreWS"`
	FullFile bool   `json:"fullFile,omitempty"` // show the whole file as context, not just the changed hunks
}

// fullFileContext asks git for more context lines than any file has, so each diff holds the whole file.
const fullFileContext = "-U1000000"

// diffArgs builds the git command for a diff within scope. flags are extra
// options such as --name-status. path limits the output to one file when set.
// mb is the merge-base of base and HEAD, used only for the working tree.
func diffArgs(s Scope, mb string, flags []string, path string) []string {
	var args []string
	target := mb
	if s.Commit != "" {
		args = []string{"show", "--format=", "-M"}
		target = s.Commit
	} else {
		args = []string{"diff", "-M"}
	}
	args = append(args, flags...)
	if s.IgnoreWS {
		args = append(args, "-w")
	}
	if s.FullFile {
		args = append(args, fullFileContext)
	}
	args = append(args, target)
	if path != "" {
		args = append(args, "--", path)
	}
	return args
}

// scopeDiff runs a diff within scope and returns its output.
func scopeDiff(s Scope, flags []string, path string) (string, error) {
	mb := ""
	if s.Commit == "" {
		var err error
		if mb, err = MergeBase(s.Repo, s.Base); err != nil {
			return "", err
		}
	}
	return runGit(s.Repo, diffArgs(s, mb, flags, path)...)
}

// scopeLabel names the scope for file names and messages.
func scopeLabel(s Scope) string {
	if s.Commit != "" {
		return fmt.Sprintf("commit-%.8s", s.Commit)
	}
	return "working-tree"
}
