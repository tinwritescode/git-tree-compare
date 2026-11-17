//! The embedded terminal: one login shell on a pty, which the terminal panel talks to.

use crate::shellpath::user_shell;
use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// TermEvent is what the shell does: writes bytes, or exits.
pub enum TermEvent<'a> {
    Data(&'a [u8]),
    Exit,
}

struct Session {
    /// tells this session from the one that replaced it
    id: u64,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

static CURRENT: Mutex<Option<Session>> = Mutex::new(None);
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

fn current() -> std::sync::MutexGuard<'static, Option<Session>> {
    CURRENT.lock().unwrap_or_else(|e| e.into_inner())
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// start starts a login shell in repo, replacing any shell already running. emit gets its output
/// as it comes, then one Exit.
pub fn start(
    repo: &str,
    (cols, rows): (u16, u16),
    emit: impl Fn(TermEvent) + Send + 'static,
) -> Result<()> {
    stop();
    let pair = native_pty_system().openpty(size(cols, rows))?;
    // A login shell loads the user's PATH, which a Finder-launched app does not have.
    let mut cmd = CommandBuilder::new(user_shell());
    cmd.arg("-l");
    cmd.cwd(repo);
    cmd.env("TERM", "xterm-256color");
    let mut child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave); // the shell holds the only copy, so reading ends when it exits
    let mut reader = pair.master.try_clone_reader()?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    *current() = Some(Session {
        id,
        writer: pair.master.take_writer()?,
        master: pair.master,
        killer: child.clone_killer(),
    });

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n @ 1..) = reader.read(&mut buf) {
            emit(TermEvent::Data(&buf[..n]));
        }
        let _ = child.wait();
        let mut cur = current();
        if cur.as_ref().is_some_and(|s| s.id == id) {
            *cur = None;
        }
        drop(cur);
        emit(TermEvent::Exit);
    });
    Ok(())
}

/// write sends keystrokes to the running shell.
pub fn write(data: &str) -> Result<()> {
    let mut cur = current();
    let s = cur
        .as_mut()
        .ok_or_else(|| anyhow!("the terminal is not running"))?;
    s.writer.write_all(data.as_bytes())?;
    Ok(())
}

/// resize tells the shell the panel's size in character cells.
pub fn resize(cols: u16, rows: u16) -> Result<()> {
    match current().as_ref() {
        Some(s) => s.master.resize(size(cols, rows)),
        None => Ok(()),
    }
}

/// stop ends the running shell, if any.
pub fn stop() {
    let s = current().take();
    if let Some(mut s) = s {
        let _ = s.killer.kill();
    }
}

#[cfg(test)]
pub fn running() -> bool {
    current().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// A shell that is told to exit ends, and the session is forgotten.
    #[test]
    fn shell_exit_clears_the_session() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        start(dir.path().to_str().unwrap(), (80, 24), move |ev| {
            if let TermEvent::Exit = ev {
                let _ = tx.send(());
            }
        })
        .unwrap();
        write("exit\n").unwrap();
        rx.recv_timeout(Duration::from_secs(5))
            .expect("the shell did not exit");
        let deadline = Instant::now() + Duration::from_secs(1);
        while running() {
            assert!(Instant::now() < deadline, "the session was kept");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(write("x").is_err());
    }
}
