package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

// markBatchSize is how many viewed mutations go into one request.
const markBatchSize = 50

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

// viewedMutation sets n files as viewed or not viewed in one request. Paths are passed as variables, never spliced in.
func viewedMutation(viewed bool, n int) string {
	name := "unmarkFileAsViewed"
	if viewed {
		name = "markFileAsViewed"
	}
	var decl, body strings.Builder
	decl.WriteString("mutation($id: ID!")
	for i := 0; i < n; i++ {
		fmt.Fprintf(&decl, ", $p%d: String!", i)
		fmt.Fprintf(&body, " m%d: %s(input: {pullRequestId: $id, path: $p%d}) { clientMutationId }", i, name, i)
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
	return runGH(repo, args...)
}

// SetViewed marks the paths as viewed on the pull request, or removes the mark. Repeating it is harmless.
func SetViewed(repo, prID string, paths []string, viewed bool) error {
	for start := 0; start < len(paths); start += markBatchSize {
		end := min(start+markBatchSize, len(paths))
		vars := map[string]string{"id": prID}
		for i, p := range paths[start:end] {
			vars[fmt.Sprintf("p%d", i)] = p
		}
		if _, err := ghGraphQL(repo, viewedMutation(viewed, end-start), vars); err != nil {
			return err
		}
	}
	return nil
}

// PRViewedStates returns the viewer's state of every file in the pull request: VIEWED, UNVIEWED or DISMISSED.
// DISMISSED means the file changed after it was viewed. It reads all pages.
func PRViewedStates(repo, id string) (map[string]string, error) {
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
