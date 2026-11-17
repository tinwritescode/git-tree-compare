use crate::files::safe_file_path;
use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Editor is a code editor the app can open a file in.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Editor {
    pub id: &'static str,
    pub name: &'static str,
    /// The macOS bundle name, without ".app". `open -a` launches the editor by it.
    pub app: &'static str,
}

/// KNOWN_EDITORS lists the editors offered in the app, in the order they are suggested.
const KNOWN_EDITORS: [Editor; 4] = [
    Editor {
        id: "zed",
        name: "Zed",
        app: "Zed",
    },
    Editor {
        id: "vscode",
        name: "VS Code",
        app: "Visual Studio Code",
    },
    Editor {
        id: "cursor",
        name: "Cursor",
        app: "Cursor",
    },
    Editor {
        id: "sublime",
        name: "Sublime Text",
        app: "Sublime Text",
    },
];

/// installed_editors returns the known editors whose app is installed for this user or system-wide.
pub fn installed_editors() -> Vec<Editor> {
    let home = std::env::home_dir().unwrap_or_default();
    editors_in(&[PathBuf::from("/Applications"), home.join("Applications")])
}

/// editors_in keeps the editors whose "<App>.app" folder exists in one of dirs.
fn editors_in(dirs: &[PathBuf]) -> Vec<Editor> {
    KNOWN_EDITORS
        .into_iter()
        .filter(|e| {
            dirs.iter()
                .any(|d| d.join(format!("{}.app", e.app)).exists())
        })
        .collect()
}

/// open_in_editor opens a file of the repository in the editor with the given ID.
pub fn open_in_editor(repo: &str, rel: &str, id: &str) -> Result<()> {
    let app = editor_app(id)?;
    open_with(app, &safe_file_path(Path::new(repo), rel)?)
}

/// editor_app is the app bundle name of the editor with the given ID.
pub fn editor_app(id: &str) -> Result<&'static str> {
    KNOWN_EDITORS
        .iter()
        .find(|e| e.id == id)
        .map(|e| e.app)
        .ok_or_else(|| anyhow!("unknown editor {id:?}"))
}

/// open_with opens path in the macOS app named app.
pub fn open_with(app: &str, path: &Path) -> Result<()> {
    let status = Command::new("open").arg("-a").arg(app).arg(path).status()?;
    if !status.success() {
        bail!("open {status}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_installed_editors_in_order() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("Cursor.app")).unwrap();
        std::fs::create_dir(dir.path().join("Zed.app")).unwrap();
        let ids: Vec<_> = editors_in(&[dir.path().into()])
            .iter()
            .map(|e| e.id)
            .collect();
        assert_eq!(ids, ["zed", "cursor"]);
        assert_eq!(editor_app("vscode").unwrap(), "Visual Studio Code");
        assert!(editor_app("vim").is_err());
    }

    #[test]
    fn open_in_editor_rejects_an_unknown_id() {
        let dir = tempfile::tempdir().unwrap();
        assert!(open_in_editor(dir.path().to_str().unwrap(), "main.go", "notepad").is_err());
    }
}
