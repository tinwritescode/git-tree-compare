//! Finishing a review: the verdict, the summary and every draft comment, posted in one request.

use crate::gh::{parse_pr_url, run_gh_input};
use crate::since::COMMIT_ID;
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};

/// ReviewDraft is one comment of a pending review, as the frontend keeps it until the review is
/// submitted. Kind is "line" or "file"; Line and Side apply to line comments only.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ReviewDraft {
    pub kind: String,
    pub path: String,
    pub line: i64,
    /// RIGHT for the head, LEFT for the base
    pub side: String,
    pub body: String,
}

/// ReviewSubmission is a finished review: the verdict, the summary, and the drafts, posted at Head.
#[derive(Deserialize, Debug, Default)]
#[serde(default)]
pub struct ReviewSubmission {
    pub head: String,
    /// COMMENT, APPROVE or REQUEST_CHANGES
    pub event: String,
    pub body: String,
    pub drafts: Vec<ReviewDraft>,
}

/// ReviewComment is one entry of comments[] in GitHub's create-review request.
#[derive(Serialize, Debug, PartialEq)]
struct ReviewComment {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    side: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subject_type: Option<&'static str>,
    body: String,
}

pub const REVIEW_EVENTS: [&str; 3] = ["COMMENT", "APPROVE", "REQUEST_CHANGES"];

/// review_request_json builds the body of POST repos/{owner}/{repo}/pulls/{n}/reviews. It checks the
/// shape only; which verdicts need a summary is the frontend's call, and GitHub has the last word.
fn review_request_json(s: &ReviewSubmission) -> Result<Vec<u8>> {
    if !COMMIT_ID.is_match(&s.head) {
        bail!("{:?} is not a commit id", s.head);
    }
    if !REVIEW_EVENTS.contains(&s.event.as_str()) {
        bail!("unknown review verdict {:?}", s.event);
    }
    let comments = s
        .drafts
        .iter()
        .map(draft_comment)
        .collect::<Result<Vec<_>>>()?;
    #[derive(Serialize)]
    struct Request<'a> {
        commit_id: &'a str,
        event: &'a str,
        body: &'a str,
        comments: Vec<ReviewComment>,
    }
    Ok(serde_json::to_vec(&Request {
        commit_id: &s.head,
        event: &s.event,
        body: &s.body,
        comments,
    })?)
}

/// draft_comment turns one draft into its place in comments[].
fn draft_comment(d: &ReviewDraft) -> Result<ReviewComment> {
    if d.path.is_empty() || d.body.trim().is_empty() {
        bail!("a draft comment needs a file and some text");
    }
    let mut c = ReviewComment {
        path: d.path.clone(),
        line: None,
        side: None,
        subject_type: None,
        body: d.body.clone(),
    };
    match d.kind.as_str() {
        "line" => {
            if d.line < 1 || (d.side != "LEFT" && d.side != "RIGHT") {
                bail!("draft on {} has no valid line", d.path);
            }
            c.line = Some(d.line);
            c.side = Some(d.side.clone());
        }
        "file" => c.subject_type = Some("file"),
        kind => bail!("unknown draft kind {kind:?}"),
    }
    Ok(c)
}

/// reviews_endpoint is the REST path for a pull request's reviews, from its GitHub URL.
fn reviews_endpoint(pr_url: &str) -> Result<String> {
    let (slug, number) = parse_pr_url(pr_url)
        .ok_or_else(|| anyhow!("{pr_url:?} is not a pull request on GitHub"))?;
    Ok(format!("repos/{slug}/pulls/{number}/reviews"))
}

/// submit_review posts the review with all its drafts in one request. Nothing is posted when the
/// request cannot be built; when GitHub refuses it, the error says why and nothing was posted.
pub fn submit_review(repo: &str, pr_url: &str, s: &ReviewSubmission) -> Result<()> {
    let endpoint = reviews_endpoint(pr_url)?;
    let body = review_request_json(s)?;
    run_gh_input(
        repo,
        &body,
        &["api", &endpoint, "--method", "POST", "--input", "-"],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testbin::fake_bin;

    const HEAD: &str = "0123456789abcdef0123456789abcdef01234567";

    fn draft(kind: &str, path: &str, line: i64, side: &str, body: &str) -> ReviewDraft {
        ReviewDraft {
            kind: kind.into(),
            path: path.into(),
            line,
            side: side.into(),
            body: body.into(),
        }
    }

    #[test]
    fn maps_drafts_to_github_comments() {
        let out = review_request_json(&ReviewSubmission {
            head: HEAD.into(),
            event: "REQUEST_CHANGES".into(),
            body: "Two things.".into(),
            drafts: vec![
                draft("line", "app.go", 12, "RIGHT", "rename this"),
                draft("line", "old.go", 3, "LEFT", "why remove?"),
                draft("file", "go.mod", 0, "", "bump separately"),
            ],
        })
        .unwrap();
        let want = format!(
            r#"{{"commit_id":"{HEAD}","event":"REQUEST_CHANGES","body":"Two things.","comments":[{{"path":"app.go","line":12,"side":"RIGHT","body":"rename this"}},{{"path":"old.go","line":3,"side":"LEFT","body":"why remove?"}},{{"path":"go.mod","subject_type":"file","body":"bump separately"}}]}}"#
        );
        assert_eq!(String::from_utf8(out).unwrap(), want);
    }

    #[test]
    fn no_drafts_is_an_empty_list() {
        let out = review_request_json(&ReviewSubmission {
            head: HEAD.into(),
            event: "APPROVE".into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            String::from_utf8(out).unwrap(),
            format!(r#"{{"commit_id":"{HEAD}","event":"APPROVE","body":"","comments":[]}}"#)
        );
    }

    #[test]
    fn rejects_bad_input() {
        let line = draft("line", "a.go", 1, "RIGHT", "x");
        let sub = |head: &str, event: &str, d: ReviewDraft| ReviewSubmission {
            head: head.into(),
            event: event.into(),
            body: String::new(),
            drafts: vec![d],
        };
        assert!(review_request_json(&sub(HEAD, "COMMENT", line.clone())).is_ok());
        for (name, s) in [
            ("short head", sub("abc123", "COMMENT", line.clone())),
            ("unknown event", sub(HEAD, "MERGE", line.clone())),
            (
                "line zero",
                sub(HEAD, "COMMENT", draft("line", "a.go", 0, "RIGHT", "x")),
            ),
            (
                "bad side",
                sub(HEAD, "COMMENT", draft("line", "a.go", 1, "UP", "x")),
            ),
            (
                "empty body",
                sub(HEAD, "COMMENT", draft("line", "a.go", 1, "RIGHT", " ")),
            ),
            (
                "no path",
                sub(HEAD, "COMMENT", draft("file", "", 0, "", "x")),
            ),
            (
                "unknown kind",
                sub(HEAD, "COMMENT", draft("hunk", "a.go", 1, "RIGHT", "x")),
            ),
        ] {
            assert!(review_request_json(&s).is_err(), "{name} was accepted");
        }
    }

    #[test]
    fn posts_to_the_reviews_endpoint_on_stdin() {
        assert!(submit_review(".", "https://example.com/x", &ReviewSubmission::default()).is_err());
        let fake = fake_bin("gh", "printf '%s\\n' \"$*\" >> \"$LOG\"; cat >> \"$LOG\"\n");
        let s = ReviewSubmission {
            head: HEAD.into(),
            event: "COMMENT".into(),
            body: "hi".into(),
            drafts: vec![],
        };
        submit_review(fake.dir(), "https://github.com/o/n/pull/4", &s).unwrap();
        let log = fake.log();
        assert!(
            log.starts_with("api repos/o/n/pulls/4/reviews --method POST --input -\n"),
            "{log}"
        );
        assert!(log.contains(r#""body":"hi""#), "{log}");
    }
}
