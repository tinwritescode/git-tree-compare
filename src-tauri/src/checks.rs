use crate::proc::parse_json;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::process::Command;

/// Check is one CI check on a pull request's head. Bucket is gh's grouping of State:
/// pass, fail, pending, skipping or cancel.
#[derive(Serialize, Deserialize, Debug, Default)]
#[serde(default)]
pub struct Check {
    pub name: String,
    pub state: String,
    pub link: String,
    pub bucket: String,
}

/// GhResult is what a gh command printed and how it exited.
struct GhResult {
    stdout: Vec<u8>,
    exit_code: i32,
    stderr: String,
}

/// rank orders checks so the ones that need attention come first.
fn rank(bucket: &str) -> u8 {
    match bucket {
        "fail" => 0,
        "pending" => 1,
        "cancel" => 2,
        "pass" => 3,
        "skipping" => 4,
        _ => 5,
    }
}

/// parse_checks reads `gh pr checks --json`. gh exits 1 when a check failed and 8 while checks are
/// pending, and prints the list either way; with no checks at all it prints nothing and says so.
fn parse_checks(r: &GhResult) -> Result<Vec<Check>> {
    let listed = matches!(r.exit_code, 0 | 1 | 8);
    if listed && !r.stdout.trim_ascii().is_empty() {
        let mut checks: Vec<Check> = parse_json(&r.stdout).context("could not read the checks")?;
        checks.sort_by_key(|c| rank(&c.bucket));
        return Ok(checks);
    }
    if listed && r.stderr.contains("no checks reported") {
        return Ok(Vec::new());
    }
    Err(anyhow!("GitHub said: {}", r.stderr.trim()))
}

/// pr_checks lists the CI checks on the pull request's head, failing and pending first.
pub fn pr_checks(repo: &str, number: i64) -> Result<Vec<Check>> {
    let out = Command::new("gh")
        .args([
            "pr",
            "checks",
            &number.to_string(),
            "--json",
            "name,state,link,bucket",
        ])
        .current_dir(repo)
        .output()?;
    parse_checks(&GhResult {
        stdout: out.stdout,
        // A gh killed by a signal has no code; it listed nothing.
        exit_code: out.status.code().unwrap_or(-1),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(code: i32, stdout: &str, stderr: &str) -> GhResult {
        GhResult {
            stdout: stdout.into(),
            exit_code: code,
            stderr: stderr.into(),
        }
    }

    #[test]
    fn sorts_failing_and_pending_first() {
        let out = r#"[{"name":"lint","bucket":"pass"},{"name":"test","bucket":"fail"},{"name":"e2e","bucket":"pending"},{"name":"x","bucket":"odd"}]"#;
        let checks = parse_checks(&result(1, out, "")).unwrap();
        let names: Vec<_> = checks.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["test", "e2e", "lint", "x"]);
        assert_eq!(parse_checks(&result(8, out, "")).unwrap().len(), 4);
    }

    #[test]
    fn no_checks_is_an_empty_list_and_errors_say_why() {
        assert!(
            parse_checks(&result(1, "", "no checks reported on the 'x' branch"))
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            parse_checks(&result(4, "", "auth needed\n"))
                .unwrap_err()
                .to_string(),
            "GitHub said: auth needed"
        );
        assert!(parse_checks(&result(0, "not json", "")).is_err());
    }
}
