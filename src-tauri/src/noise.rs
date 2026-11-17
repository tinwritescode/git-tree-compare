use crate::git::{run_git_input, FileChange};
use std::collections::HashSet;

/// is_whitespace_only reports whether a file has changed lines that all vanish with -w.
/// plain and ignoring_ws are its added and deleted counts from numstat without and with -w;
/// numstat with -w leaves a modified file out, or shows a renamed one as 0 0, which both read as zero.
pub fn is_whitespace_only(plain: [i64; 2], ignoring_ws: [i64; 2]) -> bool {
    plain[0] + plain[1] > 0 && ignoring_ws[0] + ignoring_ws[1] == 0
}

/// mark_generated sets generated on the changes that .gitattributes marks linguist-generated at head.
/// Git before 2.40 cannot read attributes from a commit, so it falls back to the working tree's.
pub fn mark_generated(repo: &str, head: &str, changes: &mut [FileChange]) -> anyhow::Result<()> {
    if changes.is_empty() {
        return Ok(());
    }
    let paths: String = changes.iter().map(|c| format!("{}\0", c.path)).collect();
    let out = run_git_input(
        repo,
        &paths,
        &[
            "check-attr",
            "--source",
            head,
            "-z",
            "--stdin",
            "linguist-generated",
        ],
    )
    .or_else(|_| {
        run_git_input(
            repo,
            &paths,
            &["check-attr", "-z", "--stdin", "linguist-generated"],
        )
    })?;
    let generated = parse_generated(&out);
    for c in changes {
        c.generated = generated.contains(&c.path);
    }
    Ok(())
}

/// parse_generated reads `git check-attr -z` output, "path\0attr\0value\0" repeated, into the
/// paths whose linguist-generated attribute is set or true.
pub fn parse_generated(out: &str) -> HashSet<String> {
    let fields: Vec<&str> = out.split('\0').collect();
    fields
        .chunks(3)
        .filter(|f| f.len() == 3 && (f[2] == "set" || f[2] == "true"))
        .map(|f| f[0].to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::testutil::*;
    use crate::git::{changed_files, Scope};

    #[test]
    fn whitespace_only_needs_changes_that_vanish() {
        assert!(is_whitespace_only([2, 2], [0, 0]));
        assert!(!is_whitespace_only([0, 0], [0, 0]));
        assert!(!is_whitespace_only([2, 2], [1, 0]));
    }

    #[test]
    fn parses_check_attr_output() {
        let got = parse_generated("a.pb.go\0linguist-generated\0set\0b.go\0linguist-generated\0unspecified\0c.js\0linguist-generated\0true\0");
        let mut got: Vec<_> = got.into_iter().collect();
        got.sort();
        assert_eq!(got, ["a.pb.go", "c.js"]);
    }

    #[test]
    fn marks_generated_and_whitespace_only_files() {
        let repo = new_repo();
        let p = repo.path();
        write_file(p.join(".gitattributes"), "*.gen.go linguist-generated\n");
        write_file(p.join("a.go"), "func a() {\n\treturn\n}\n");
        write_file(p.join("x.gen.go"), "one\n");
        git_in(p, &["add", "."]);
        git_in(p, &["commit", "-q", "-m", "first"]);
        let base = git_in(p, &["rev-parse", "HEAD"]);
        write_file(p.join("a.go"), "func a() {\n    return\n}\n");
        write_file(p.join("x.gen.go"), "two\n");
        git_in(p, &["add", "."]);
        git_in(p, &["commit", "-q", "-m", "second"]);
        let head = git_in(p, &["rev-parse", "HEAD"]);
        let files = changed_files(&Scope {
            repo: p.to_str().unwrap().into(),
            base,
            head,
            ..Default::default()
        })
        .unwrap();
        let a = files.iter().find(|f| f.path == "a.go").unwrap();
        let gen = files.iter().find(|f| f.path == "x.gen.go").unwrap();
        assert!(a.whitespace_only && !a.generated);
        assert!(gen.generated && !gen.whitespace_only);
    }
}
