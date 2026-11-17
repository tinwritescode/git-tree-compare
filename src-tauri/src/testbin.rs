//! Fake gh and claude binaries for tests. Each fake goes first on PATH while its guard lives;
//! the guard holds a lock, so tests with fakes never see each other's.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

static PATH_LOCK: Mutex<()> = Mutex::new(());

pub struct FakeBin {
    dir: tempfile::TempDir,
    old_path: String,
    _lock: MutexGuard<'static, ()>,
}

/// fake_bin writes a shell script called name whose body can append to $LOG, and puts it on PATH.
pub fn fake_bin(name: &str, body: &str) -> FakeBin {
    let lock = PATH_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("calls");
    let script = format!("#!/bin/sh\nLOG='{}'\n{body}", log.display());
    let bin = dir.path().join(name);
    std::fs::write(&bin, script).unwrap();
    std::fs::set_permissions(&bin, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let old_path = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", format!("{}:{old_path}", dir.path().display()));
    FakeBin {
        dir,
        old_path,
        _lock: lock,
    }
}

impl FakeBin {
    /// dir is a folder that exists, to run the fake in.
    pub fn dir(&self) -> &str {
        self.dir.path().to_str().unwrap()
    }

    pub fn log_path(&self) -> PathBuf {
        self.dir.path().join("calls")
    }

    pub fn log(&self) -> String {
        std::fs::read_to_string(self.log_path()).unwrap_or_default()
    }
}

impl Drop for FakeBin {
    fn drop(&mut self) {
        std::env::set_var("PATH", &self.old_path);
    }
}
