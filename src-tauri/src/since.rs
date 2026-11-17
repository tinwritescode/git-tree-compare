use crate::gh::remote_for_pr;
use crate::git::{run_git, scope_diff, Scope};
use anyhow::{bail, Result};
use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

/// SinceDiff is one file's diff from the head the reviewer last marked it reviewed at to the
/// current head. Found is false when that commit is not here and could not be fetched, as after a
/// force push that GitHub has since cleaned up; the caller then shows the whole pull request.
#[derive(Serialize, Debug, Default)]
pub struct SinceDiff {
    pub text: String,
    pub found: bool,
}

/// COMMIT_ID matches a full SHA-1 or SHA-256 commit id, so a stored value can never reach git as an option.
pub static COMMIT_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([0-9a-f]{40}|[0-9a-f]{64})$").unwrap());

/// has_commit reports whether repo has the commit id in its object store.
fn has_commit(repo: &str, id: &str) -> bool {
    run_git(repo, &["cat-file", "-e", &format!("{id}^{{commit}}")]).is_ok()
}

/// diff_since returns the diff of path from the commit `from` to the scope's head, with the scope's
/// whitespace and full-file options. A commit missing from the clone is fetched by id from the
/// remote that hosts the pull request at pr_url.
pub fn diff_since(s: &Scope, from: &str, path: &str, pr_url: &str) -> Result<SinceDiff> {
    if !COMMIT_ID.is_match(from) {
        bail!("{from:?} is not a commit id");
    }
    if !has_commit(&s.repo, from) {
        let remotes = run_git(&s.repo, &["remote", "-v"])?;
        // A failed fetch is the answer, not an error: the commit is gone.
        let _ = run_git(
            &s.repo,
            &[
                "fetch",
                "--quiet",
                "--no-tags",
                &remote_for_pr(&remotes, pr_url),
                from,
            ],
        );
        if !has_commit(&s.repo, from) {
            return Ok(SinceDiff::default());
        }
    }
    let since = Scope {
        base: from.to_string(),
        ..s.clone()
    };
    Ok(SinceDiff {
        text: scope_diff(&since, &[], path)?,
        found: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::testutil::*;

    #[test]
    fn diffs_from_the_reviewed_commit() {
        let repo = new_repo();
        let p = repo.path();
        write_file(p.join("a.txt"), "one\n");
        git_in(p, &["add", "."]);
        git_in(p, &["commit", "-q", "-m", "base"]);
        let base = git_in(p, &["rev-parse", "HEAD"]);
        write_file(p.join("a.txt"), "one\ntwo\n");
        git_in(p, &["commit", "-qam", "reviewed"]);
        let reviewed = git_in(p, &["rev-parse", "HEAD"]);
        write_file(p.join("a.txt"), "one\ntwo\nthree\n");
        git_in(p, &["commit", "-qam", "push"]);
        let head = git_in(p, &["rev-parse", "HEAD"]);
        let s = Scope {
            repo: p.to_str().unwrap().into(),
            base,
            head,
            ..Default::default()
        };

        let got = diff_since(&s, &reviewed, "a.txt", "").unwrap();
        assert!(
            got.found && got.text.contains("+three") && !got.text.contains("+two"),
            "{}",
            got.text
        );

        let gone = diff_since(&s, &"0".repeat(40), "a.txt", "").unwrap();
        assert!(!gone.found && gone.text.is_empty());
        assert!(diff_since(&s, "--output=x", "a.txt", "").is_err());
    }
    /// After a force push the reviewed commit is not in the clone. It is fetched from the remote that
    /// hosts the pull request, the way GitHub serves a commit by id.
    #[test]
    fn fetches_a_missing_commit_from_the_pull_requests_remote() {
        let dir = tempfile::tempdir().unwrap();
        let up = dir.path().join("acme").join("widget");
        std::fs::create_dir_all(&up).unwrap();
        git_in(&up, &["init", "-q", "-b", "main"]);
        git_in(&up, &["config", "uploadpack.allowAnySHA1InWant", "true"]);
        write_file(up.join("f.txt"), "one\n");
        git_in(&up, &["add", "."]);
        git_in(&up, &["commit", "-q", "-m", "base"]);
        let base = git_in(&up, &["rev-parse", "HEAD"]);
        write_file(up.join("f.txt"), "two\n");
        git_in(&up, &["commit", "-qam", "reviewed here"]);
        let reviewed = git_in(&up, &["rev-parse", "HEAD"]);
        // The force push: the branch is rebuilt on base, so the reviewed commit is on no branch.
        git_in(&up, &["reset", "-q", "--hard", &base]);
        write_file(up.join("f.txt"), "three\n");
        git_in(&up, &["commit", "-qam", "rewritten"]);
        let head = git_in(&up, &["rev-parse", "HEAD"]);

        let clone = new_repo();
        git_in(
            clone.path(),
            &["remote", "add", "upstream", up.to_str().unwrap()],
        );
        git_in(clone.path(), &["fetch", "-q", "upstream", "main"]);
        let repo = clone.path().to_str().unwrap();
        assert!(
            !has_commit(repo, &reviewed),
            "setup: the clone already has the reviewed commit"
        );

        let s = Scope {
            repo: repo.into(),
            base,
            head,
            ..Default::default()
        };
        let got = diff_since(
            &s,
            &reviewed,
            "f.txt",
            "https://github.com/acme/widget/pull/7",
        )
        .unwrap();
        assert!(
            got.found && got.text.contains("-two") && got.text.contains("+three"),
            "{}",
            got.text
        );
    }
}
