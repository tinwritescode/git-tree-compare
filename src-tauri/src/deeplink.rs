use crate::dirs::list_dir;
use crate::gh::remote_matching;
use crate::git::run_git;
use anyhow::{anyhow, Result};
use regex::Regex;
use serde::Serialize;
use std::path::Path;
use std::sync::LazyLock;

const LINK_SCHEME: &str = "git-tree-compare";

/// SLUG_PATTERN is owner/name as GitHub writes it. The first character keeps a slug from reading as a flag.
pub static SLUG_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][\w.-]*/[\w.-]+$").unwrap());

/// OpenLink is what a git-tree-compare:// URL asks for: one pull request of a GitHub repository.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct OpenLink {
    pub slug: String,
    pub pr: i64,
}

/// parse_open_url reads git-tree-compare://open?repo=owner/name&pr=N. Any web page can send one of
/// these, so it accepts nothing but that exact shape.
pub fn parse_open_url(raw: &str) -> Result<OpenLink> {
    let bad = || anyhow!("this link cannot be opened: {raw:?}");
    let u = url::Url::parse(raw).map_err(|_| bad())?;
    if u.scheme() != LINK_SCHEME || u.host_str() != Some("open") {
        return Err(bad());
    }
    let get = |key: &str| {
        u.query_pairs()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default()
    };
    let slug = get("repo");
    match get("pr").parse::<i64>() {
        Ok(pr) if pr >= 1 && SLUG_PATTERN.is_match(&slug) => Ok(OpenLink { slug, pr }),
        _ => Err(bad()),
    }
}

/// find_clone returns the local repository with a remote at slug, or "". It looks through the known
/// repositories, then the repositories in the same folders. Worktrees of a clone match too.
pub fn find_clone(slug: &str, known: &[String]) -> String {
    clone_candidates(known)
        .into_iter()
        .find(|dir| {
            run_git(dir, &["remote", "-v"])
                .is_ok_and(|remotes| remote_matching(&remotes, slug).is_some())
        })
        .unwrap_or_default()
}

/// clone_candidates lists known first, as those are the likeliest, then their sibling repositories.
fn clone_candidates(known: &[String]) -> Vec<String> {
    let mut out = known.to_vec();
    for dir in known {
        let parent = Path::new(dir).parent().unwrap_or(Path::new("/"));
        let Ok(listing) = list_dir(&parent.to_string_lossy()) else {
            continue;
        };
        for entry in listing.entries {
            if entry.is_repo && !out.contains(&entry.path) {
                out.push(entry.path);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::testutil::git_in;

    #[test]
    fn accepts_only_the_open_link_shape() {
        assert_eq!(
            parse_open_url("git-tree-compare://open?repo=o/n&pr=12").unwrap(),
            OpenLink {
                slug: "o/n".into(),
                pr: 12
            }
        );
        for raw in [
            "https://open?repo=o/n&pr=1",
            "git-tree-compare://close?repo=o/n&pr=1",
            "git-tree-compare://open?repo=o/n&pr=0",
            "git-tree-compare://open?repo=o/n&pr=x",
            "git-tree-compare://open?repo=-o/n&pr=1",
            "git-tree-compare://open?repo=o&pr=1",
            "git-tree-compare://open?pr=1",
        ] {
            assert!(parse_open_url(raw).is_err(), "{raw}");
        }
    }

    fn clone_of(parent: &Path, name: &str, url: &str) -> String {
        let dir = parent.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        git_in(&dir, &["init", "-q"]);
        git_in(&dir, &["remote", "add", "origin", url]);
        dir.to_str().unwrap().into()
    }

    #[test]
    fn finds_a_known_clone_or_its_sibling() {
        let root = tempfile::tempdir().unwrap();
        let known = clone_of(root.path(), "known", "git@github.com:o/known.git");
        let sibling = clone_of(root.path(), "sibling", "https://github.com/o/target");
        assert_eq!(find_clone("o/known", std::slice::from_ref(&known)), known);
        assert_eq!(
            find_clone("o/target", std::slice::from_ref(&known)),
            sibling
        );
        assert_eq!(find_clone("o/none", &[known]), "");
    }
}
