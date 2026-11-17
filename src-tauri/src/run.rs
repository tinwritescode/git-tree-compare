use serde::Serialize;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const RUN_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// RunResult is the outcome of a command run from the app.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub output: String,
    pub exit_code: i32,
    pub timed_out: bool,
}

/// run_command runs a shell command in repo and returns its output, stdout and stderr as they
/// interleave. The app runs what the user typed, so the command is not sanitised.
pub fn run_command(repo: &str, command: &str) -> RunResult {
    run_with_timeout(repo, command, RUN_TIMEOUT)
}

fn run_with_timeout(repo: &str, command: &str, timeout: Duration) -> RunResult {
    match spawn_and_wait(repo, command, timeout) {
        Ok(res) => res,
        Err(e) => RunResult {
            output: e.to_string(),
            exit_code: -1,
            timed_out: false,
        },
    }
}

fn spawn_and_wait(repo: &str, command: &str, timeout: Duration) -> std::io::Result<RunResult> {
    let (mut reader, writer) = std::io::pipe()?;
    let mut cmd = Command::new("sh");
    cmd.args(["-c", command])
        .current_dir(repo)
        .stdin(Stdio::null())
        .stdout(writer.try_clone()?)
        .stderr(writer)
        // Its own process group, so a timeout stops whatever the command started too.
        .process_group(0);
    let mut child = cmd.spawn()?;
    drop(cmd); // closes this process's copies of the pipe, so the read ends with the command
    let collector = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = reader.read_to_end(&mut out);
        out
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        if Instant::now() >= deadline {
            crate::proc::kill(child.id(), true);
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let output = String::from_utf8_lossy(&collector.join().unwrap_or_default()).into_owned();
    Ok(match status {
        // A command killed by a signal has no code.
        Some(status) => RunResult {
            output,
            exit_code: status.code().unwrap_or(-1),
            timed_out: false,
        },
        None => RunResult {
            output,
            exit_code: -1,
            timed_out: true,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_combined_output_and_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let res = run_command(
            dir.path().to_str().unwrap(),
            "echo out; echo err >&2; pwd; exit 3",
        );
        assert_eq!(res.exit_code, 3);
        assert!(
            res.output.contains("out\nerr\n")
                && res
                    .output
                    .contains(dir.path().file_name().unwrap().to_str().unwrap()),
            "{}",
            res.output
        );
        assert!(!res.timed_out);
    }

    #[test]
    fn stops_a_command_that_runs_too_long() {
        let started = Instant::now();
        let res = run_with_timeout(
            ".",
            "echo before; sleep 30 & wait",
            Duration::from_millis(300),
        );
        assert!(
            res.timed_out && res.exit_code == -1 && res.output == "before\n",
            "{res:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_missing_folder_is_an_error_result() {
        let res = run_command("/no/such/folder", "true");
        assert_eq!(res.exit_code, -1);
        assert!(!res.output.is_empty());
    }
}
