use crate::deeplink::SLUG_PATTERN;
use crate::git::run_git;
use crate::proc::{self, parse_json, parse_value, split_lines};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::process::Command;

/// PR_LIST_FIELDS are the pull request fields read from `gh pr list`.
const PR_LIST_FIELDS: &str = "id,number,title,url,author,headRefName,headRefOid,baseRefName,isDraft,additions,deletions,changedFiles,updatedAt,reviewDecision,mergeable";

/// PR_LIST_LIMIT caps how many open pull requests are listed.
const PR_LIST_LIMIT: &str = "100";

/// PRInfo is one open pull request. Mergeable is MERGEABLE, CONFLICTING, or UNKNOWN as reported by GitHub.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PRInfo {
    pub id: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub author: String,
    #[serde(rename = "headRefName")]
    pub head_ref: String,
    #[serde(rename = "headRefOid")]
    pub head_oid: String,
    #[serde(rename = "baseRefName")]
    pub base_ref: String,
    pub is_draft: bool,
    pub additions: i64,
    pub deletions: i64,
    pub changed_files: i64,
    pub updated_at: String,
    pub review_decision: String,
    pub mergeable: String,
    /// requested (waiting for the viewer's review), mine (opened by the viewer), or other, in the order the list shows them
    pub group: String,
    /// opened by the viewer, who cannot approve it or request changes on it
    pub is_mine: bool,
}

/// ReviewTarget is the pair of commits a pull request's diff is taken between.
/// Base is the merge base, so the diff matches GitHub's Files tab even when the base branch has moved.
#[derive(Serialize, Debug)]
pub struct ReviewTarget {
    pub base: String,
    pub head: String,
}

/// parse_pr_list reads `gh pr list --json` output and sorts each pull request into its group.
pub fn parse_pr_list(out: &[u8], viewer: &str, requested: &HashSet<i64>) -> Result<Vec<PRInfo>> {
    let raw: Vec<Value> = serde_json::from_slice(out)?;
    raw.into_iter()
        .map(|mut v| {
            // gh writes the author as {login}, and null for a deleted account.
            let login = v["author"]["login"]
                .as_str()
                .filter(|l| !l.is_empty())
                .unwrap_or("ghost")
                .to_string();
            if let Some(fields) = v.as_object_mut() {
                fields.insert("author".into(), login.into());
            }
            let mut pr: PRInfo = parse_value(v)?;
            pr.is_mine = pr.author == viewer;
            pr.group = if requested.contains(&pr.number) {
                "requested"
            } else if pr.is_mine {
                "mine"
            } else {
                "other"
            }
            .into();
            Ok(pr)
        })
        .collect()
}

/// run_gh runs the gh CLI in repo. Its error message says what GitHub or gh reported.
pub fn run_gh(repo: &str, args: &[&str]) -> Result<Vec<u8>> {
    run_gh_input(repo, b"", args)
}

/// run_gh_input runs the gh CLI in repo with input on stdin, such as a request body for `--input -`.
pub fn run_gh_input(repo: &str, input: &[u8], args: &[&str]) -> Result<Vec<u8>> {
    let mut cmd = Command::new("gh");
    cmd.args(args).current_dir(repo);
    let out = proc::run(cmd, input)?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        if stderr.trim().is_empty() {
            return Err(anyhow!("gh {}", out.status));
        }
        return Err(anyhow!("GitHub said: {}", stderr.trim()));
    }
    Ok(out.stdout)
}

/// list_prs returns the repository's open pull requests, grouped for the viewer.
pub fn list_prs(repo: &str) -> Result<Vec<PRInfo>> {
    let list = ["pr", "list", "--state", "open", "--limit", PR_LIST_LIMIT];
    let out = run_gh(repo, &[&list[..], &["--json", PR_LIST_FIELDS]].concat())?;
    let login = run_gh(repo, &["api", "user", "--jq", ".login"])?;
    let asked = run_gh(
        repo,
        &[
            &list[..],
            &["--search", "review-requested:@me", "--json", "number"],
        ]
        .concat(),
    )?;
    #[derive(Deserialize)]
    struct Number {
        number: i64,
    }
    let numbers: Vec<Number> = parse_json(&asked)?;
    let requested = numbers.into_iter().map(|n| n.number).collect();
    parse_pr_list(&out, String::from_utf8_lossy(&login).trim(), &requested)
}

/// current_pr_number returns the open pull request of the checked-out branch, or 0 when it has none.
pub fn current_pr_number(repo: &str) -> i64 {
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Pr {
        number: i64,
        state: String,
    }
    let Ok(out) = run_gh(repo, &["pr", "view", "--json", "number,state"]) else {
        return 0;
    };
    match parse_json::<Pr>(&out) {
        Ok(pr) if pr.state == "OPEN" => pr.number,
        _ => 0,
    }
}

/// remote_for_pr picks the remote that hosts the pull request, so forks with an `upstream` work.
/// remotes is `git remote -v` output. It falls back to origin.
pub fn remote_for_pr(remotes: &str, pr_url: &str) -> String {
    parse_pr_url(pr_url)
        .and_then(|(slug, _)| remote_matching(remotes, &slug))
        .unwrap_or_else(|| "origin".into())
}

/// parse_pr_url reads owner/name and the number from https://github.com/owner/name/pull/N.
pub fn parse_pr_url(pr_url: &str) -> Option<(String, i64)> {
    let path = pr_url.strip_prefix("https://github.com/")?;
    let (slug, rest) = path.split_once("/pull/")?;
    let number: i64 = rest.parse().ok()?;
    (number >= 1 && SLUG_PATTERN.is_match(slug)).then(|| (slug.to_string(), number))
}

/// remote_matching returns the first remote whose URL ends in slug, such as owner/name.
/// remotes is `git remote -v` output.
pub fn remote_matching(remotes: &str, slug: &str) -> Option<String> {
    split_lines(remotes).into_iter().find_map(|line| {
        let (name, rest) = line.split_once('\t')?;
        let url = rest.split(' ').next().unwrap_or_default();
        let url = url.strip_suffix(".git").unwrap_or(url);
        (url.ends_with(&format!("/{slug}")) || url.ends_with(&format!(":{slug}")))
            .then(|| name.to_string())
    })
}

/// prepare_review fetches a pull request into refs of the app's own and returns the commits to diff.
/// It reads refs/pull/N/head, which also exists for forks, and never touches the checkout or its branches.
pub fn prepare_review(repo: &str, pr: &PRInfo) -> Result<ReviewTarget> {
    let remotes = run_git(repo, &["remote", "-v"])?;
    let head_ref = format!("refs/git-tree-compare/pr/{}/head", pr.number);
    let base_ref = format!("refs/git-tree-compare/pr/{}/base", pr.number);
    run_git(
        repo,
        &[
            "fetch",
            "--quiet",
            "--no-tags",
            &remote_for_pr(&remotes, &pr.url),
            &format!("+refs/pull/{}/head:{head_ref}", pr.number),
            &format!("+refs/heads/{}:{base_ref}", pr.base_ref),
        ],
    )?;
    let head = run_git(repo, &["rev-parse", &head_ref])?;
    let base = run_git(repo, &["merge-base", &base_ref, &head_ref])?;
    Ok(ReviewTarget {
        base: base.trim().into(),
        head: head.trim().into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_pull_requests_for_the_viewer() {
        let out = br#"[
            {"number": 1, "title": "asked", "author": {"login": "ann"}, "reviewDecision": null},
            {"number": 2, "title": "mine", "author": {"login": "me"}},
            {"number": 3, "title": "ghost", "author": null}
        ]"#;
        let prs = parse_pr_list(out, "me", &HashSet::from([1])).unwrap();
        let got: Vec<_> = prs
            .iter()
            .map(|p| format!("{} {} {} {}", p.number, p.author, p.group, p.is_mine))
            .collect();
        assert_eq!(
            got,
            [
                "1 ann requested false",
                "2 me mine true",
                "3 ghost other false"
            ]
        );
    }

    #[test]
    fn serializes_with_the_frontend_names() {
        let pr = PRInfo {
            head_ref: "feat".into(),
            ..Default::default()
        };
        let v = serde_json::to_value(&pr).unwrap();
        assert_eq!(v["headRefName"], "feat");
        assert!(v.get("isMine").is_some() && v.get("changedFiles").is_some());
    }

    #[test]
    fn picks_the_remote_that_hosts_the_pull_request() {
        let remotes = "origin\tgit@github.com:me/repo.git (fetch)\nupstream\thttps://github.com/org/repo (fetch)\n";
        assert_eq!(
            remote_for_pr(remotes, "https://github.com/org/repo/pull/7"),
            "upstream"
        );
        assert_eq!(
            remote_for_pr(remotes, "https://github.com/me/repo/pull/7"),
            "origin"
        );
        assert_eq!(
            remote_for_pr(remotes, "https://github.com/x/y/pull/7"),
            "origin"
        );
        assert_eq!(remote_for_pr(remotes, "not a url"), "origin");
    }

    #[test]
    fn parses_pull_request_urls() {
        assert_eq!(
            parse_pr_url("https://github.com/o/n/pull/12"),
            Some(("o/n".into(), 12))
        );
        assert_eq!(parse_pr_url("https://github.com/o/n/pull/0"), None);
        assert_eq!(parse_pr_url("https://github.com/-o/n/pull/1"), None);
        assert_eq!(parse_pr_url("https://example.com/o/n/pull/1"), None);
    }

    #[test]
    fn prepare_review_leaves_the_checkout_alone() {
        use crate::git::testutil::*;
        use crate::git::{changed_files, file_diff, Scope};
        let remote = new_repo();
        let r = remote.path();
        write_file(r.join("a.txt"), "one\n");
        git_in(r, &["add", "."]);
        git_in(r, &["commit", "-q", "-m", "base"]);
        let base = git_in(r, &["rev-parse", "HEAD"]);
        git_in(r, &["checkout", "-q", "-b", "feature"]);
        write_file(r.join("a.txt"), "two\n");
        write_file(r.join("b.txt"), "new\n");
        git_in(r, &["add", "."]);
        git_in(r, &["commit", "-q", "-m", "change"]);
        let head = git_in(r, &["rev-parse", "HEAD"]);
        git_in(r, &["update-ref", "refs/pull/7/head", &head]);
        git_in(r, &["checkout", "-q", "main"]);
        git_in(r, &["branch", "-D", "feature"]);
        // main moves on after the branch point; the diff must still show only the PR's changes.
        write_file(r.join("c.txt"), "later\n");
        git_in(r, &["add", "."]);
        git_in(r, &["commit", "-q", "-m", "later on main"]);

        let clone = tempfile::tempdir().unwrap();
        git_in(
            clone.path(),
            &["clone", "-q", "--branch", "main", r.to_str().unwrap(), "."],
        );
        write_file(clone.path().join("a.txt"), "my uncommitted work\n");
        let repo = clone.path().to_str().unwrap();
        let pr = PRInfo {
            number: 7,
            base_ref: "main".into(),
            url: "https://github.com/o/r/pull/7".into(),
            ..Default::default()
        };
        let target = prepare_review(repo, &pr).unwrap();
        assert_eq!(
            (target.head.as_str(), target.base.as_str()),
            (head.as_str(), base.as_str())
        );

        let scope = Scope {
            repo: repo.into(),
            base: target.base.clone(),
            head: target.head.clone(),
            ..Default::default()
        };
        let paths: Vec<_> = changed_files(&scope)
            .unwrap()
            .into_iter()
            .map(|f| f.path)
            .collect();
        assert_eq!(paths, ["a.txt", "b.txt"]);
        let diff = file_diff(&scope, "a.txt").unwrap();
        assert!(
            diff.contains("+two") && !diff.contains("uncommitted"),
            "{diff}"
        );
        assert_eq!(
            git_in(clone.path(), &["status", "--porcelain"]),
            "M a.txt",
            "checkout should be untouched"
        );
        let again = prepare_review(repo, &pr).unwrap();
        assert_eq!((again.base, again.head), (target.base, target.head));
    }
}
