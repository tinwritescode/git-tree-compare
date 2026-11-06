package main

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Opening a pull request for a branch the reviewer reviewed locally. The app never pushes: the
// branch must already be on origin with the reviewed commits.

// PRCreateRequest is the pull request to open: Branch into Base, at the reviewed Head.
type PRCreateRequest struct {
	Base   string `json:"base"`
	Branch string `json:"branch"`
	Head   string `json:"head"` // the commit reviewed, which origin's branch must have
	Title  string `json:"title"`
	Body   string `json:"body"` // sent on stdin
}

// maxPRTitle is GitHub's limit on a pull request's title.
const maxPRTitle = 256

// branchName matches the branch names the app passes to gh: never a flag, never a range or a rev.
var branchName = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._/-]*$`)

func checkBranchName(name string) error {
	if !branchName.MatchString(name) || strings.Contains(name, "..") || strings.HasSuffix(name, "/") || strings.HasSuffix(name, ".lock") {
		return fmt.Errorf("%q is not a branch name a pull request can use", name)
	}
	return nil
}

// prCreateArgs is the gh command line that opens the pull request. Each value follows its flag,
// so a title such as "--web" is the title; the body goes on stdin.
func prCreateArgs(r PRCreateRequest) ([]string, error) {
	title := strings.TrimSpace(r.Title)
	switch {
	case title == "":
		return nil, errors.New("a pull request needs a title")
	case strings.ContainsAny(title, "\r\n"):
		return nil, errors.New("a pull request's title is one line")
	case len(title) > maxPRTitle:
		return nil, fmt.Errorf("a pull request's title can be at most %d characters", maxPRTitle)
	}
	if err := checkBranchName(r.Base); err != nil {
		return nil, err
	}
	if err := checkBranchName(r.Branch); err != nil {
		return nil, err
	}
	if r.Base == r.Branch {
		return nil, fmt.Errorf("%s cannot be merged into itself", r.Branch)
	}
	return []string{"pr", "create", "--base", r.Base, "--head", r.Branch, "--title", title, "--body-file", "-"}, nil
}

// PushState says whether origin has the reviewed commits of a branch, and if not, what to do.
type PushState struct {
	Pushed  bool   `json:"pushed"`
	Message string `json:"message"`
}

// BranchPushState checks the branch on origin as this clone last fetched it. It changes nothing.
func BranchPushState(repo, branch, head string) PushState {
	if err := checkBranchName(branch); err != nil {
		return PushState{Message: err.Error()}
	}
	if !commitID.MatchString(head) {
		return PushState{Message: fmt.Sprintf("%q is not a commit id", head)}
	}
	remote, ok := originBranch(repo, branch)
	if !ok {
		return PushState{Message: fmt.Sprintf("%s is not on origin. Push it (git push -u origin %s), then come back.", branch, branch)}
	}
	if _, err := runGit(repo, "merge-base", "--is-ancestor", head, remote); err != nil {
		return PushState{Message: fmt.Sprintf("origin does not have the commits you reviewed on %s. Push them, then come back.", branch)}
	}
	return PushState{Pushed: true}
}

// CreatePR opens the pull request and returns its URL. It checks the push first, so an unpushed
// branch never reaches GitHub.
func CreatePR(repo string, r PRCreateRequest) (string, error) {
	args, err := prCreateArgs(r)
	if err != nil {
		return "", err
	}
	if state := BranchPushState(repo, r.Branch, r.Head); !state.Pushed {
		return "", errors.New(state.Message)
	}
	out, err := runGHInput(repo, []byte(r.Body), args...)
	if err != nil {
		return "", err
	}
	return lastLine(strings.TrimSpace(string(out))), nil
}
