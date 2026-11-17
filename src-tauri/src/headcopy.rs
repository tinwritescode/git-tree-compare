use crate::editors::{editor_app, open_with};
use crate::files::{is_local, safe_file_path};
use crate::git::run_git_bytes;
use crate::since::COMMIT_ID;
use anyhow::{anyhow, bail, Result};
use std::io::Write;
use std::path::{Path, PathBuf};

/// HeadCopyRequest names one file of a pull request at its head commit, and the temp dir its
/// read-only copy goes under.
struct HeadCopyRequest<'a> {
    tmp: &'a Path,
    repo: &'a str,
    number: i64,
    head: &'a str,
    /// repository path of the file
    path: &'a str,
}

/// repo_hash names a repository's folder under the temp dir, so two repositories never share copies.
pub fn repo_hash(repo: &str) -> String {
    crate::proc::sha256_hex(repo.as_bytes())[..12].to_string()
}

/// head_copy_root is the folder all copies of one pull request head go in:
/// <tmp>/git-tree-compare/<repo-hash>/pr-<n>/<head-short>. It checks what goes into the path.
fn head_copy_root(r: &HeadCopyRequest) -> Result<PathBuf> {
    if !COMMIT_ID.is_match(r.head) {
        bail!("{:?} is not a commit id", r.head);
    }
    if r.number < 1 {
        bail!("{} is not a pull request number", r.number);
    }
    if !is_local(r.path) {
        bail!("{} is not a repository path", r.path);
    }
    let short = r
        .head
        .get(..12)
        .expect("a commit id has at least 40 characters");
    Ok(r.tmp
        .join("git-tree-compare")
        .join(repo_hash(r.repo))
        .join(format!("pr-{}", r.number))
        .join(short))
}

/// write_head_copy writes the file as it is at the head commit, read-only, and returns its path.
/// Writing it again replaces whatever is there, so a copy edited or half-written before is fixed.
fn write_head_copy(r: &HeadCopyRequest) -> Result<PathBuf> {
    let root = head_copy_root(r)?;
    let path = root.join(r.path);
    let body = run_git_bytes(r.repo, "", &["show", &format!("{}:{}", r.head, r.path)])
        .map_err(|e| anyhow!("{} is not in the pull request's head commit: {e}", r.path))?;
    let parent = path.parent().expect("a joined file path has a parent");
    std::fs::create_dir_all(parent)?;
    // The folder must not lead out of the copy through a symlink.
    let rel_dir = Path::new(r.path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|p| !p.is_empty())
        .unwrap_or(".".into());
    let dir = safe_file_path(&root, &rel_dir)?;
    let name = path.file_name().expect("a local path ends in a name");
    replace_read_only(&dir.join(name), &body)
}

/// replace_read_only writes body to a temp file next to path and renames it over path, which
/// replaces a file or a symlink there rather than writing through it.
fn replace_read_only(path: &Path, body: &[u8]) -> Result<PathBuf> {
    let dir = path.parent().expect("the copy sits in a folder");
    let mut f = tempfile::Builder::new().prefix(".copy-").tempfile_in(dir)?;
    f.write_all(body)?;
    std::fs::set_permissions(
        f.path(),
        std::os::unix::fs::PermissionsExt::from_mode(0o444),
    )?;
    f.persist(path)?;
    Ok(path.to_path_buf())
}

/// open_at_head opens a read-only copy of a pull request's file at its head commit in the editor,
/// so what the editor shows matches the diff whatever branch is checked out.
pub fn open_at_head(repo: &str, number: i64, head: &str, rel: &str, editor_id: &str) -> Result<()> {
    let app = editor_app(editor_id)?;
    let tmp = std::env::temp_dir();
    let path = write_head_copy(&HeadCopyRequest {
        tmp: &tmp,
        repo,
        number,
        head,
        path: rel,
    })?;
    open_with(app, &path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::testutil::*;
    use std::os::unix::fs::PermissionsExt;

    fn head_repo() -> (tempfile::TempDir, String) {
        let repo = new_repo();
        write_file(repo.path().join("src/a.go"), "package a\n");
        git_in(repo.path(), &["add", "."]);
        git_in(repo.path(), &["commit", "-q", "-m", "first"]);
        let head = git_in(repo.path(), &["rev-parse", "HEAD"]);
        (repo, head)
    }

    #[test]
    fn writes_a_read_only_copy_and_replaces_it() {
        let (repo, head) = head_repo();
        let tmp = tempfile::tempdir().unwrap();
        let r = HeadCopyRequest {
            tmp: tmp.path(),
            repo: repo.path().to_str().unwrap(),
            number: 3,
            head: &head,
            path: "src/a.go",
        };
        let path = write_head_copy(&r).unwrap();
        assert!(path.ends_with(format!("pr-3/{}/src/a.go", &head[..12])));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "package a\n");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o444
        );
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::fs::write(&path, "edited").unwrap();
        assert_eq!(
            std::fs::read_to_string(write_head_copy(&r).unwrap()).unwrap(),
            "package a\n"
        );
    }

    #[test]
    fn rejects_bad_requests() {
        let (repo, head) = head_repo();
        let tmp = tempfile::tempdir().unwrap();
        let r = |number, head: &str, path| {
            write_head_copy(&HeadCopyRequest {
                tmp: tmp.path(),
                repo: repo.path().to_str().unwrap(),
                number,
                head,
                path,
            })
        };
        assert!(r(1, "HEAD", "src/a.go").is_err());
        assert!(r(0, &head, "src/a.go").is_err());
        assert!(r(1, &head, "../a.go").is_err());
        assert!(r(1, &head, "missing.go")
            .unwrap_err()
            .to_string()
            .contains("is not in the pull request's head commit"));
    }

    #[test]
    fn will_not_write_through_a_planted_symlink() {
        let (repo, head) = head_repo();
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let r = HeadCopyRequest {
            tmp: tmp.path(),
            repo: repo.path().to_str().unwrap(),
            number: 1,
            head: &head,
            path: "src/a.go",
        };
        let root = head_copy_root(&r).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("src")).unwrap();
        assert!(write_head_copy(&r).is_err());
        assert!(!outside.path().join("a.go").exists());
    }
}
