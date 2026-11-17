use anyhow::{anyhow, bail, Context, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};

/// SearchQuery is what the reviewer typed in the search dialog, with its toggles.
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchQuery {
    pub text: String,
    pub case_sensitive: bool,
    pub word: bool,
    pub regex: bool,
}

/// SearchHit is one matching line. Ranges are [start, end) in UTF-16 units,
/// the way the frontend's strings count, so it can mark the matches.
#[derive(Serialize, Debug)]
pub struct SearchHit {
    pub path: String,
    pub line: usize,
    pub text: String,
    pub ranges: Vec<[usize; 2]>,
}

/// SearchResult is the hits in file order. Truncated is set when there were more than the limit.
#[derive(Serialize, Debug, Default)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    pub truncated: bool,
}

/// SEARCH_LIMIT caps the hits returned, so a common word cannot flood the dialog.
const SEARCH_LIMIT: usize = 500;

/// search_files searches the given files as they are at commit head, never the working tree.
/// Binary files and paths that do not exist at head are skipped.
pub fn search_files(
    repo: &str,
    head: &str,
    paths: &[String],
    q: &SearchQuery,
) -> Result<SearchResult> {
    search_with_limit(repo, head, paths, q, SEARCH_LIMIT)
}

fn search_with_limit(
    repo: &str,
    head: &str,
    paths: &[String],
    q: &SearchQuery,
    limit: usize,
) -> Result<SearchResult> {
    let re = compile_query(q)?;
    let mut result = SearchResult::default();
    read_blobs(repo, head, paths, |path, content| {
        let content = String::from_utf8_lossy(content);
        for (i, line) in content.split('\n').enumerate() {
            let locs: Vec<_> = re.find_iter(line).map(|m| (m.start(), m.end())).collect();
            if locs.is_empty() {
                continue;
            }
            if result.hits.len() == limit {
                result.truncated = true;
                return false;
            }
            result.hits.push(SearchHit {
                path: path.into(),
                line: i + 1,
                text: line.into(),
                ranges: utf16_ranges(line, &locs),
            });
        }
        true
    })?;
    Ok(result)
}

/// compile_query turns the query and its toggles into one regular expression.
fn compile_query(q: &SearchQuery) -> Result<Regex> {
    let mut pattern = if q.regex {
        q.text.clone()
    } else {
        regex::escape(&q.text)
    };
    if q.word {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    if !q.case_sensitive {
        pattern = format!("(?i){pattern}");
    }
    Regex::new(&pattern).map_err(|e| anyhow!("not a valid regular expression: {e}"))
}

/// utf16_ranges converts byte offsets within line to UTF-16 offsets.
fn utf16_ranges(line: &str, locs: &[(usize, usize)]) -> Vec<[usize; 2]> {
    // Match offsets always fall on char boundaries.
    let units = |at: usize| line.get(..at).map_or(0, |s| s.encode_utf16().count());
    locs.iter()
        .map(|&(start, end)| [units(start), units(end)])
        .collect()
}

/// read_blobs streams each path's content at head through one `git cat-file --batch`.
/// visit returns false to stop early. Missing paths and binary files are not visited.
fn read_blobs(
    repo: &str,
    head: &str,
    paths: &[String],
    mut visit: impl FnMut(&str, &[u8]) -> bool,
) -> Result<()> {
    let mut child = Command::new("git")
        .args(["-C", repo, "cat-file", "--batch"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut stdin = child.stdin.take().expect("stdin is piped");
    let input: String = paths.iter().map(|p| format!("{head}:{p}\n")).collect();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(input.as_bytes());
    });
    let mut out = BufReader::new(child.stdout.take().expect("stdout is piped"));
    let short = head.get(..8).unwrap_or(head);
    let result = (|| {
        for path in paths {
            let mut header = String::new();
            if out
                .read_line(&mut header)
                .with_context(|| format!("reading {path} at {short}"))?
                == 0
            {
                bail!("reading {path} at {short}: EOF");
            }
            // "<object> missing" has two fields.
            let [_, kind, size] = header.split_whitespace().collect::<Vec<_>>()[..] else {
                continue;
            };
            let size: usize = size
                .parse()
                .map_err(|_| anyhow!("reading {path} at {short}: bad header {header:?}"))?;
            let mut content = vec![0; size + 1]; // the object, then a newline
            out.read_exact(&mut content)
                .with_context(|| format!("reading {path} at {short}"))?;
            content.truncate(size);
            if kind != "blob" || content.iter().take(8000).any(|&b| b == 0) {
                continue;
            }
            if !visit(path, content.strip_suffix(b"\n").unwrap_or(&content)) {
                break;
            }
        }
        Ok(())
    })();
    let _ = child.kill();
    let _ = child.wait();
    let _ = writer.join();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::testutil::*;

    /// search_repo makes a repository whose committed files differ from its working tree,
    /// so a test can tell that search reads the commit.
    fn search_repo() -> (tempfile::TempDir, String) {
        let repo = new_repo();
        let p = repo.path();
        write_file(
            p.join("limit.go"),
            "package api\n\nfunc Limit() {\n\tkey := clientKey(r)\n\tKEY := 1\n}\n",
        );
        write_file(p.join("notes.md"), "café key\nkeyboard\n");
        write_file(p.join("logo.bin"), "key\0key\n");
        git_in(p, &["add", "."]);
        git_in(p, &["commit", "-q", "-m", "head"]);
        write_file(p.join("limit.go"), "key only in the working tree\n");
        let head = git_in(p, &["rev-parse", "HEAD"]);
        (repo, head)
    }

    fn search(paths: &[&str], q: SearchQuery) -> SearchResult {
        let (repo, head) = search_repo();
        let paths: Vec<String> = paths.iter().map(|p| p.to_string()).collect();
        search_files(repo.path().to_str().unwrap(), &head, &paths, &q).unwrap()
    }

    fn hits(r: &SearchResult) -> Vec<String> {
        r.hits
            .iter()
            .map(|h| format!("{}:{}:{}", h.path, h.line, h.text))
            .collect()
    }

    fn q(text: &str) -> SearchQuery {
        SearchQuery {
            text: text.into(),
            ..Default::default()
        }
    }

    #[test]
    fn reads_the_commit_ignoring_case_by_default() {
        let got = search(&["limit.go"], q("key"));
        assert_eq!(
            hits(&got),
            ["limit.go:4:\tkey := clientKey(r)", "limit.go:5:\tKEY := 1"]
        );
        assert_eq!(got.hits[0].ranges, [[1, 4], [14, 17]]);
    }

    #[test]
    fn options() {
        let paths = ["limit.go", "notes.md"];
        let sensitive = SearchQuery {
            case_sensitive: true,
            ..q("KEY")
        };
        assert_eq!(hits(&search(&paths, sensitive)), ["limit.go:5:\tKEY := 1"]);
        let word = SearchQuery {
            word: true,
            ..q("key")
        };
        assert_eq!(
            hits(&search(&paths, word)),
            [
                "limit.go:4:\tkey := clientKey(r)",
                "limit.go:5:\tKEY := 1",
                "notes.md:1:café key"
            ]
        );
        let regex = SearchQuery {
            regex: true,
            ..q(r"^key\w+")
        };
        assert_eq!(hits(&search(&paths, regex)), ["notes.md:2:keyboard"]);
        assert!(hits(&search(&paths, q(r"^key\w+"))).is_empty());
    }

    #[test]
    fn counts_ranges_in_utf16() {
        let got = search(
            &["notes.md"],
            SearchQuery {
                word: true,
                ..q("key")
            },
        );
        assert_eq!(got.hits[0].ranges, [[5, 8]]);
    }

    #[test]
    fn skips_binary_and_missing_files() {
        assert!(search(&["logo.bin", "deleted.go"], q("key"))
            .hits
            .is_empty());
    }

    #[test]
    fn stops_at_the_limit() {
        let (repo, head) = search_repo();
        let paths = vec!["limit.go".to_string(), "notes.md".to_string()];
        let got =
            search_with_limit(repo.path().to_str().unwrap(), &head, &paths, &q("key"), 2).unwrap();
        assert!(got.hits.len() == 2 && got.truncated);
    }

    #[test]
    fn rejects_a_bad_regex() {
        let (repo, head) = search_repo();
        let q = SearchQuery {
            regex: true,
            ..q("(")
        };
        assert!(search_files(
            repo.path().to_str().unwrap(),
            &head,
            &["limit.go".into()],
            &q
        )
        .is_err());
    }
}
