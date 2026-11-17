//! Running the tools the app drives (git, gh, claude) and reading what they print.

use serde::de::DeserializeOwned;
use serde_json::Value;
use std::io::Write;
use std::process::{Command, Output, Stdio};
use std::time::Duration;

/// run starts cmd with input on stdin and waits for it, keeping stdout and stderr. Input is
/// written from its own thread, so a command that prints a lot before reading cannot deadlock.
pub fn run(mut cmd: Command, input: &[u8]) -> std::io::Result<Output> {
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let mut stdin = child.stdin.take().expect("stdin is piped");
    let input = input.to_vec();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let out = child.wait_with_output();
    let _ = writer.join();
    out
}

/// output_timeout runs cmd with no stdin and returns what it printed, or None when it fails to
/// start or runs past timeout, in which case it is killed.
pub fn output_timeout(mut cmd: Command, timeout: Duration) -> Option<Output> {
    let child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || tx.send(child.wait_with_output()));
    match rx.recv_timeout(timeout) {
        Ok(out) => out.ok(),
        Err(_) => {
            kill(pid, false);
            None
        }
    }
}

/// kill sends SIGKILL to pid, or with group to the process group pid leads.
pub fn kill(pid: u32, group: bool) {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return;
    };
    let target = if group { -pid } else { pid };
    // SAFETY: kill only sends a signal; a pid that is gone fails with ESRCH and changes nothing.
    unsafe {
        libc::kill(target, libc::SIGKILL);
    }
}

/// parse_json reads JSON the way Go did: a null member counts as missing, so a field with
/// `#[serde(default)]` takes its zero value instead of failing.
pub fn parse_json<T: DeserializeOwned>(out: &[u8]) -> anyhow::Result<T> {
    parse_value(serde_json::from_slice(out)?)
}

/// parse_value is parse_json for JSON already read.
pub fn parse_value<T: DeserializeOwned>(mut v: Value) -> anyhow::Result<T> {
    drop_nulls(&mut v);
    Ok(serde_json::from_value(v)?)
}

fn drop_nulls(v: &mut Value) {
    match v {
        Value::Object(map) => {
            map.retain(|_, v| !v.is_null());
            map.values_mut().for_each(drop_nulls);
        }
        Value::Array(items) => items.iter_mut().for_each(drop_nulls),
        _ => {}
    }
}

/// last_line is the last line of out, past anything a shell profile prints.
pub fn last_line(out: &str) -> String {
    out.trim_end_matches('\n')
        .rsplit('\n')
        .next()
        .unwrap_or("")
        .to_string()
}

/// split_lines is the non-empty lines of s.
pub fn split_lines(s: &str) -> Vec<String> {
    s.trim()
        .split('\n')
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(data))
}

/// is_false leaves a field out of the JSON when it is false, like Go's omitempty.
pub fn is_false(b: &bool) -> bool {
    !*b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_line_skips_profile_noise() {
        assert_eq!(
            last_line("hello from zshrc\n/usr/bin:/bin\n"),
            "/usr/bin:/bin"
        );
        assert_eq!(last_line(""), "");
    }

    #[test]
    fn parse_json_treats_null_as_missing() {
        #[derive(serde::Deserialize)]
        struct S {
            #[serde(default)]
            name: String,
            #[serde(default)]
            items: Vec<i64>,
        }
        let s: S = parse_json(br#"{"name": null, "items": null}"#).unwrap();
        assert_eq!(s.name, "");
        assert!(s.items.is_empty());
    }
}
