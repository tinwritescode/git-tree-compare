package main

import (
	"encoding/json"
)

// PRComment is one comment on a pull request, inline or in the conversation.
type PRComment struct {
	Author    string `json:"author"`
	Body      string `json:"body"`
	URL       string `json:"url"`
	CreatedAt string `json:"createdAt"`
}

// PRThread is an inline review thread on one line of one file.
// Line is the line as it is now, or where it was when the thread went outdated.
type PRThread struct {
	Path     string      `json:"path"`
	Line     int         `json:"line"`
	Resolved bool        `json:"resolved"`
	Outdated bool        `json:"outdated"`
	URL      string      `json:"url"`
	Comments []PRComment `json:"comments"`
}

// PRDiscussion is everything said on the open pull request.
// Truncated is set when GitHub has more threads or comments than were fetched.
type PRDiscussion struct {
	Number    int         `json:"number"`
	URL       string      `json:"url"`
	Threads   []PRThread  `json:"threads"`
	Comments  []PRComment `json:"comments"`
	Truncated bool        `json:"truncated"`
}

// prCommentsQuery reads review threads and conversation comments in one request.
// Counts are read next to each list so a truncated list can be reported.
const prCommentsQuery = `query($id: ID!) {
  node(id: $id) {
    ... on PullRequest {
      reviewThreads(first: 100) {
        totalCount
        nodes {
          isResolved isOutdated path line originalLine
          comments(first: 50) { nodes { author { login } body url createdAt } }
        }
      }
      comments(first: 100) {
        totalCount
        nodes { author { login } body url createdAt }
      }
    }
  }
}`

// ghComment is one comment as GitHub returns it. Author is null for deleted accounts.
type ghComment struct {
	Author *struct {
		Login string `json:"login"`
	} `json:"author"`
	Body      string `json:"body"`
	URL       string `json:"url"`
	CreatedAt string `json:"createdAt"`
}

func (c ghComment) toComment() PRComment {
	author := "ghost"
	if c.Author != nil && c.Author.Login != "" {
		author = c.Author.Login
	}
	return PRComment{Author: author, Body: c.Body, URL: c.URL, CreatedAt: c.CreatedAt}
}

// parsePRComments reads the output of prCommentsQuery.
func parsePRComments(out []byte) (PRDiscussion, error) {
	var resp struct {
		Data struct {
			Node struct {
				ReviewThreads struct {
					TotalCount int `json:"totalCount"`
					Nodes      []struct {
						IsResolved   bool   `json:"isResolved"`
						IsOutdated   bool   `json:"isOutdated"`
						Path         string `json:"path"`
						Line         *int   `json:"line"`
						OriginalLine *int   `json:"originalLine"`
						Comments     struct {
							Nodes []ghComment `json:"nodes"`
						} `json:"comments"`
					} `json:"nodes"`
				} `json:"reviewThreads"`
				Comments struct {
					TotalCount int         `json:"totalCount"`
					Nodes      []ghComment `json:"nodes"`
				} `json:"comments"`
			} `json:"node"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		return PRDiscussion{}, err
	}
	node := resp.Data.Node
	d := PRDiscussion{Threads: []PRThread{}, Comments: []PRComment{}}
	for _, n := range node.ReviewThreads.Nodes {
		thread := PRThread{
			Path:     n.Path,
			Resolved: n.IsResolved,
			Outdated: n.IsOutdated,
			Comments: []PRComment{},
		}
		switch {
		case n.Line != nil:
			thread.Line = *n.Line
		case n.OriginalLine != nil:
			thread.Line = *n.OriginalLine
		}
		for _, c := range n.Comments.Nodes {
			thread.Comments = append(thread.Comments, c.toComment())
		}
		if len(thread.Comments) > 0 {
			thread.URL = thread.Comments[0].URL
		}
		d.Threads = append(d.Threads, thread)
	}
	for _, c := range node.Comments.Nodes {
		d.Comments = append(d.Comments, c.toComment())
	}
	d.Truncated = node.ReviewThreads.TotalCount > len(node.ReviewThreads.Nodes) ||
		node.Comments.TotalCount > len(node.Comments.Nodes)
	return d, nil
}

// PRComments returns the discussion on the current branch's pull request. It only reads.
func PRComments(repo string) (PRDiscussion, error) {
	pr := PRStatus(repo)
	if pr == nil || pr.ID == "" {
		return PRDiscussion{}, ErrNoPullRequest
	}
	out, err := ghGraphQL(repo, prCommentsQuery, map[string]string{"id": pr.ID})
	if err != nil {
		return PRDiscussion{}, err
	}
	d, err := parsePRComments(out)
	if err != nil {
		return PRDiscussion{}, err
	}
	d.Number = pr.Number
	d.URL = pr.URL
	return d, nil
}
