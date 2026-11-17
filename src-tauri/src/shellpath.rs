use crate::proc::{last_line, output_timeout};
use std::process::Command;
use std::time::Duration;

/// user_shell is the user's login shell, zsh when SHELL is unset.
pub fn user_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".into())
}

/// load_login_path gives the app the PATH the user's terminal has. An app opened from
/// Finder or the Dock starts with only /usr/bin:/bin:/usr/sbin:/sbin, so gh and the
/// other tools Homebrew installs would not be found. Call it before any thread starts.
pub fn load_login_path() {
    let current = std::env::var("PATH").unwrap_or_default();
    std::env::set_var(
        "PATH",
        join_path(&[
            &login_shell_path(),
            &current,
            "/opt/homebrew/bin",
            "/usr/local/bin",
        ]),
    );
}

/// login_shell_path asks a login shell for its PATH, or returns "" when it cannot within 3 seconds.
pub fn login_shell_path() -> String {
    let mut cmd = Command::new(user_shell());
    cmd.args(["-l", "-c", r#"printf '\n%s' "$PATH""#]);
    match output_timeout(cmd, Duration::from_secs(3)) {
        Some(out) if out.status.success() => last_line(&String::from_utf8_lossy(&out.stdout)),
        _ => String::new(),
    }
}

/// join_path joins PATH lists in order, keeping the first copy of each directory.
pub fn join_path(lists: &[&str]) -> String {
    let mut dirs: Vec<&str> = Vec::new();
    for dir in lists.iter().flat_map(|l| l.split(':')) {
        if !dir.is_empty() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs.join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_path_keeps_first_copies_in_order() {
        assert_eq!(join_path(&["/a:/b", "", "/b:/c::/a", "/d"]), "/a:/b:/c:/d");
    }
}
