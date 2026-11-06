package main

import (
	"fmt"
	"strings"
)

// replyMutation adds a comment to a review thread. The id and text go in as variables.
const replyMutation = `mutation($id: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $id, body: $body}) { comment { id } }
}`

// resolveMutation resolves a review thread, or opens it again.
func resolveMutation(resolved bool) string {
	name := "unresolveReviewThread"
	if resolved {
		name = "resolveReviewThread"
	}
	return fmt.Sprintf(`mutation($id: ID!) { %s(input: {threadId: $id}) { thread { isResolved } } }`, name)
}

// ReplyToThread posts a reply on a review thread.
func ReplyToThread(repo, threadID, body string) error {
	if threadID == "" || strings.TrimSpace(body) == "" {
		return fmt.Errorf("a reply needs a thread and some text")
	}
	_, err := ghGraphQL(repo, replyMutation, map[string]string{"id": threadID, "body": body})
	return err
}

// SetThreadResolved resolves a review thread, or opens it again. Repeating it is harmless.
func SetThreadResolved(repo, threadID string, resolved bool) error {
	if threadID == "" {
		return fmt.Errorf("no review thread to resolve")
	}
	_, err := ghGraphQL(repo, resolveMutation(resolved), map[string]string{"id": threadID})
	return err
}
