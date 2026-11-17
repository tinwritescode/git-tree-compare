use crate::noise::{is_whitespace_only, mark_generated};
use crate::proc::{self, is_false};
use anyhow::{anyhow, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Command;
use std::sync::LazyLock;

/// FileChange is one entry in the file tree.
/// Status is A, M, D, or R. Added and Deleted are line counts.
/// Generated and WhitespaceOnly are facts only git knows; the frontend decides from them what to fold.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FileChange {
    pub path: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub old_path: String,
    pub status: String,
    pub added: i64,
    pub deleted: i64,
    /// linguist-generated at head
    #[serde(skip_serializing_if = "is_false")]
    pub generated: bool,
    /// modified, but nothing is left with -w
    #[serde(skip_serializing_if = "is_false")]
    pub whitespace_only: bool,
}

/// Scope says what is being reviewed: the diff from Base to Head, both full commit ids.
/// Base is the empty tree when Head is a root commit.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Scope {
    pub repo: String,
    pub base: String,
    pub head: String,
    #[serde(rename = "ignoreWS")]
    pub ignore_ws: bool,
    /// show the whole file as context, not just the changed hunks
    #[serde(rename = "fullFile")]
    pub full_file: bool,
}

/// FULL_FILE_CONTEXT asks git for more context lines than any file has, so each diff holds the whole file.
const FULL_FILE_CONTEXT: &str = "-U1000000";

/// scope_diff runs a diff within scope and returns its output. flags are extra options
/// such as --name-status. path limits the output to one file when set.
pub fn scope_diff(s: &Scope, flags: &[&str], path: &str) -> Result<String> {
    let mut args = vec!["diff", "-M"];
    args.extend_from_slice(flags);
    if s.ignore_ws {
        args.push("-w");
    }
    if s.full_file {
        args.push(FULL_FILE_CONTEXT);
    }
    args.push(&s.base);
    args.push(&s.head);
    if !path.is_empty() {
        args.extend_from_slice(&["--", path]);
    }
    run_git(&s.repo, &args)
}

/// run_git runs git in repo and returns stdout.
pub fn run_git(repo: &str, args: &[&str]) -> Result<String> {
    run_git_input(repo, "", args)
}

/// run_git_input runs git in repo with input on stdin and returns stdout.
pub fn run_git_input(repo: &str, input: &str, args: &[&str]) -> Result<String> {
    Ok(String::from_utf8_lossy(&run_git_bytes(repo, input, args)?).into_owned())
}

/// run_git_bytes runs git in repo and returns stdout as git wrote it, for file contents that may not be text.
pub fn run_git_bytes(repo: &str, input: &str, args: &[&str]) -> Result<Vec<u8>> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo).args(args);
    let out = proc::run(cmd, input.as_bytes())?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(anyhow!("git {}: {}", args.join(" "), stderr.trim()));
    }
    Ok(out.stdout)
}

/// resolve_repo returns the top-level directory of the repository containing path.
pub fn resolve_repo(path: &str) -> Result<String> {
    run_git(path, &["rev-parse", "--show-toplevel"])
        .map(|out| out.trim().to_string())
        .map_err(|_| anyhow!("{path} is not inside a git repository"))
}

/// changed_files lists the files that differ within scope with their line counts.
pub fn changed_files(s: &Scope) -> Result<Vec<FileChange>> {
    let mut changes = parse_name_status(&scope_diff(s, &["--name-status"], "")?);

    // Line counts with and without whitespace: the scope picks which to show, and a file that
    // changes only in the first is whitespace only.
    let numstat = |ignore_ws| {
        let plain = Scope {
            ignore_ws,
            full_file: false,
            ..s.clone()
        };
        scope_diff(&plain, &["--numstat"], "").map(|out| parse_numstat(&out))
    };
    let stats = [numstat(false)?, numstat(true)?];
    let shown = &stats[usize::from(s.ignore_ws)];
    for c in &mut changes {
        if let Some(st) = shown.get(&c.path) {
            (c.added, c.deleted) = (st[0], st[1]);
        }
        let get = |m: &HashMap<String, [i64; 2]>| m.get(&c.path).copied().unwrap_or_default();
        c.whitespace_only = is_whitespace_only(get(&stats[0]), get(&stats[1]));
    }
    mark_generated(&s.repo, &s.head, &mut changes)?;
    Ok(changes)
}

/// file_diff returns the unified diff of one file within scope.
pub fn file_diff(s: &Scope, path: &str) -> Result<String> {
    scope_diff(s, &[], path)
}

/// parse_name_status parses `git diff --name-status -M` output.
/// Renames look like "R100\told\tnew"; every other line is "STATUS\tpath".
pub fn parse_name_status(out: &str) -> Vec<FileChange> {
    let mut changes = Vec::new();
    for line in out.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        let (Some(status), Some(path)) =
            (fields.first().and_then(|f| f.chars().next()), fields.get(1))
        else {
            continue;
        };
        let mut change = FileChange {
            status: status.to_string(),
            path: path.to_string(),
            ..Default::default()
        };
        if let (true, [_, old, new]) = (status == 'R', fields.as_slice()) {
            change.old_path = old.to_string();
            change.path = new.to_string();
        }
        changes.push(change);
    }
    changes
}

static RENAME_BRACES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{[^{}]* => ([^{}]*)\}").unwrap());

/// parse_numstat parses `git diff --numstat -M` output into added and deleted
/// counts keyed by the new path. Binary files report "-" and count as zero.
pub fn parse_numstat(out: &str) -> HashMap<String, [i64; 2]> {
    let mut stats = HashMap::new();
    for line in out.lines() {
        let [added, deleted, path] = line.splitn(3, '\t').collect::<Vec<_>>()[..] else {
            continue;
        };
        let n = |f: &str| f.parse().unwrap_or(0);
        stats.insert(numstat_new_path(path), [n(added), n(deleted)]);
    }
    stats
}

/// numstat_new_path turns "a => b" or "dir/{a => b}/f" into the new path "b".
pub fn numstat_new_path(p: &str) -> String {
    if p.contains('{') {
        return RENAME_BRACES.replace_all(p, "$1").replace("//", "/");
    }
    match p.split_once(" => ") {
        Some((_, after)) => after.to_string(),
        None => p.to_string(),
    }
}

#[cfg(test)]
pub mod testutil {
    use std::path::Path;

    /// git_in runs git in dir as a test committer and panics on error.
    pub fn git_in(dir: &Path, args: &[&str]) -> String {
        let mut all = vec!["-c", "user.name=t", "-c", "user.email=t@t"];
        all.extend_from_slice(args);
        super::run_git(dir.to_str().unwrap(), &all)
            .unwrap_or_else(|e| panic!("git {args:?}: {e}"))
            .trim()
            .to_string()
    }

    pub fn write_file(path: impl AsRef<Path>, body: &str) {
        let path = path.as_ref();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    pub fn new_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git_in(dir.path(), &["init", "-q", "-b", "main"]);
        dir
    }

    /// branch_repo makes main with two commits and a branch feat cut from the first, so main has
    /// moved on since feat started.
    pub fn branch_repo() -> tempfile::TempDir {
        let repo = new_repo();
        let p = repo.path();
        write_file(p.join("a.txt"), "one\n");
        git_in(p, &["add", "."]);
        git_in(p, &["commit", "-q", "-m", "first"]);
        git_in(p, &["checkout", "-q", "-b", "feat"]);
        write_file(p.join("f.txt"), "feature\n");
        git_in(p, &["add", "."]);
        git_in(p, &["commit", "-q", "-m", "add feature"]);
        git_in(p, &["checkout", "-q", "main"]);
        write_file(p.join("a.txt"), "two\n");
        write_file(p.join("b.txt"), "new\n");
        git_in(p, &["add", "."]);
        git_in(p, &["commit", "-q", "-m", "second"]);
        repo
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;

    #[test]
    fn parses_name_status_with_renames() {
        let got = parse_name_status("M\ta.go\nR100\told.go\tnew.go\nA\tb.go\n\n");
        let summary: Vec<_> = got
            .iter()
            .map(|c| format!("{} {} {}", c.status, c.old_path, c.path))
            .collect();
        assert_eq!(summary, ["M  a.go", "R old.go new.go", "A  b.go"]);
    }

    #[test]
    fn parses_numstat_renames_and_binaries() {
        let got = parse_numstat(
            "3\t1\ta.go\n-\t-\timg.png\n2\t0\tdir/{old => new}/f.go\n1\t1\tx.go => y.go\n",
        );
        assert_eq!(got["a.go"], [3, 1]);
        assert_eq!(got["img.png"], [0, 0]);
        assert_eq!(got["dir/new/f.go"], [2, 0]);
        assert_eq!(got["y.go"], [1, 1]);
        assert_eq!(numstat_new_path("{a => }/f.go"), "/f.go");
        assert_eq!(numstat_new_path("dir/{ => sub}/f.go"), "dir/sub/f.go");
    }

    #[test]
    fn changed_files_counts_lines_in_a_real_repo() {
        let repo = new_repo();
        write_file(repo.path().join("a.txt"), "one\n");
        git_in(repo.path(), &["add", "."]);
        git_in(repo.path(), &["commit", "-q", "-m", "first"]);
        let base = git_in(repo.path(), &["rev-parse", "HEAD"]);
        write_file(repo.path().join("a.txt"), "one\ntwo\n");
        write_file(repo.path().join("b.txt"), "new\n");
        git_in(repo.path(), &["add", "."]);
        git_in(repo.path(), &["commit", "-q", "-m", "second"]);
        let head = git_in(repo.path(), &["rev-parse", "HEAD"]);
        let s = Scope {
            repo: repo.path().to_str().unwrap().into(),
            base,
            head,
            ..Default::default()
        };
        let files = changed_files(&s).unwrap();
        let summary: Vec<_> = files
            .iter()
            .map(|f| format!("{} {} +{} -{}", f.status, f.path, f.added, f.deleted))
            .collect();
        assert_eq!(summary, ["M a.txt +1 -0", "A b.txt +1 -0"]);
        assert!(file_diff(&s, "a.txt").unwrap().contains("+two"));
    }

    #[test]
    fn resolve_repo_rejects_a_plain_folder() {
        let dir = tempfile::tempdir().unwrap();
        assert!(resolve_repo(dir.path().to_str().unwrap())
            .unwrap_err()
            .to_string()
            .contains("is not inside a git repository"));
    }
}
