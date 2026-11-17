//! Putting the `git-tree-compare` command on the user's PATH, like VS Code's `code` or Zed's `zed`.

use crate::shellpath::login_shell_path;
use crate::updates::app_bundle_path;
use anyhow::{anyhow, bail, Result};
use std::io::Write;
use std::path::{Path, PathBuf};

const CLI_SCRIPT: &str = include_str!("../../scripts/git-tree-compare");
const CLI_NAME: &str = "git-tree-compare";
/// CLI_MARKER is a line every version of the script carries, so the app only ever
/// replaces a command it wrote.
const CLI_MARKER: &str = "# Open a git repository in git-tree-compare";
/// CLI_DEFAULT_APP is the bundle the script opens unless the installer points it elsewhere.
const CLI_DEFAULT_APP: &str = "/Applications/git-tree-compare.app";

/// install_cli installs the command and returns where it went.
pub fn install_cli() -> Result<PathBuf> {
    let app = app_bundle_path()?;
    let home = std::env::home_dir().ok_or_else(|| anyhow!("no home folder"))?;
    write_first(&cli_dirs(&home, &login_shell_path()), &app)
}

/// refresh_installed_cli rewrites an installed command that points at this bundle, so it
/// stays in step with the app after an update.
pub fn refresh_installed_cli() {
    if let (Ok(app), Some(home)) = (app_bundle_path(), std::env::home_dir()) {
        refresh_cli(&cli_dirs(&home, &login_shell_path()), &app);
    }
}

/// cli_script_for returns the command's script, opening the bundle at app.
fn cli_script_for(app: &Path) -> String {
    CLI_SCRIPT.replacen(CLI_DEFAULT_APP, &app.to_string_lossy(), 1)
}

/// cli_dirs returns the folders the command may go in that the terminal's PATH lists,
/// in order of preference. The user's own bin comes first because it needs no admin rights.
fn cli_dirs(home: &Path, path: &str) -> Vec<PathBuf> {
    let listed: Vec<&str> = path.split(':').collect();
    [
        home.join(".local").join("bin"),
        "/usr/local/bin".into(),
        "/opt/homebrew/bin".into(),
    ]
    .into_iter()
    .filter(|d| listed.contains(&d.to_string_lossy().as_ref()))
    .collect()
}

/// write_first writes the command into the first of dirs that takes it. A file of the same
/// name that the app did not write is left alone.
fn write_first(dirs: &[PathBuf], app: &Path) -> Result<PathBuf> {
    let mut err =
        anyhow!("none of ~/.local/bin, /usr/local/bin or /opt/homebrew/bin is on your PATH");
    for dir in dirs {
        let target = dir.join(CLI_NAME);
        match write_cli(&target, &cli_script_for(app)) {
            Ok(()) => return Ok(target),
            Err(e) => err = e,
        }
    }
    Err(err.context(format!("could not install the {CLI_NAME} command")))
}

/// refresh_cli rewrites each installed command in dirs that opens app and is out of date.
fn refresh_cli(dirs: &[PathBuf], app: &Path) {
    let want = cli_script_for(app);
    let points_here = format!(":-{}}}", app.display());
    for dir in dirs {
        let target = dir.join(CLI_NAME);
        if let Ok(got) = std::fs::read_to_string(&target) {
            if got != want && got.contains(&points_here) {
                let _ = write_cli(&target, &want);
            }
        }
    }
}

/// write_cli replaces target with script through a rename, so a half-written command is never
/// on the PATH.
fn write_cli(target: &Path, script: &str) -> Result<()> {
    if let Ok(old) = std::fs::read_to_string(target) {
        if !old.contains(CLI_MARKER) {
            bail!(
                "{} exists and was not installed by this app",
                target.display()
            );
        }
    }
    let dir = target.parent().expect("the command goes in a folder");
    let mut tmp = tempfile::Builder::new()
        .prefix(&format!(".{CLI_NAME}-"))
        .tempfile_in(dir)?;
    tmp.write_all(script.as_bytes())?;
    std::fs::set_permissions(
        tmp.path(),
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )?;
    tmp.persist(target)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn script_points_at_the_bundle() {
        let s = cli_script_for(Path::new("/Users/me/Apps/x.app"));
        assert!(
            s.contains("${GTC_APP:-/Users/me/Apps/x.app}")
                && s.contains(CLI_MARKER)
                && !s.contains(CLI_DEFAULT_APP)
        );
    }

    #[test]
    fn keeps_only_dirs_on_path() {
        let got = cli_dirs(Path::new("/h"), "/opt/homebrew/bin:/usr/bin:/h/.local/bin");
        assert_eq!(
            got,
            [
                PathBuf::from("/h/.local/bin"),
                PathBuf::from("/opt/homebrew/bin")
            ]
        );
    }

    #[test]
    fn writes_an_executable_script_and_replaces_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let target = write_first(&[dir.path().into()], Path::new("/A.app")).unwrap();
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o755
        );
        std::fs::write(&target, format!("{CLI_MARKER}\nold")).unwrap();
        write_first(&[dir.path().into()], Path::new("/A.app")).unwrap();
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            cli_script_for(Path::new("/A.app"))
        );
    }

    #[test]
    fn keeps_someone_elses_file_and_tries_the_next_folder() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        std::fs::write(first.path().join(CLI_NAME), "mine").unwrap();
        let target = write_first(
            &[first.path().into(), second.path().into()],
            Path::new("/A.app"),
        )
        .unwrap();
        assert!(target.starts_with(second.path()));
        assert_eq!(
            std::fs::read_to_string(first.path().join(CLI_NAME)).unwrap(),
            "mine"
        );
        let err = write_first(&[first.path().into()], Path::new("/A.app")).unwrap_err();
        assert!(format!("{err:#}").contains("was not installed by this app"));
        assert!(write_first(&[], Path::new("/A.app")).is_err());
    }

    #[test]
    fn refresh_updates_only_this_bundles_command() {
        let mine = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let stale = |app: &str| cli_script_for(Path::new(app)).replace("exec open", "exec  open");
        std::fs::write(mine.path().join(CLI_NAME), stale("/A.app")).unwrap();
        std::fs::write(other.path().join(CLI_NAME), stale("/B.app")).unwrap();
        refresh_cli(
            &[mine.path().into(), other.path().into()],
            Path::new("/A.app"),
        );
        assert_eq!(
            std::fs::read_to_string(mine.path().join(CLI_NAME)).unwrap(),
            cli_script_for(Path::new("/A.app"))
        );
        assert_eq!(
            std::fs::read_to_string(other.path().join(CLI_NAME)).unwrap(),
            stale("/B.app")
        );
    }
}
