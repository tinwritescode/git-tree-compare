//! Carrying the Wails build's saved state over. Wails served the page from wails://wails and Tauri
//! serves it from tauri://localhost, so WebKit keeps their localStorage apart. The frontend asks for
//! the old items once and copies those it lacks.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

/// WAILS_STORE is where WebKit kept the Wails build's website data, under the home folder.
const WAILS_STORE: &str = "Library/WebKit/com.wails.git-tree-compare/WebsiteData/Default";

/// legacy_items returns the localStorage items the Wails build kept, or none when it never ran here.
pub fn legacy_items() -> Vec<(String, String)> {
    std::env::home_dir().map_or_else(Vec::new, |home| items_in(&home.join(WAILS_STORE)))
}

/// items_in reads every origin's localStorage in a WebKit store. WebKit names each origin's folder
/// with a salted hash, so all are read; where two hold a key, the one written last wins.
fn items_in(store: &Path) -> Vec<(String, String)> {
    let mut dbs: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(store)
        .into_iter()
        .flatten()
        .flatten()
        .flat_map(|outer| {
            std::fs::read_dir(outer.path())
                .into_iter()
                .flatten()
                .flatten()
        })
        .map(|inner| inner.path().join("LocalStorage/localstorage.sqlite3"))
        .filter_map(|db| Some((db.metadata().ok()?.modified().ok()?, db)))
        .collect();
    dbs.sort();
    let items: BTreeMap<String, String> = dbs.iter().flat_map(|(_, db)| read_db(db)).collect();
    items.into_iter().collect()
}

/// read_db reads one localStorage database with the system's sqlite3. WebKit stores each value as
/// UTF-16LE, so it is read as hex and decoded here. A database it cannot read gives no items.
fn read_db(db: &Path) -> Vec<(String, String)> {
    #[derive(Deserialize)]
    struct Row {
        key: String,
        value: String,
    }
    let out = Command::new("/usr/bin/sqlite3")
        .args(["-readonly", "-json"])
        .arg(db)
        .arg("select key, hex(value) as value from ItemTable")
        .output();
    let rows: Vec<Row> = match out {
        // sqlite3 prints nothing at all for no rows.
        Ok(out) if out.status.success() && !out.stdout.is_empty() => {
            serde_json::from_slice(&out.stdout).unwrap_or_default()
        }
        _ => Vec::new(),
    };
    rows.into_iter()
        .filter_map(|r| Some((r.key, utf16le(&hex::decode(r.value).ok()?)?)))
        .collect()
}

fn utf16le(bytes: &[u8]) -> Option<String> {
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| u16::from_le_bytes(*b))
        .collect();
    String::from_utf16(&units).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// make_db writes a localStorage database the way WebKit does, at store/<a>/<a>/LocalStorage.
    fn make_db(store: &Path, origin: &str, items: &[(&str, &str)]) -> PathBuf {
        let dir = store.join(origin).join(origin).join("LocalStorage");
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("localstorage.sqlite3");
        let mut sql = String::from("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE PRIMARY KEY NOT NULL, value BLOB NOT NULL);");
        for (k, v) in items {
            let utf16: Vec<u8> = v.encode_utf16().flat_map(u16::to_le_bytes).collect();
            sql += &format!(
                "INSERT INTO ItemTable VALUES ('{k}', X'{}');",
                hex::encode(utf16)
            );
        }
        let ok = Command::new("/usr/bin/sqlite3")
            .arg(&db)
            .arg(sql)
            .status()
            .unwrap()
            .success();
        assert!(ok, "sqlite3 could not write {}", db.display());
        db
    }

    #[test]
    fn reads_every_origin_and_lets_the_newest_win() {
        let store = tempfile::tempdir().unwrap();
        let old = make_db(
            store.path(),
            "old",
            &[("git-tree-compare:recent", "[\"/a\"]"), ("only-old", "1")],
        );
        make_db(
            store.path(),
            "new",
            &[("git-tree-compare:recent", "[\"/b\"]"), ("draft", "é ✓ 🙂")],
        );
        make_db(store.path(), "empty", &[]);
        let past = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        std::fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(past)
            .unwrap();

        let got = items_in(store.path());
        let want = [
            ("draft", "é ✓ 🙂"),
            ("git-tree-compare:recent", "[\"/b\"]"),
            ("only-old", "1"),
        ];
        assert_eq!(got, want.map(|(k, v)| (k.to_string(), v.to_string())));
    }

    #[test]
    fn a_missing_store_has_no_items() {
        let dir = tempfile::tempdir().unwrap();
        assert!(items_in(&dir.path().join("none")).is_empty());
    }
}
