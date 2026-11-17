use anyhow::{bail, Result};
use std::path::{Component, Path, PathBuf};

/// safe_file_path returns the absolute path of rel inside repo. It rejects paths that
/// leave the repository, including through a symlink.
pub fn safe_file_path(repo: &Path, rel: &str) -> Result<PathBuf> {
    if Path::new(rel).is_absolute() {
        bail!("{rel} is not a repository path");
    }
    let root = std::fs::canonicalize(repo)?;
    let resolved = std::fs::canonicalize(root.join(rel))?;
    if !resolved.starts_with(&root) {
        bail!("{rel} is outside the repository");
    }
    Ok(resolved)
}

/// is_local reports whether p, read without touching the disk, stays inside the folder it is
/// joined to: not empty, not absolute, and never climbing above its start.
pub fn is_local(p: &str) -> bool {
    let mut depth = 0usize;
    !p.is_empty()
        && Path::new(p).components().all(|c| match c {
            Component::Normal(_) => {
                depth += 1;
                true
            }
            Component::CurDir => true,
            Component::ParentDir => depth.checked_sub(1).map(|d| depth = d).is_some(),
            Component::RootDir | Component::Prefix(_) => false,
        })
}

/// clean resolves "." and ".." in an absolute path without touching the disk, as Go's filepath.Clean.
pub fn clean(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// diff_anchor is the anchor GitHub uses for one file on a pull request's Files tab: the SHA-256 of its path.
pub fn diff_anchor(path: &str) -> String {
    crate::proc::sha256_hex(path.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_file_path_stays_in_the_repository() {
        let repo = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(repo.path().join("a.txt"), "x").unwrap();
        std::os::unix::fs::symlink(outside.path(), repo.path().join("out")).unwrap();
        std::fs::write(outside.path().join("secret"), "x").unwrap();
        assert!(safe_file_path(repo.path(), "a.txt")
            .unwrap()
            .ends_with("a.txt"));
        assert!(safe_file_path(repo.path(), "/etc/passwd").is_err());
        assert!(safe_file_path(repo.path(), "../x").is_err());
        assert!(safe_file_path(repo.path(), "out/secret")
            .unwrap_err()
            .to_string()
            .contains("outside the repository"));
    }

    #[test]
    fn is_local_rejects_escapes() {
        for p in ["a", "a/b", "./a", "a/../b"] {
            assert!(is_local(p), "{p}");
        }
        for p in ["", "/a", "..", "../a", "a/../../b"] {
            assert!(!is_local(p), "{p}");
        }
    }

    #[test]
    fn clean_resolves_dots() {
        assert_eq!(clean(Path::new("/a/b/../c/./d")), PathBuf::from("/a/c/d"));
        assert_eq!(clean(Path::new("/..")), PathBuf::from("/"));
    }

    #[test]
    fn diff_anchor_is_the_sha256_of_the_path() {
        assert_eq!(
            diff_anchor("README.md"),
            crate::proc::sha256_hex(b"README.md")
        );
        assert_eq!(diff_anchor("").len(), 64);
        assert_eq!(
            diff_anchor(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
