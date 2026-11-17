//! Reviewing a commit or a branch from git alone, with no pull request behind it.

use crate::cli::Launch;
use crate::git::run_git;
use crate::proc::split_lines;
use anyhow::{anyhow, bail, Result};
use serde::Serialize;

/// LocalReview is a commit or a branch reviewed from git alone. Marks stay on this machine.
#[derive(Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalReview {
    /// commit or branch
    pub kind: String,
    /// "a1b2c3d Fix the parser", or "feat/x into main"
    pub title: String,
    /// author and age of a commit, or how many commits a branch adds
    pub detail: String,
    pub base: String,
    pub head: String,
    /// A branch's name and its base's, as origin names them, for opening a pull request. Empty for a commit.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub branch: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub base_branch: String,
}

/// RefList is what the in-app pickers offer: branches, newest first, and recent commits.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RefList {
    pub branches: Vec<String>,
    /// "" when the repository has no main or master
    pub default_base: String,
    pub commits: Vec<CommitRef>,
}

/// CommitRef is one commit in the commit picker.
#[derive(Serialize, Debug, Default, PartialEq)]
pub struct CommitRef {
    pub hash: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    pub when: String,
}

/// LocalSubjects is what the inbox offers to review without a pull request.
#[derive(Serialize, Debug, Default)]
pub struct LocalSubjects {
    /// None on the default branch, detached, or with nothing new
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<LocalBranch>,
    /// the latest commits on HEAD, newest first
    pub commits: Vec<CommitRef>,
}

/// LocalBranch is the checked-out branch and how far it is ahead of the default branch.
#[derive(Serialize, Debug, PartialEq)]
pub struct LocalBranch {
    pub name: String,
    /// the default branch, such as "main"
    pub base: String,
    pub ahead: i64,
}

/// PICKER_COMMITS caps how many recent commits the commit picker lists.
const PICKER_COMMITS: usize = 300;
/// INBOX_COMMITS caps how many commits on HEAD the inbox lists.
const INBOX_COMMITS: usize = 5;

/// launch_review turns --commit or --branch from the command line into a review. Neither means
/// the pull request list.
pub fn launch_review(repo: &str, l: &Launch) -> Result<Option<LocalReview>> {
    match (l.commit.is_empty(), l.branch.is_empty(), l.base.is_empty()) {
        (false, false, _) => bail!("use --commit or --branch, not both"),
        (_, true, false) => bail!("--base goes with --branch"),
        (false, true, _) => review_commit(repo, &l.commit).map(Some),
        (true, false, _) => review_branch(repo, &l.branch, &l.base).map(Some),
        (true, true, true) => Ok(None),
    }
}

/// review_commit reviews what one commit changed, against its first parent. A root commit is
/// compared with the empty tree, so every file shows as added.
pub fn review_commit(repo: &str, rev: &str) -> Result<LocalReview> {
    let head =
        resolve_commit(repo, rev).map_err(|_| anyhow!("no commit {rev:?} in this repository"))?;
    let base = match resolve_commit(repo, &format!("{head}^")) {
        Ok(base) => base,
        Err(_) => run_git(repo, &["hash-object", "-t", "tree", "/dev/null"])?
            .trim()
            .to_string(),
    };
    let info = run_git(repo, &["log", "-1", "--format=%h %s%x00%an, %ar", &head])?;
    let (title, detail) = info.trim().split_once('\0').unwrap_or((info.trim(), ""));
    Ok(LocalReview {
        kind: "commit".into(),
        title: title.into(),
        detail: detail.into(),
        base,
        head,
        ..Default::default()
    })
}

/// review_branch reviews what branch adds over base, from their merge base as a pull request
/// would. An empty base means the repository's default branch. The branch is read locally
/// first, then from origin; a base that origin has as a branch is read from origin first,
/// which is likelier to be current.
pub fn review_branch(repo: &str, branch: &str, base: &str) -> Result<LocalReview> {
    let mut heads = vec![branch.to_string()];
    heads.extend(origin_branch(repo, branch));
    let (head_name, head) = resolve_first(repo, &heads)
        .ok_or_else(|| anyhow!("no branch {branch:?} in this repository"))?;
    let bases = match (base.is_empty(), origin_branch(repo, base)) {
        (true, _) => default_bases(repo),
        (false, Some(remote)) => vec![remote, base.to_string()],
        (false, None) => vec![base.to_string()],
    };
    let Some((base_name, base_head)) = resolve_first(repo, &bases) else {
        if base.is_empty() {
            bail!("found no main or master to compare with; choose a base");
        }
        bail!("no branch {base:?} in this repository");
    };
    let from = run_git(repo, &["merge-base", &base_head, &head])
        .map_err(|_| anyhow!("{head_name} and {base_name} share no history"))?
        .trim()
        .to_string();
    let count = run_git(repo, &["rev-list", "--count", &format!("{from}..{head}")])?;
    Ok(LocalReview {
        kind: "branch".into(),
        title: format!("{head_name} into {base_name}"),
        detail: plural(count.trim(), "commit"),
        base: from,
        head,
        branch: strip_origin(&head_name),
        base_branch: strip_origin(&base_name),
    })
}

fn strip_origin(name: &str) -> String {
    name.strip_prefix("origin/").unwrap_or(name).to_string()
}

/// list_refs lists the branches and recent commits the in-app pickers offer.
pub fn list_refs(repo: &str) -> Result<RefList> {
    let out = run_git(
        repo,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let branches = split_lines(&out)
        .into_iter()
        .filter(|r| !(r.starts_with("refs/remotes/") && r.ends_with("/HEAD")))
        .map(|r| {
            let r = r.strip_prefix("refs/heads/").unwrap_or(&r);
            r.strip_prefix("refs/remotes/").unwrap_or(r).to_string()
        })
        .collect();
    Ok(RefList {
        branches,
        default_base: resolve_first(repo, &default_bases(repo))
            .map(|(name, _)| strip_origin(&name))
            .unwrap_or_default(),
        commits: recent_commits(repo, PICKER_COMMITS, &["HEAD", "--branches", "--remotes"]),
    })
}

/// list_local lists the checked-out branch, when it has commits the default branch lacks, and the
/// latest commits on HEAD. Opening the branch is review_branch with the default base.
pub fn list_local(repo: &str) -> LocalSubjects {
    LocalSubjects {
        branch: local_branch(repo),
        commits: recent_commits(repo, INBOX_COMMITS, &["HEAD"]),
    }
}

fn local_branch(repo: &str) -> Option<LocalBranch> {
    // A detached HEAD has no branch to offer.
    let name = run_git(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()?
        .trim()
        .to_string();
    let (base_name, base_head) = resolve_first(repo, &default_bases(repo))?;
    let base = strip_origin(&base_name);
    if name == base {
        return None;
    }
    // A branch with no commits yet fails here.
    let count = run_git(
        repo,
        &["rev-list", "--count", &format!("{base_head}..HEAD")],
    )
    .ok()?;
    let ahead: i64 = count.trim().parse().unwrap_or(0);
    (ahead > 0).then_some(LocalBranch { name, base, ahead })
}

/// recent_commits lists up to n commits reachable from revs, newest first. A repository with no
/// commits has none.
fn recent_commits(repo: &str, n: usize, revs: &[&str]) -> Vec<CommitRef> {
    let limit = format!("-n{n}");
    let mut args = vec!["log", &limit, "--format=%H%x00%h%x00%s%x00%an%x00%ar"];
    args.extend_from_slice(revs);
    let Ok(log) = run_git(repo, &args) else {
        return Vec::new();
    };
    split_lines(&log)
        .iter()
        .filter_map(|line| match line.split('\0').collect::<Vec<_>>()[..] {
            [hash, short, subject, author, when] => Some(CommitRef {
                hash: hash.into(),
                short: short.into(),
                subject: subject.into(),
                author: author.into(),
                when: when.into(),
            }),
            _ => None,
        })
        .collect()
}

/// default_bases lists where the default branch may be, most likely first: what origin/HEAD
/// points at, then main and master.
fn default_bases(repo: &str) -> Vec<String> {
    let mut names: Vec<String> = run_git(
        repo,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )
    .map(|out| out.trim().to_string())
    .into_iter()
    .collect();
    names.extend(["origin/main", "main", "origin/master", "master"].map(String::from));
    names
}

/// origin_branch names origin's branch called name, when origin has one. It matches whole branch
/// names only, so a rev such as HEAD~1 is never read as origin/HEAD~1.
pub fn origin_branch(repo: &str, name: &str) -> Option<String> {
    let ok = run_git(
        repo,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/remotes/origin/{name}"),
        ],
    )
    .is_ok();
    ok.then(|| format!("origin/{name}"))
}

/// resolve_first returns the first of names that is a commit, with its full id.
fn resolve_first(repo: &str, names: &[String]) -> Option<(String, String)> {
    names
        .iter()
        .find_map(|name| resolve_commit(repo, name).ok().map(|id| (name.clone(), id)))
}

/// resolve_commit returns the full id of the commit rev names.
fn resolve_commit(repo: &str, rev: &str) -> Result<String> {
    Ok(run_git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            &format!("{rev}^{{commit}}"),
        ],
    )?
    .trim()
    .to_string())
}

/// plural writes "1 commit" or "3 commits" from a count git printed.
fn plural(count: &str, noun: &str) -> String {
    if count == "1" {
        format!("1 {noun}")
    } else {
        format!("{count} {noun}s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::testutil::*;
    use crate::git::{changed_files, Scope};
    use std::path::Path;

    fn s(p: &Path) -> &str {
        p.to_str().unwrap()
    }

    fn changed_paths(repo: &Path, r: &LocalReview) -> Vec<String> {
        let files = changed_files(&Scope {
            repo: s(repo).into(),
            base: r.base.clone(),
            head: r.head.clone(),
            ..Default::default()
        })
        .unwrap();
        let mut paths: Vec<_> = files
            .iter()
            .map(|f| format!("{} {}", f.status, f.path))
            .collect();
        paths.sort();
        paths
    }

    #[test]
    fn commit_shows_only_that_commit() {
        let repo = branch_repo();
        let r = review_commit(s(repo.path()), "HEAD").unwrap();
        assert_eq!(r.kind, "commit");
        assert!(
            r.title.ends_with(" second") && r.detail.starts_with("t, "),
            "{r:?}"
        );
        assert_eq!(changed_paths(repo.path(), &r), ["A b.txt", "M a.txt"]);
    }

    #[test]
    fn root_commit_compares_with_the_empty_tree() {
        let repo = branch_repo();
        let r = review_commit(s(repo.path()), "main~1").unwrap();
        assert_eq!(changed_paths(repo.path(), &r), ["A a.txt"]);
    }

    #[test]
    fn unknown_commit_says_so() {
        let repo = branch_repo();
        let err = review_commit(s(repo.path()), "nope")
            .unwrap_err()
            .to_string();
        assert_eq!(err, "no commit \"nope\" in this repository");
    }

    #[test]
    fn branch_shows_what_it_adds_since_it_left_main() {
        let repo = branch_repo();
        let r = review_branch(s(repo.path()), "feat", "").unwrap();
        assert_eq!(
            (
                r.title.as_str(),
                r.detail.as_str(),
                r.branch.as_str(),
                r.base_branch.as_str()
            ),
            ("feat into main", "1 commit", "feat", "main")
        );
        assert_eq!(changed_paths(repo.path(), &r), ["A f.txt"]);
        assert!(review_branch(s(repo.path()), "feat", "nope")
            .unwrap_err()
            .to_string()
            .contains("no branch \"nope\""));
        assert!(review_branch(s(repo.path()), "nope", "").is_err());
    }

    #[test]
    fn launch_flags_pick_the_review() {
        let repo = branch_repo();
        let l = |commit: &str, branch: &str, base: &str| Launch {
            path: String::new(),
            commit: commit.into(),
            branch: branch.into(),
            base: base.into(),
        };
        assert!(launch_review(s(repo.path()), &l("", "", ""))
            .unwrap()
            .is_none());
        assert_eq!(
            launch_review(s(repo.path()), &l("HEAD", "", ""))
                .unwrap()
                .unwrap()
                .kind,
            "commit"
        );
        assert_eq!(
            launch_review(s(repo.path()), &l("", "feat", "main"))
                .unwrap()
                .unwrap()
                .kind,
            "branch"
        );
        assert!(launch_review(s(repo.path()), &l("HEAD", "feat", "")).is_err());
        assert!(launch_review(s(repo.path()), &l("", "", "main")).is_err());
    }

    #[test]
    fn lists_refs_and_local_subjects() {
        let repo = branch_repo();
        let refs = list_refs(s(repo.path())).unwrap();
        assert_eq!(refs.default_base, "main");
        assert!(refs.branches.contains(&"feat".to_string()) && refs.commits.len() == 3);

        assert!(
            list_local(s(repo.path())).branch.is_none(),
            "main is not offered"
        );
        git_in(repo.path(), &["checkout", "-q", "feat"]);
        let local = list_local(s(repo.path()));
        assert_eq!(
            local.branch,
            Some(LocalBranch {
                name: "feat".into(),
                base: "main".into(),
                ahead: 1
            })
        );
        assert_eq!(local.commits.len(), 2);
    }

    fn clone_of(src: &Path) -> tempfile::TempDir {
        let clone = tempfile::tempdir().unwrap();
        git_in(clone.path(), &["clone", "-q", s(src), "."]);
        clone
    }

    #[test]
    fn branch_in_a_clone_compares_origins_branches() {
        let src = branch_repo();
        let clone = clone_of(src.path());
        let r = review_branch(s(clone.path()), "feat", "").unwrap();
        assert_eq!(r.title, "origin/feat into origin/main");
        // A pull request is opened from the branch's name on origin, into the base's.
        assert_eq!(
            (r.branch.as_str(), r.base_branch.as_str()),
            ("feat", "main")
        );
        assert_eq!(changed_paths(clone.path(), &r), ["A f.txt"]);
    }

    /// A base that is not a branch name, such as HEAD~1, means the local commit, never origin's.
    #[test]
    fn a_rev_as_base_is_the_local_commit() {
        let src = branch_repo();
        let clone = clone_of(src.path());
        write_file(clone.path().join("local.txt"), "only here\n");
        git_in(clone.path(), &["add", "."]);
        git_in(clone.path(), &["commit", "-q", "-m", "local"]);
        let r = review_branch(s(clone.path()), "main", "HEAD~1").unwrap();
        assert_eq!(
            (r.title.as_str(), r.branch.as_str(), r.base_branch.as_str()),
            ("main into HEAD~1", "main", "HEAD~1")
        );
        assert_eq!(changed_paths(clone.path(), &r), ["A local.txt"]);
    }

    #[test]
    fn list_local_caps_commits_and_skips_branches_with_nothing_new() {
        let repo = branch_repo();
        for _ in 0..6 {
            git_in(
                repo.path(),
                &["commit", "-q", "--allow-empty", "-m", "more"],
            );
        }
        assert_eq!(list_local(s(repo.path())).commits.len(), INBOX_COMMITS);
        git_in(repo.path(), &["checkout", "-q", "-b", "empty", "main"]);
        assert!(
            list_local(s(repo.path())).branch.is_none(),
            "a branch that adds no commits is offered"
        );
        let empty = new_repo();
        let local = list_local(s(empty.path()));
        assert!(local.branch.is_none() && local.commits.is_empty());
    }
}
