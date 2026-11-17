//! The viewed state of a pull request's files on GitHub, read and written through gh.

use crate::gh::run_gh;
use crate::proc::parse_json;
use anyhow::Result;
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap};

/// MARK_BATCH_SIZE is how many viewed mutations go into one request.
const MARK_BATCH_SIZE: usize = 50;

/// PR_FILES_QUERY lists the pull request's files with the viewer's viewed state, one page at a time.
const PR_FILES_QUERY: &str = r"query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequest {
      files(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { path viewerViewedState }
      }
    }
  }
}";

/// FilesPage is one page of PR_FILES_QUERY: the viewed state per path, and the next cursor when there is more.
struct FilesPage {
    states: HashMap<String, String>,
    next: Option<String>,
}

fn parse_pr_files(out: &[u8]) -> Result<FilesPage> {
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
    #[serde(default)]
    struct Node {
        files: Files,
    }
    #[derive(Deserialize, Default)]
    #[serde(default, rename_all = "camelCase")]
    struct Files {
        page_info: PageInfo,
        nodes: Vec<File>,
    }
    #[derive(Deserialize, Default)]
    #[serde(default, rename_all = "camelCase")]
    struct PageInfo {
        has_next_page: bool,
        end_cursor: String,
    }
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct File {
        path: String,
        #[serde(rename = "viewerViewedState")]
        state: String,
    }
    let files = parse_json::<Resp>(out)?.data.node.files;
    Ok(FilesPage {
        states: files.nodes.into_iter().map(|n| (n.path, n.state)).collect(),
        next: files
            .page_info
            .has_next_page
            .then_some(files.page_info.end_cursor),
    })
}

/// viewed_mutation sets n files as viewed or not viewed in one request. Paths are passed as variables, never spliced in.
fn viewed_mutation(viewed: bool, n: usize) -> String {
    let name = if viewed {
        "markFileAsViewed"
    } else {
        "unmarkFileAsViewed"
    };
    let decl: String = (0..n).map(|i| format!(", $p{i}: String!")).collect();
    let body: String = (0..n)
        .map(|i| {
            format!(
                " m{i}: {name}(input: {{pullRequestId: $id, path: $p{i}}}) {{ clientMutationId }}"
            )
        })
        .collect();
    format!("mutation($id: ID!{decl}) {{{body} }}")
}

/// gh_graphql runs a GraphQL query through the gh CLI, with string variables.
pub fn gh_graphql(repo: &str, query: &str, vars: &BTreeMap<String, String>) -> Result<Vec<u8>> {
    let mut args = vec![
        "api".to_string(),
        "graphql".into(),
        "-f".into(),
        format!("query={query}"),
    ];
    for (k, v) in vars {
        args.extend(["-f".into(), format!("{k}={v}")]);
    }
    run_gh(repo, &args.iter().map(String::as_str).collect::<Vec<_>>())
}

/// vars builds GraphQL variables from pairs.
pub fn vars<const N: usize>(pairs: [(&str, &str); N]) -> BTreeMap<String, String> {
    pairs
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// set_viewed marks the paths as viewed on the pull request, or removes the mark. Repeating it is harmless.
pub fn set_viewed(repo: &str, pr_id: &str, paths: &[String], viewed: bool) -> Result<()> {
    for batch in paths.chunks(MARK_BATCH_SIZE) {
        let mut v = vars([("id", pr_id)]);
        v.extend(
            batch
                .iter()
                .enumerate()
                .map(|(i, p)| (format!("p{i}"), p.clone())),
        );
        gh_graphql(repo, &viewed_mutation(viewed, batch.len()), &v)?;
    }
    Ok(())
}

/// pr_viewed_states returns the viewer's state of every file in the pull request: VIEWED, UNVIEWED or DISMISSED.
/// DISMISSED means the file changed after it was viewed. It reads all pages.
pub fn pr_viewed_states(repo: &str, id: &str) -> Result<HashMap<String, String>> {
    let mut all = HashMap::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut v = vars([("id", id)]);
        if let Some(c) = cursor {
            v.insert("cursor".into(), c);
        }
        let page = parse_pr_files(&gh_graphql(repo, PR_FILES_QUERY, &v)?)?;
        all.extend(page.states);
        match page.next {
            Some(next) => cursor = Some(next),
            None => return Ok(all),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testbin::fake_bin;

    #[test]
    fn parses_a_page_of_files() {
        let out = br#"{"data":{"node":{"files":{"pageInfo":{"hasNextPage":true,"endCursor":"c1"},"nodes":[{"path":"a.ts","viewerViewedState":"VIEWED"},{"path":"b.ts","viewerViewedState":"UNVIEWED"}]}}}}"#;
        let page = parse_pr_files(out).unwrap();
        assert_eq!(page.states.len(), 2);
        assert_eq!(page.states["a.ts"], "VIEWED");
        assert_eq!(page.states["b.ts"], "UNVIEWED");
        assert_eq!(page.next.as_deref(), Some("c1"));
    }

    #[test]
    fn mutation_takes_paths_as_variables() {
        let q = viewed_mutation(true, 2);
        for want in [
            "$p0: String!",
            "$p1: String!",
            "m0: markFileAsViewed",
            "path: $p1",
        ] {
            assert!(q.contains(want), "missing {want}:\n{q}");
        }
        assert!(
            q.starts_with("mutation($id: ID!, $p0") && q.ends_with("} }"),
            "{q}"
        );
    }

    #[test]
    fn set_viewed_sends_batches() {
        let fake = fake_bin("gh", "printf '%s\\n---\\n' \"$*\" >> \"$LOG\"\n");
        let paths: Vec<String> = (0..=MARK_BATCH_SIZE).map(|i| format!("f{i}.ts")).collect();
        set_viewed(fake.dir(), "PR_1", &paths, false).unwrap();
        let got = fake.log();
        assert_eq!(got.matches("---").count(), 2, "{got}");
        assert!(
            got.contains("unmarkFileAsViewed")
                && got.contains("id=PR_1")
                && got.contains(&format!("=f{MARK_BATCH_SIZE}.ts")),
            "{got}"
        );
    }
}
