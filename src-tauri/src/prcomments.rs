//! The discussion on a pull request: reading it, replying to threads, and resolving them.

use crate::proc::parse_json;
use crate::prsync::{gh_graphql, vars};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

/// PRComment is one comment on a pull request, inline or in the conversation.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PRComment {
    pub author: String,
    pub body: String,
    pub url: String,
    pub created_at: String,
}

/// PRThread is an inline review thread on one line of one file.
/// Line is the line as it is now, or where it was when the thread went outdated.
#[derive(Serialize, Debug, Default)]
pub struct PRThread {
    /// the GraphQL id that reply and resolve take
    pub id: String,
    pub path: String,
    pub line: i64,
    pub resolved: bool,
    pub outdated: bool,
    pub url: String,
    pub comments: Vec<PRComment>,
}

/// PRDiscussion is everything said on a pull request.
/// Truncated is set when GitHub has more threads or comments than were fetched.
#[derive(Serialize, Debug, Default)]
pub struct PRDiscussion {
    pub threads: Vec<PRThread>,
    pub comments: Vec<PRComment>,
    pub truncated: bool,
}

/// PR_COMMENTS_QUERY reads review threads and conversation comments in one request.
/// Counts are read next to each list so a truncated list can be reported.
const PR_COMMENTS_QUERY: &str = r"query($id: ID!) {
  node(id: $id) {
    ... on PullRequest {
      reviewThreads(first: 100) {
        totalCount
        nodes {
          id isResolved isOutdated path line originalLine
          comments(first: 50) { nodes { author { login } body url createdAt } }
        }
      }
      comments(first: 100) {
        totalCount
        nodes { author { login } body url createdAt }
      }
    }
  }
}";

/// GhComment is one comment as GitHub returns it. Author is null for deleted accounts.
#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct GhComment {
    author: Option<Login>,
    body: String,
    url: String,
    created_at: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Login {
    login: String,
}

impl From<GhComment> for PRComment {
    fn from(c: GhComment) -> Self {
        let author = c
            .author
            .map(|a| a.login)
            .filter(|l| !l.is_empty())
            .unwrap_or_else(|| "ghost".into());
        PRComment {
            author,
            body: c.body,
            url: c.url,
            created_at: c.created_at,
        }
    }
}

fn parse_pr_comments(out: &[u8]) -> Result<PRDiscussion> {
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Resp {
        data: Data,
    }
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Data {
        node: Node,
    }
    #[derive(Deserialize, Default)]
    #[serde(default, rename_all = "camelCase")]
    struct Node {
        review_threads: Page<Thread>,
        comments: Page<GhComment>,
    }
    #[derive(Deserialize)]
    #[serde(default, rename_all = "camelCase")]
    struct Page<T> {
        total_count: usize,
        nodes: Vec<T>,
    }
    impl<T> Default for Page<T> {
        fn default() -> Self {
            Page {
                total_count: 0,
                nodes: Vec::new(),
            }
        }
    }
    #[derive(Deserialize, Default)]
    #[serde(default, rename_all = "camelCase")]
    struct Thread {
        id: String,
        is_resolved: bool,
        is_outdated: bool,
        path: String,
        line: Option<i64>,
        original_line: Option<i64>,
        comments: Page<GhComment>,
    }
    let node = parse_json::<Resp>(out)?.data.node;
    let truncated = node.review_threads.total_count > node.review_threads.nodes.len()
        || node.comments.total_count > node.comments.nodes.len();
    let threads = node
        .review_threads
        .nodes
        .into_iter()
        .map(|n| {
            let comments: Vec<PRComment> =
                n.comments.nodes.into_iter().map(PRComment::from).collect();
            PRThread {
                id: n.id,
                path: n.path,
                line: n.line.or(n.original_line).unwrap_or(0),
                resolved: n.is_resolved,
                outdated: n.is_outdated,
                url: comments.first().map(|c| c.url.clone()).unwrap_or_default(),
                comments,
            }
        })
        .collect();
    let comments = node
        .comments
        .nodes
        .into_iter()
        .map(PRComment::from)
        .collect();
    Ok(PRDiscussion {
        threads,
        comments,
        truncated,
    })
}

/// pr_comments returns the discussion on a pull request. It only reads.
pub fn pr_comments(repo: &str, pr_id: &str) -> Result<PRDiscussion> {
    parse_pr_comments(&gh_graphql(
        repo,
        PR_COMMENTS_QUERY,
        &vars([("id", pr_id)]),
    )?)
}

/// REPLY_MUTATION adds a comment to a review thread. The id and text go in as variables.
const REPLY_MUTATION: &str = r"mutation($id: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $id, body: $body}) { comment { id } }
}";

/// resolve_mutation resolves a review thread, or opens it again.
fn resolve_mutation(resolved: bool) -> String {
    let name = if resolved {
        "resolveReviewThread"
    } else {
        "unresolveReviewThread"
    };
    format!(
        "mutation($id: ID!) {{ {name}(input: {{threadId: $id}}) {{ thread {{ isResolved }} }} }}"
    )
}

/// reply_to_thread posts a reply on a review thread.
pub fn reply_to_thread(repo: &str, thread_id: &str, body: &str) -> Result<()> {
    if thread_id.is_empty() || body.trim().is_empty() {
        bail!("a reply needs a thread and some text");
    }
    gh_graphql(
        repo,
        REPLY_MUTATION,
        &vars([("id", thread_id), ("body", body)]),
    )?;
    Ok(())
}

/// set_thread_resolved resolves a review thread, or opens it again. Repeating it is harmless.
pub fn set_thread_resolved(repo: &str, thread_id: &str, resolved: bool) -> Result<()> {
    if thread_id.is_empty() {
        bail!("no review thread to resolve");
    }
    gh_graphql(
        repo,
        &resolve_mutation(resolved),
        &vars([("id", thread_id)]),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testbin::fake_bin;

    #[test]
    fn parses_threads_and_comments() {
        let out = br#"{"data":{"node":{
            "reviewThreads":{"totalCount":2,"nodes":[
                {"id":"T1","isResolved":false,"isOutdated":true,"path":"a.go","line":null,"originalLine":7,
                 "comments":{"nodes":[{"author":null,"body":"hm","url":"u1","createdAt":"t"}]}}]},
            "comments":{"totalCount":1,"nodes":[{"author":{"login":"ann"},"body":"lgtm","url":"u2","createdAt":"t"}]}}}}"#;
        let d = parse_pr_comments(out).unwrap();
        assert!(d.truncated);
        let t = &d.threads[0];
        assert_eq!(
            (t.id.as_str(), t.line, t.outdated, t.url.as_str()),
            ("T1", 7, true, "u1")
        );
        assert_eq!(t.comments[0].author, "ghost");
        assert_eq!(d.comments[0].author, "ann");
    }

    #[test]
    fn empty_discussion_is_empty_lists() {
        let d = parse_pr_comments(br#"{"data":{"node":{}}}"#).unwrap();
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["threads"], serde_json::json!([]));
        assert_eq!(v["comments"], serde_json::json!([]));
    }

    #[test]
    fn reply_and_resolve_check_input_and_send_variables() {
        assert!(reply_to_thread(".", "T1", "  ").is_err());
        assert!(set_thread_resolved(".", "", true).is_err());
        let fake = fake_bin("gh", "printf '%s\\n' \"$*\" >> \"$LOG\"\n");
        reply_to_thread(fake.dir(), "T1", "--done").unwrap();
        set_thread_resolved(fake.dir(), "T1", false).unwrap();
        let log = fake.log();
        assert!(
            log.contains("body=--done")
                && log.contains("id=T1")
                && log.contains("unresolveReviewThread"),
            "{log}"
        );
    }
}
