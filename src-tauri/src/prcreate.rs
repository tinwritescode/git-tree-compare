//! Opening a pull request for a branch the reviewer reviewed locally. The app never pushes: the
//! branch must already be on origin with the reviewed commits.

use crate::gh::run_gh_input;
use crate::git::run_git;
use crate::localreview::origin_branch;
use crate::proc::last_line;
use crate::since::COMMIT_ID;
use anyhow::{anyhow, bail, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

/// PRCreateRequest is the pull request to open: Branch into Base, at the reviewed Head.
#[derive(Deserialize, Debug, Default)]
#[serde(default)]
pub struct PRCreateRequest {
    pub base: String,
    pub branch: String,
    /// the commit reviewed, which origin's branch must have
    pub head: String,
    pub title: String,
    /// sent on stdin
    pub body: String,
}

/// MAX_PR_TITLE is GitHub's limit on a pull request's title.
const MAX_PR_TITLE: usize = 256;

/// BRANCH_NAME matches the branch names the app passes to gh: never a flag, never a range or a rev.
static BRANCH_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_][A-Za-z0-9._/-]*$").unwrap());

fn check_branch_name(name: &str) -> Result<()> {
    if !BRANCH_NAME.is_match(name)
        || name.contains("..")
        || name.ends_with('/')
        || name.ends_with(".lock")
    {
        bail!("{name:?} is not a branch name a pull request can use");
    }
    Ok(())
}

/// pr_create_args is the gh command line that opens the pull request. Each value follows its flag,
/// so a title such as "--web" is the title; the body goes on stdin.
fn pr_create_args(r: &PRCreateRequest) -> Result<Vec<String>> {
    let title = r.title.trim();
    if title.is_empty() {
        bail!("a pull request needs a title");
    }
    if title.contains(['\r', '\n']) {
        bail!("a pull request's title is one line");
    }
    if title.len() > MAX_PR_TITLE {
        bail!("a pull request's title can be at most {MAX_PR_TITLE} characters");
    }
    check_branch_name(&r.base)?;
    check_branch_name(&r.branch)?;
    if r.base == r.branch {
        bail!("{} cannot be merged into itself", r.branch);
    }
    Ok([
        "pr",
        "create",
        "--base",
        &r.base,
        "--head",
        &r.branch,
        "--title",
        title,
        "--body-file",
        "-",
    ]
    .map(String::from)
    .to_vec())
}

/// PushState says whether origin has the reviewed commits of a branch, and if not, what to do.
#[derive(Serialize, Debug, Default)]
pub struct PushState {
    pub pushed: bool,
    pub message: String,
}

/// branch_push_state checks the branch on origin as this clone last fetched it. It changes nothing.
pub fn branch_push_state(repo: &str, branch: &str, head: &str) -> PushState {
    let message = |m: String| PushState {
        pushed: false,
        message: m,
    };
    if let Err(e) = check_branch_name(branch) {
        return message(e.to_string());
    }
    if !COMMIT_ID.is_match(head) {
        return message(format!("{head:?} is not a commit id"));
    }
    let Some(remote) = origin_branch(repo, branch) else {
        return message(format!(
            "{branch} is not on origin. Push it (git push -u origin {branch}), then come back."
        ));
    };
    if run_git(repo, &["merge-base", "--is-ancestor", head, &remote]).is_err() {
        return message(format!(
            "origin does not have the commits you reviewed on {branch}. Push them, then come back."
        ));
    }
    PushState {
        pushed: true,
        message: String::new(),
    }
}

/// create_pr opens the pull request and returns its URL. It checks the push first, so an unpushed
/// branch never reaches GitHub.
pub fn create_pr(repo: &str, r: &PRCreateRequest) -> Result<String> {
    let args = pr_create_args(r)?;
    let state = branch_push_state(repo, &r.branch, &r.head);
    if !state.pushed {
        return Err(anyhow!(state.message));
    }
    let out = run_gh_input(
        repo,
        r.body.as_bytes(),
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
    )?;
    Ok(last_line(String::from_utf8_lossy(&out).trim()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::testutil::*;
    use crate::testbin::fake_bin;

    fn req(title: &str, base: &str, branch: &str) -> PRCreateRequest {
        PRCreateRequest {
            base: base.into(),
            branch: branch.into(),
            head: String::new(),
            title: title.into(),
            body: "b".into(),
        }
    }

    #[test]
    fn args_keep_values_after_their_flags() {
        let args = pr_create_args(&req(" --web ", "main", "feat/x")).unwrap();
        assert_eq!(
            args.join(" "),
            "pr create --base main --head feat/x --title --web --body-file -"
        );
    }

    #[test]
    fn args_reject_bad_titles_and_branches() {
        for (title, base, branch) in [
            ("", "main", "feat"),
            ("a\nb", "main", "feat"),
            (&"x".repeat(MAX_PR_TITLE + 1), "main", "feat"),
            ("t", "-main", "feat"),
            ("t", "main", "a..b"),
            ("t", "main", "feat/"),
            ("t", "main", "feat.lock"),
            ("t", "main", "main"),
        ] {
            assert!(
                pr_create_args(&req(title, base, branch)).is_err(),
                "{title:?} {base} {branch}"
            );
        }
    }

    /// pushed_repo makes a clone whose origin has feat at its first commit, and a local second commit.
    fn pushed_repo() -> (tempfile::TempDir, tempfile::TempDir, String, String) {
        let origin = new_repo();
        let o = origin.path();
        write_file(o.join("a.txt"), "one\n");
        git_in(o, &["add", "."]);
        git_in(o, &["commit", "-q", "-m", "first"]);
        git_in(o, &["branch", "feat"]);
        let clone = tempfile::tempdir().unwrap();
        git_in(clone.path(), &["clone", "-q", o.to_str().unwrap(), "."]);
        git_in(clone.path(), &["checkout", "-q", "feat"]);
        let pushed = git_in(clone.path(), &["rev-parse", "HEAD"]);
        write_file(clone.path().join("b.txt"), "two\n");
        git_in(clone.path(), &["add", "."]);
        git_in(clone.path(), &["commit", "-q", "-m", "local"]);
        let local = git_in(clone.path(), &["rev-parse", "HEAD"]);
        (origin, clone, pushed, local)
    }

    #[test]
    fn push_state_reads_origin() {
        let (_origin, clone, pushed, local) = pushed_repo();
        let repo = clone.path().to_str().unwrap();
        assert!(branch_push_state(repo, "feat", &pushed).pushed);
        assert!(branch_push_state(repo, "feat", &local)
            .message
            .contains("origin does not have the commits"));
        assert!(branch_push_state(repo, "other", &pushed)
            .message
            .contains("other is not on origin"));
        assert!(branch_push_state(repo, "feat", "HEAD")
            .message
            .contains("is not a commit id"));
    }

    #[test]
    fn create_pr_never_reaches_gh_when_unpushed() {
        let (_origin, clone, pushed, local) = pushed_repo();
        let repo = clone.path().to_str().unwrap();
        let fake = fake_bin("gh", "printf '%s\\n' \"$*\" >> \"$LOG\"; cat >> \"$LOG\"; echo 'Creating...'; echo https://github.com/o/n/pull/9\n");
        let mut r = req("Add b", "main", "feat");
        r.head = local;
        assert!(create_pr(repo, &r).is_err());
        assert_eq!(fake.log(), "");
        r.head = pushed;
        assert_eq!(
            create_pr(repo, &r).unwrap(),
            "https://github.com/o/n/pull/9"
        );
        assert_eq!(
            fake.log(),
            "pr create --base main --head feat --title Add b --body-file -\nb"
        );
    }
}
