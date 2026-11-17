//! Checking for a newer release, and installing it in place of this app.

use crate::proc;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

/// APP_VERSION is the version this build reports, from Cargo.toml, which also sets the bundle version.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// UPDATE_REPO is the GitHub repository whose latest release is the newest build.
const UPDATE_REPO: &str = "tinwritescode/git-tree-compare";

/// UPDATE_ZIP_PREFIX starts the name of the macOS zip an in-place update installs.
const UPDATE_ZIP_PREFIX: &str = "git-tree-compare";

/// UpdateInfo says whether a newer release exists and where to download it.
#[derive(Serialize, Debug, Default)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub url: String,
    pub available: bool,
    /// the release has a zip and checksum to install in place
    pub installable: bool,
}

/// GhRelease is the part of a GitHub release the update check and install read.
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(default)]
pub struct GhRelease {
    pub tag_name: String,
    pub html_url: String,
    pub assets: Vec<GhAsset>,
}

/// GhAsset is one file attached to a release.
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(default)]
pub struct GhAsset {
    pub name: String,
    #[serde(rename = "browser_download_url")]
    pub url: String,
}

/// check_update asks GitHub for the latest release and compares it with this build.
/// It reads only. The repository is private, so it needs gh logged in.
pub fn check_update() -> Result<UpdateInfo> {
    Ok(update_info(APP_VERSION, &fetch_latest_release()?))
}

fn update_info(current: &str, release: &GhRelease) -> UpdateInfo {
    let latest = release.tag_name.trim_start_matches('v').to_string();
    UpdateInfo {
        current: current.into(),
        available: is_newer(&latest, current),
        latest,
        url: release.html_url.clone(),
        installable: release_assets(&release.assets).is_some(),
    }
}

/// fetch_latest_release reads the latest published release. GitHub skips drafts and prereleases here.
pub fn fetch_latest_release() -> Result<GhRelease> {
    let out = Command::new("gh")
        .args(["api", &format!("repos/{UPDATE_REPO}/releases/latest")])
        .output()
        .context("could not check for updates")?;
    if !out.status.success() {
        bail!("could not check for updates: gh {}", out.status);
    }
    proc::parse_json(&out.stdout)
}

/// is_newer reports whether version latest is greater than current. Versions are MAJOR.MINOR.PATCH;
/// anything else is never newer, so an odd tag cannot trigger a prompt.
pub fn is_newer(latest: &str, current: &str) -> bool {
    matches!((parse_version(latest), parse_version(current)), (Some(a), Some(b)) if a > b)
}

/// parse_version reads "v1.2.3", "1.2" or "1" into its three numbers.
fn parse_version(v: &str) -> Option<[u64; 3]> {
    let parts: Vec<&str> = v.strip_prefix('v').unwrap_or(v).split('.').collect();
    if parts.len() > 3 {
        return None;
    }
    let mut out = [0; 3];
    for (slot, p) in out.iter_mut().zip(parts) {
        // Digits only: "+1" and "-1" parse as numbers but are not versions.
        if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *slot = p.parse().ok()?;
    }
    Some(out)
}

/// ReleaseAssets is the zip an update installs and its .sha256 file.
struct ReleaseAssets<'a> {
    zip_url: &'a str,
    sum_url: &'a str,
    zip_name: &'a str,
}

/// release_assets finds the zip and its .sha256 file in a release. The update installs only
/// when both are there; a release without them is offered as a download only.
fn release_assets(assets: &[GhAsset]) -> Option<ReleaseAssets<'_>> {
    assets
        .iter()
        .filter(|a| a.name.starts_with(UPDATE_ZIP_PREFIX) && a.name.ends_with(".zip"))
        .find_map(|zip| {
            let sum = assets
                .iter()
                .find(|a| a.name == format!("{}.sha256", zip.name))?;
            Some(ReleaseAssets {
                zip_url: &zip.url,
                sum_url: &sum.url,
                zip_name: &zip.name,
            })
        })
}

/// download_file saves url to dst with curl, which follows GitHub's redirects to the asset.
fn download_file(url: &str, dst: &Path) -> Result<()> {
    let out = Command::new("curl")
        .args(["-fsSL", "--max-time", "600", "-o"])
        .arg(dst)
        .arg(url)
        .output()
        .context("could not download the update")?;
    if !out.status.success() {
        bail!(
            "could not download the update: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

/// verify_checksum checks that the file at path hashes to the first field of sum_file,
/// the layout `shasum -a 256` writes.
fn verify_checksum(path: &Path, sum_file: &str) -> Result<()> {
    let want = sum_file
        .split_whitespace()
        .next()
        .ok_or_else(|| anyhow!("the release checksum is empty, so the update was not installed"))?;
    if proc::sha256_hex(&std::fs::read(path)?) != want.to_lowercase() {
        bail!("the download does not match its checksum, so the update was not installed");
    }
    Ok(())
}

/// find_app returns the single .app bundle directly inside dir.
fn find_app(dir: &Path) -> Result<PathBuf> {
    let apps: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|ext| ext == "app"))
        .collect();
    match &apps[..] {
        [app] => Ok(app.clone()),
        _ => bail!("the update does not contain exactly one app"),
    }
}

/// bundle_version reads the version an app bundle reports.
fn bundle_version(app: &Path) -> Result<String> {
    let out = Command::new("/usr/libexec/PlistBuddy")
        .args(["-c", "Print :CFBundleShortVersionString"])
        .arg(app.join("Contents").join("Info.plist"))
        .output()
        .context("could not read the update's version")?;
    if !out.status.success() {
        bail!(
            "could not read the update's version: PlistBuddy {}",
            out.status
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// app_bundle_path returns the .app bundle this process runs from. A plain dev binary has none,
/// so it cannot replace itself.
pub fn app_bundle_path() -> Result<PathBuf> {
    let exe = std::env::current_exe()?;
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|ext| ext == "app"))
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            anyhow!("the app is not running from an .app bundle, so it cannot update itself")
        })
}

/// replace_bundle moves new_app into the place of app_path. The old bundle is kept until the
/// swap succeeds, and put back if it fails.
fn replace_bundle(new_app: &Path, app_path: &Path) -> Result<()> {
    std::fs::metadata(new_app)?;
    let mut previous = app_path.as_os_str().to_owned();
    previous.push(".previous");
    let previous = PathBuf::from(previous);
    remove_all(&previous)?;
    std::fs::rename(app_path, &previous).context("could not move the current app aside")?;
    if let Err(e) = std::fs::rename(new_app, app_path) {
        let _ = std::fs::rename(&previous, app_path);
        return Err(anyhow!(e).context("could not put the new app in place"));
    }
    remove_all(&previous)
}

/// remove_all removes path and everything in it; a path that is not there is fine.
fn remove_all(path: &Path) -> Result<()> {
    match std::fs::remove_dir_all(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// install_release downloads release, checks it against its checksum and version, and replaces
/// the app at app_path with it. The staging folder sits beside the app so the final move stays on
/// one volume.
pub fn install_release(release: &GhRelease, app_path: &Path) -> Result<()> {
    let latest = release.tag_name.trim_start_matches('v');
    if !is_newer(latest, APP_VERSION) {
        bail!("version {APP_VERSION} is already the newest");
    }
    let assets = release_assets(&release.assets).ok_or_else(|| {
        anyhow!("version {latest} has no installable build, so download it from the release page")
    })?;

    let parent = app_path.parent().unwrap_or(Path::new("/"));
    let stage = tempfile::Builder::new()
        .prefix(".update-")
        .tempdir_in(parent)
        .with_context(|| {
            format!(
                "cannot write to {}, so the app cannot update itself",
                parent.display()
            )
        })?;

    let zip_path = stage.path().join(assets.zip_name);
    let sum_path = stage.path().join(format!("{}.sha256", assets.zip_name));
    download_file(assets.zip_url, &zip_path)?;
    download_file(assets.sum_url, &sum_path)?;
    verify_checksum(&zip_path, &std::fs::read_to_string(&sum_path)?)?;

    let unpacked = stage.path().join("unpacked");
    std::fs::create_dir(&unpacked)?;
    let out = Command::new("ditto")
        .args(["-x", "-k"])
        .arg(&zip_path)
        .arg(&unpacked)
        .output()?;
    if !out.status.success() {
        let combined = [out.stdout, out.stderr].concat();
        bail!(
            "could not unpack the update: {}",
            String::from_utf8_lossy(&combined).trim()
        );
    }
    let new_app = find_app(&unpacked)?;
    let got = bundle_version(&new_app)?;
    if got != latest {
        bail!("the download is version {got}, not {latest}, so the update was not installed");
    }
    replace_bundle(&new_app, app_path)
}

/// relaunch_after_quit starts a helper that waits for this process to exit, then opens the app.
/// Opening it while this process still runs would hand off to this instance (single-instance lock).
pub fn relaunch_after_quit(app_path: &Path) -> Result<()> {
    let script = r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; open "$2""#;
    Command::new("/bin/sh")
        .args(["-c", script, "sh", &std::process::id().to_string()])
        .arg(app_path)
        .spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::testutil::write_file;

    #[test]
    fn compares_versions() {
        for (latest, current, want) in [
            ("0.2.0", "0.1.0", true),
            ("v1.0.0", "0.9.9", true),
            ("0.1.1", "0.1.0", true),
            ("0.1.0", "0.1.0", false),
            ("0.0.9", "0.1.0", false),
            ("1.0", "0.9.9", true),
            ("0.1.0-beta", "0.1.0", false),
            ("", "0.1.0", false),
            ("1.2.3.4", "0.1.0", false),
        ] {
            assert_eq!(
                is_newer(latest, current),
                want,
                "is_newer({latest:?}, {current:?})"
            );
        }
    }

    fn asset(name: &str) -> GhAsset {
        GhAsset {
            name: name.into(),
            url: format!("https://x/{name}"),
        }
    }

    #[test]
    fn update_info_needs_zip_and_checksum_to_install() {
        let mut release = GhRelease {
            tag_name: "v9.0.0".into(),
            html_url: "https://r".into(),
            assets: vec![asset("git-tree-compare-macos.zip")],
        };
        let info = update_info("0.8.1", &release);
        assert!(info.available && !info.installable && info.latest == "9.0.0");
        release
            .assets
            .push(asset("git-tree-compare-macos.zip.sha256"));
        assert!(update_info("0.8.1", &release).installable);
    }

    #[test]
    fn verifies_checksums() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("f");
        std::fs::write(&file, "data").unwrap();
        let sum = proc::sha256_hex(b"data");
        verify_checksum(&file, &format!("{}  f\n", sum.to_uppercase())).unwrap();
        assert!(verify_checksum(&file, "").is_err());
        assert!(verify_checksum(&file, "abc  f").is_err());
    }

    #[test]
    fn replace_bundle_swaps_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("a.app");
        let new = dir.path().join("new.app");
        write_file(app.join("old"), "");
        write_file(new.join("new"), "");
        replace_bundle(&new, &app).unwrap();
        assert!(app.join("new").exists() && !app.join("old").exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        assert!(
            replace_bundle(&new, &app).is_err(),
            "a missing new app changes nothing"
        );
        assert!(app.join("new").exists());
    }

    #[test]
    fn installs_a_release_from_its_zip() {
        let dir = tempfile::tempdir().unwrap();
        let next = {
            let [a, b, c] = parse_version(APP_VERSION).unwrap();
            format!("{a}.{b}.{}", c + 1)
        };
        let new_app = dir.path().join("build/git-tree-compare.app");
        write_file(
            new_app.join("Contents/Info.plist"),
            &format!(
                r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>{next}</string></dict></plist>"#
            ),
        );
        write_file(new_app.join("marker.txt"), "new build");
        let zip = dir.path().join("git-tree-compare-macos.zip");
        assert!(Command::new("ditto")
            .args(["-c", "-k", "--keepParent"])
            .arg(&new_app)
            .arg(&zip)
            .status()
            .unwrap()
            .success());
        let sum = dir.path().join("git-tree-compare-macos.zip.sha256");
        std::fs::write(
            &sum,
            format!(
                "{}  git-tree-compare-macos.zip\n",
                proc::sha256_hex(&std::fs::read(&zip).unwrap())
            ),
        )
        .unwrap();
        let file_asset = |p: &Path| GhAsset {
            name: p.file_name().unwrap().to_string_lossy().into(),
            url: format!("file://{}", p.display()),
        };
        let release = GhRelease {
            tag_name: format!("v{next}"),
            html_url: String::new(),
            assets: vec![file_asset(&zip), file_asset(&sum)],
        };

        let app_path = dir.path().join("installed/git-tree-compare.app");
        write_file(app_path.join("old.txt"), "old build");
        install_release(&release, &app_path).unwrap();
        assert_eq!(
            std::fs::read_to_string(app_path.join("marker.txt")).unwrap(),
            "new build"
        );
        assert_eq!(
            std::fs::read_dir(app_path.parent().unwrap())
                .unwrap()
                .count(),
            1,
            "leftovers next to the app"
        );

        let same = GhRelease {
            tag_name: format!("v{APP_VERSION}"),
            ..release
        };
        assert!(install_release(&same, &app_path).is_err());
    }
}
