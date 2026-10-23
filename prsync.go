package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// markBatchSize is how many markFileAsViewed mutations go into one request.
const markBatchSize = 50

// ErrNoPullRequest means the current branch has no open pull request to sync to.
var ErrNoPullRequest = errors.New("This branch has no open pull request, so there is nothing to sync to.")

// SyncResult says what a sync did on the pull request.
type SyncResult struct {
	Number      int `json:"number"`
	Marked      int `json:"marked"`      // reviewed here, now viewed on GitHub
	AlreadyDone int `json:"alreadyDone"` // already viewed on GitHub
	NotInPR     int `json:"notInPR"`     // reviewed here, but not a changed file of the pull request
}

// prFilesQuery lists the pull request's files with the viewer's viewed state, one page at a time.
const prFilesQuery = `query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequest {
      files(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { path viewerViewedState }
      }
    }
  }
}`

// parsePRFiles reads one page of prFilesQuery. It returns the viewed state per path and the next cursor.
func parsePRFiles(out []byte) (map[string]string, string, bool, error) {
	var resp struct {
		Data struct {
			Node struct {
				Files struct {
					PageInfo struct {
						HasNextPage bool   `json:"hasNextPage"`
						EndCursor   string `json:"endCursor"`
					} `json:"pageInfo"`
					Nodes []struct {
						Path  string `json:"path"`
						State string `json:"viewerViewedState"`
					} `json:"nodes"`
				} `json:"files"`
			} `json:"node"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		return nil, "", false, err
	}
	states := map[string]string{}
	for _, n := range resp.Data.Node.Files.Nodes {
		states[n.Path] = n.State
	}
	page := resp.Data.Node.Files.PageInfo
	return states, page.EndCursor, page.HasNextPage, nil
}

// markMutation marks n files as viewed in one request. Paths are passed as variables, never spliced in.
func markMutation(n int) string {
	var decl, body strings.Builder
	decl.WriteString("mutation($id: ID!")
	for i := 0; i < n; i++ {
		fmt.Fprintf(&decl, ", $p%d: String!", i)
		fmt.Fprintf(&body, " m%d: markFileAsViewed(input: {pullRequestId: $id, path: $p%d}) { clientMutationId }", i, i)
	}
	decl.WriteString(") {")
	return decl.String() + body.String() + " }"
}

// ghGraphQL runs a GraphQL query through the gh CLI, with string variables.
func ghGraphQL(repo, query string, vars map[string]string) ([]byte, error) {
	args := []string{"api", "graphql", "-f", "query=" + query}
	for k, v := range vars {
		args = append(args, "-f", k+"="+v)
	}
	cmd := exec.Command("gh", args...)
	cmd.Dir = repo
	out, err := cmd.Output()
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && len(exit.Stderr) > 0 {
			return nil, fmt.Errorf("GitHub said: %s", strings.TrimSpace(string(exit.Stderr)))
		}
		return nil, err
	}
	return out, nil
}

// SyncReviewed marks the given paths as viewed on the current branch's pull request.
// It only marks files that are changed in that pull request and not yet viewed there.
func SyncReviewed(repo string, paths []string) (SyncResult, error) {
	pr := PRStatus(repo)
	if pr == nil || pr.ID == "" {
		return SyncResult{}, ErrNoPullRequest
	}
	result := SyncResult{Number: pr.Number}

	files, err := prViewedStates(repo, pr.ID)
	if err != nil {
		return result, err
	}

	var todo []string
	for _, p := range paths {
		state, inPR := files[p]
		switch {
		case !inPR:
			result.NotInPR++
		case state == "VIEWED":
			result.AlreadyDone++
		default:
			todo = append(todo, p)
		}
	}

	for start := 0; start < len(todo); start += markBatchSize {
		end := min(start+markBatchSize, len(todo))
		vars := map[string]string{"id": pr.ID}
		for i, p := range todo[start:end] {
			vars[fmt.Sprintf("p%d", i)] = p
		}
		if _, err := ghGraphQL(repo, markMutation(end-start), vars); err != nil {
			return result, err
		}
		result.Marked += end - start
	}
	return result, nil
}

// prViewedStates returns the viewed state of every file in the pull request, reading all pages.
func prViewedStates(repo, id string) (map[string]string, error) {
	all := map[string]string{}
	cursor := ""
	for {
		vars := map[string]string{"id": id}
		if cursor != "" {
			vars["cursor"] = cursor
		}
		out, err := ghGraphQL(repo, prFilesQuery, vars)
		if err != nil {
			return nil, err
		}
		states, next, more, err := parsePRFiles(out)
		if err != nil {
			return nil, err
		}
		for k, v := range states {
			all[k] = v
		}
		if !more {
			return all, nil
		}
		cursor = next
	}
}
