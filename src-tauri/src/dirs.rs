use crate::files::clean;
use anyhow::Result;
use serde::Serialize;
use std::path::Path;

/// DirEntry is one visible subfolder in the in-app repository picker.
/// IsRepo marks a folder that holds a .git entry (a directory or a worktree file).
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_repo: bool,
}

/// DirListing is one folder as shown by the in-app repository picker.
/// Parent is "" at the filesystem root.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub parent: String,
    pub is_repo: bool,
    pub entries: Vec<DirEntry>,
}

/// list_dir returns the visible subfolders of path, sorted by name.
/// Hidden folders are skipped. Entries that are repositories are marked.
pub fn list_dir(path: &str) -> Result<DirListing> {
    let abs = clean(&std::path::absolute(path)?);
    let mut entries = Vec::new();
    for item in std::fs::read_dir(&abs)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();
        if !item.file_type()?.is_dir() || name.starts_with('.') {
            continue;
        }
        let child = abs.join(&name);
        entries.push(DirEntry {
            is_repo: is_repo_dir(&child),
            path: child.to_string_lossy().into_owned(),
            name,
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(DirListing {
        path: abs.to_string_lossy().into_owned(),
        parent: abs
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        is_repo: is_repo_dir(&abs),
        entries,
    })
}

/// is_repo_dir reports whether dir holds a .git entry. A worktree or submodule has a .git file.
fn is_repo_dir(dir: &Path) -> bool {
    dir.join(".git").exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_visible_folders_and_marks_repositories() {
        let root = tempfile::tempdir().unwrap();
        let p = root.path();
        for d in ["b", "a/.git", ".hidden"] {
            std::fs::create_dir_all(p.join(d)).unwrap();
        }
        std::fs::write(p.join("file"), "").unwrap();
        let listing = list_dir(p.join("b/..").to_str().unwrap()).unwrap();
        assert_eq!(listing.path, p.to_str().unwrap());
        let names: Vec<_> = listing
            .entries
            .iter()
            .map(|e| (e.name.as_str(), e.is_repo))
            .collect();
        assert_eq!(names, [("a", true), ("b", false)]);
        assert!(!listing.parent.is_empty());
        assert_eq!(list_dir("/").unwrap().parent, "");
    }

    #[test]
    fn a_missing_folder_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(list_dir(dir.path().join("nope").to_str().unwrap()).is_err());
    }
}
