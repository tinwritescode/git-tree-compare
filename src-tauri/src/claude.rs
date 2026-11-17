//! The Claude runner: the one place the app starts claude. A task says what to ask and how; the
//! runner checks its cache, checks the head out in a worktree, runs claude there, streams what it
//! does as claude:<taskId> events, and can stop it. Each kind of task (brief, findings, polish, …)
//! only builds a ClaudeTask; nothing here knows about kinds.

use crate::claude_stream::{error_event, ClaudeEvent, StreamParser};
use crate::git::run_git;
use crate::headcopy::repo_hash;
use crate::proc::{kill, last_line, output_timeout, sha256_hex, split_lines};
use crate::since::COMMIT_ID;
use anyhow::{anyhow, bail, Result};
use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::Duration;

pub const DEFAULT_CLAUDE_MODEL: &str = "claude-opus-5-5";
pub const EVENT_CLAUDE_PREFIX: &str = "claude:"; // + task id
const CLAUDE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_CLAUDE_BUDGET_USD: f64 = 20.0;

/// CLAUDE_READ_TOOLS are the only tools a task may give Claude: they read the checkout and change nothing.
pub const CLAUDE_READ_TOOLS: [&str; 3] = ["Read", "Grep", "Glob"];

/// ClaudeInfo says whether claude can run here, and the model tasks use unless the user picked another.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeInfo {
    pub installed: bool,
    pub version: String,
    pub default_model: String,
}

/// claude_status looks for claude on PATH, which main sets to the login shell's.
pub fn claude_status() -> ClaudeInfo {
    let mut info = ClaudeInfo {
        default_model: DEFAULT_CLAUDE_MODEL.into(),
        ..Default::default()
    };
    let Some(bin) = look_path("claude") else {
        return info;
    };
    info.installed = true;
    let mut cmd = Command::new(bin);
    cmd.arg("--version");
    if let Some(out) = output_timeout(cmd, Duration::from_secs(5)).filter(|o| o.status.success()) {
        let out = String::from_utf8_lossy(&out.stdout);
        info.version = out.trim().split(' ').next().unwrap_or_default().to_string();
    }
    info
}

/// look_path finds an executable called name on PATH.
fn look_path(name: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let path = std::env::var("PATH").ok()?;
    path.split(':')
        .filter(|d| !d.is_empty())
        .map(|d| Path::new(d).join(name))
        .find(|p| {
            p.metadata()
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
}

/// Session says whether Claude keeps the conversation. Most tasks are one-shot.
#[derive(Debug, Clone, Default, PartialEq)]
pub enum Session {
    /// --no-session-persistence
    #[default]
    None,
    /// --session-id: a conversation later tasks resume
    Start(String),
    /// --resume: carry on with one
    Resume(String),
}

/// Input is what claude reads on stdin, built only when claude runs.
pub type Input = Box<dyn Fn() -> Result<String> + Send>;

/// ClaudeTask is one run of claude.
pub struct ClaudeTask {
    /// names the claude:<id> events, and the run to cancel
    pub id: String,
    /// brief, ...; part of the cache key
    pub kind: String,
    /// the instructions; passed after "--", so it is never read as a flag
    pub prompt: String,
    /// a JSON schema the answer must match, or "" for a text answer
    pub schema: String,
    pub input: Input,
    pub model: String,
    pub budget_usd: f64,
    /// from CLAUDE_READ_TOOLS; none disables every tool
    pub tools: Vec<String>,
    /// stream text as it is written
    pub partial: bool,
    pub session: Session,
    /// claude runs in a detached worktree of repo at head
    pub repo: String,
    pub head: String,
    /// where a finished answer is kept; None runs every time
    pub cache: Option<CacheKey>,
    /// ask again even when an answer is kept, and keep the new one
    pub refresh: bool,
}

pub fn read_tools() -> Vec<String> {
    CLAUDE_READ_TOOLS.map(String::from).to_vec()
}

static TASK_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,80}$").unwrap());
static TASK_KIND: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z]{1,20}$").unwrap());
static MODEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,63}$").unwrap());
static SESSION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap()
});

/// validate_task checks every value that becomes an argument, so none can be taken for a flag.
pub fn validate_task(t: &ClaudeTask) -> Result<()> {
    if !TASK_ID.is_match(&t.id) {
        bail!("{:?} is not a task id", t.id);
    }
    if !TASK_KIND.is_match(&t.kind) {
        bail!("{:?} is not a task kind", t.kind);
    }
    if !MODEL.is_match(&t.model) {
        bail!("{:?} is not a Claude model", t.model);
    }
    if t.budget_usd <= 0.0 || t.budget_usd > MAX_CLAUDE_BUDGET_USD {
        bail!("a budget of ${:.2} is out of range", t.budget_usd);
    }
    if let Session::Start(id) | Session::Resume(id) = &t.session {
        if !SESSION.is_match(id) {
            bail!("{id:?} is not a session id");
        }
    }
    if !COMMIT_ID.is_match(&t.head) {
        bail!("{:?} is not a commit id", t.head);
    }
    if t.repo.is_empty() {
        bail!("no repository");
    }
    if let Some(tool) = t
        .tools
        .iter()
        .find(|tool| !CLAUDE_READ_TOOLS.contains(&tool.as_str()))
    {
        bail!("Claude may not use {tool}");
    }
    Ok(())
}

/// claude_args is the command line for a task. --restricted and --safe-mode keep the checkout's own
/// .claude settings, hooks and CLAUDE.md out of the run: the pull request wrote them.
fn claude_args(t: &ClaudeTask) -> Vec<String> {
    let mut args: Vec<String> = ["-p", "--model", &t.model, "--tools"]
        .map(String::from)
        .to_vec();
    if t.tools.is_empty() {
        args.push(String::new());
    } else {
        args.extend(t.tools.iter().cloned());
    }
    args.extend(
        [
            "--strict-mcp-config",
            "--restricted",
            "--safe-mode",
            "--output-format",
            "stream-json",
            "--verbose",
            "--max-budget-usd",
        ]
        .map(String::from),
    );
    args.push(format!("{:.2}", t.budget_usd));
    if !t.schema.is_empty() {
        args.extend(["--json-schema".into(), t.schema.clone()]);
    }
    if t.partial {
        args.push("--include-partial-messages".into());
    }
    match &t.session {
        Session::None => args.push("--no-session-persistence".into()),
        Session::Start(id) => args.extend(["--session-id".into(), id.clone()]),
        Session::Resume(id) => args.extend(["--resume".into(), id.clone()]),
    }
    args.extend(["--".into(), t.prompt.clone()]);
    args
}

/// CacheKey names a finished answer: the same question about the same commits, put to the same
/// model, gets the same answer. Version changes when the prompt or schema does. Subject is the part
/// of the change a task is about, such as one hunk, or "" for the whole change.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CacheKey {
    pub repo: String,
    pub base: String,
    pub head: String,
    pub kind: String,
    pub version: String,
    pub model: String,
    pub subject: String,
}

impl CacheKey {
    fn file(&self) -> String {
        let parts = [
            &self.repo,
            &self.base,
            &self.head,
            &self.kind,
            &self.version,
            &self.model,
            &self.subject,
        ];
        let joined = parts.map(String::as_str).join("\0");
        format!(
            "{}-{}.json",
            self.kind,
            &sha256_hex(joined.as_bytes())[..32]
        )
    }
}

/// prompt_version names a prompt and schema pair, so changing either one misses the old cache.
pub fn prompt_version(parts: &[&str]) -> String {
    sha256_hex(parts.join("\0").as_bytes())[..12].to_string()
}

/// claude_cache_dir is where finished answers are kept: the app's folder in Application Support.
pub fn claude_cache_dir() -> Option<PathBuf> {
    Some(std::env::home_dir()?.join("Library/Application Support/git-tree-compare/claude-cache"))
}

pub type Emit = Box<dyn Fn(&str, &ClaudeEvent) + Send + Sync>;

/// ClaudeRunner runs tasks. It owns the running processes and the worktrees they run in; one lock
/// guards both, so a worktree is never removed between being checked out and claude starting in it.
pub struct ClaudeRunner {
    emit: Emit,
    /// None keeps no answers
    cache_dir: Option<PathBuf>,
    /// worktrees go in <tmp>/git-tree-compare/<repo-hash>/
    tmp: PathBuf,
    state: Mutex<RunnerState>,
}

#[derive(Default)]
struct RunnerState {
    running: HashMap<String, Arc<ClaudeRun>>,
    /// folder -> repository
    worktrees: HashMap<PathBuf, String>,
}

struct ClaudeRun {
    pid: u32,
    dir: PathBuf,
    /// why it was stopped, once it was
    reason: OnceLock<String>,
}

impl ClaudeRun {
    /// stop kills claude and everything it started: it leads its own process group.
    fn stop(&self, reason: &str) {
        let _ = self.reason.set(reason.to_string());
        kill(self.pid, true);
    }
}

impl ClaudeRunner {
    pub fn new(emit: Emit, cache_dir: Option<PathBuf>, tmp: PathBuf) -> Self {
        ClaudeRunner {
            emit,
            cache_dir,
            tmp,
            state: Mutex::default(),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, RunnerState> {
        // A panic while holding the lock leaves plain maps behind, still usable.
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// start checks the task and runs it in the background.
    pub fn start(self: &Arc<Self>, t: ClaudeTask) -> Result<()> {
        validate_task(&t)?;
        let runner = Arc::clone(self);
        std::thread::spawn(move || runner.run(t));
        Ok(())
    }

    /// run runs a task to its end. Tool and text events are sent as they come; the last event is
    /// always one result or one error.
    pub fn run(&self, t: ClaudeTask) {
        if let Err(e) = validate_task(&t) {
            return (self.emit)(&t.id, &error_event(e.to_string()));
        }
        if !t.refresh {
            if let Some(ev) = self.read_cache(t.cache.as_ref()) {
                return (self.emit)(&t.id, &ev);
            }
        }
        let id = t.id.clone();
        let ev = self
            .execute(t)
            .unwrap_or_else(|e| error_event(format!("{e:#}")));
        (self.emit)(&id, &ev);
    }

    /// execute runs claude and returns how it ended.
    fn execute(&self, t: ClaudeTask) -> Result<ClaudeEvent> {
        let input = (t.input)()?;
        let (run, mut child) = self.spawn(&t)?;
        let mut stdin = child.stdin.take().expect("stdin is piped");
        let writer = std::thread::spawn(move || {
            let _ = stdin.write_all(input.as_bytes());
        });
        let mut stderr = child.stderr.take().expect("stderr is piped");
        let stderr_reader = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = stderr.read_to_string(&mut s);
            s
        });
        // Dropping the sender ends the watch; reaching the timeout stops claude.
        let (done, watch) = std::sync::mpsc::channel::<()>();
        let watched = Arc::clone(&run);
        std::thread::spawn(move || {
            if watch.recv_timeout(CLAUDE_TIMEOUT) == Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            {
                watched.stop(&format!(
                    "Claude took longer than {}m0s, so it was stopped.",
                    CLAUDE_TIMEOUT.as_secs() / 60
                ));
            }
        });

        let parser = StreamParser {
            roots: folder_names(&run.dir),
            partial: t.partial,
        };
        let mut last = None;
        let stdout = BufReader::new(child.stdout.take().expect("stdout is piped"));
        for line in stdout.split(b'\n') {
            let Ok(line) = line else { break };
            for ev in parser.parse(&line) {
                if ev.kind == "result" || ev.kind == "error" {
                    last = Some(ev);
                } else {
                    (self.emit)(&t.id, &ev);
                }
            }
        }
        let status = child.wait();
        drop(done);
        let _ = writer.join();
        let stderr = stderr_reader.join().unwrap_or_default();
        self.forget(&t.id, &run);

        if let Some(reason) = run.reason.get() {
            return Ok(error_event(reason.clone()));
        }
        Ok(match last {
            Some(ev) => {
                if ev.kind == "result" {
                    self.write_cache(t.cache.as_ref(), &ev);
                }
                ev
            }
            None => error_event(claude_failure(
                status.ok().filter(|s| !s.success()).map(|s| s.to_string()),
                &stderr,
            )),
        })
    }

    /// spawn checks the head out and starts claude in it, holding the lock so release cannot remove
    /// the worktree in between. A run with the same task id is stopped first.
    fn spawn(&self, t: &ClaudeTask) -> Result<(Arc<ClaudeRun>, std::process::Child)> {
        let bin = look_path("claude").ok_or_else(|| anyhow!("claude is not installed"))?;
        let mut state = self.state();
        let dir = self.worktree_locked(&mut state, &t.repo, &t.head)?;
        let child = Command::new(bin)
            .args(claude_args(t))
            .current_dir(&dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .map_err(|e| anyhow!("could not start claude: {e}"))?;
        let run = Arc::new(ClaudeRun {
            pid: child.id(),
            dir,
            reason: OnceLock::new(),
        });
        if let Some(old) = state.running.insert(t.id.clone(), Arc::clone(&run)) {
            old.stop("Stopped.");
        }
        Ok((run, child))
    }

    fn forget(&self, id: &str, run: &Arc<ClaudeRun>) {
        let mut state = self.state();
        if state.running.get(id).is_some_and(|r| Arc::ptr_eq(r, run)) {
            state.running.remove(id);
        }
    }

    /// cancel stops a running task. Its run ends with the error "Stopped.".
    pub fn cancel(&self, id: &str) {
        let run = self.state().running.remove(id);
        if let Some(run) = run {
            run.stop("Stopped.");
        }
    }

    /// release removes the repository's worktrees that no running task uses, when its review closes.
    pub fn release(&self, repo: &str) {
        let mut state = self.state();
        let busy: HashSet<PathBuf> = state.running.values().map(|r| r.dir.clone()).collect();
        state.worktrees.retain(|dir, owner| {
            let idle = owner == repo && !busy.contains(dir);
            if idle {
                remove_worktree(owner, dir);
            }
            !idle
        });
    }

    /// shutdown stops every task and removes every worktree, as the app quits.
    pub fn shutdown(&self) {
        let mut state = self.state();
        for (_, run) in state.running.drain() {
            run.stop("Stopped.");
        }
        for (dir, repo) in state.worktrees.drain() {
            remove_worktree(&repo, &dir);
        }
    }

    /// ensure_worktree returns a worktree of repo checked out at head, making it when needed.
    #[cfg(test)]
    fn ensure_worktree(&self, repo: &str, head: &str) -> Result<PathBuf> {
        let mut state = self.state();
        self.worktree_locked(&mut state, repo, head)
    }

    /// worktree_locked reuses the worktree at head when it is sound, and otherwise clears whatever a
    /// crash left there and checks it out again, so calling it any number of times ends the same way.
    /// The repository's hooks are off: this checkout is the app's, not the user's.
    fn worktree_locked(&self, state: &mut RunnerState, repo: &str, head: &str) -> Result<PathBuf> {
        let dir = self
            .tmp
            .join("git-tree-compare")
            .join(repo_hash(repo))
            .join(format!("worktree-{head}"));
        if !worktree_at(&dir, head) {
            remove_worktree(repo, &dir);
            std::fs::create_dir_all(dir.parent().expect("the worktree sits in a folder"))?;
            let dir_arg = dir.to_string_lossy();
            run_git(
                repo,
                &[
                    "-c",
                    "core.hooksPath=/dev/null",
                    "worktree",
                    "add",
                    "--detach",
                    &dir_arg,
                    head,
                ],
            )
            .map_err(|e| {
                anyhow!(
                    "could not check out {} for Claude: {e}",
                    head.get(..7).unwrap_or(head)
                )
            })?;
        }
        state.worktrees.insert(dir.clone(), repo.to_string());
        Ok(dir)
    }

    fn read_cache(&self, k: Option<&CacheKey>) -> Option<ClaudeEvent> {
        let body = std::fs::read(self.cache_dir.as_ref()?.join(k?.file())).ok()?;
        serde_json::from_slice::<ClaudeEvent>(&body)
            .ok()
            .filter(|ev| ev.kind == "result")
    }

    /// write_cache keeps a finished answer. It writes a temp file and renames it, so a crash never
    /// leaves half an answer. Failing to keep it costs only a later run.
    fn write_cache(&self, k: Option<&CacheKey>, ev: &ClaudeEvent) {
        let (Some(dir), Some(k)) = (&self.cache_dir, k) else {
            return;
        };
        let _ = (|| -> Result<()> {
            std::fs::create_dir_all(dir)?;
            let mut f = tempfile::Builder::new()
                .prefix(".answer-")
                .tempfile_in(dir)?;
            serde_json::to_writer(&mut f, ev)?;
            f.persist(dir.join(k.file()))?;
            Ok(())
        })();
    }
}

/// claude_failure says why claude ended without an answer, in its own words when it printed any.
fn claude_failure(exit: Option<String>, stderr: &str) -> String {
    match (stderr.trim(), exit) {
        (msg, _) if !msg.is_empty() => format!("Claude said: {}", last_line(msg)),
        (_, Some(exit)) => format!("Claude stopped: {exit}"),
        _ => "Claude stopped without an answer.".into(),
    }
}

/// folder_names is dir as given and with symlinks resolved; claude reports either.
fn folder_names(dir: &Path) -> Vec<PathBuf> {
    let mut names = vec![dir.to_path_buf()];
    names.extend(std::fs::canonicalize(dir).ok().filter(|real| real != dir));
    names
}

/// worktree_at reports whether dir is the top of a checkout at head.
fn worktree_at(dir: &Path, head: &str) -> bool {
    let Ok(out) = run_git(
        &dir.to_string_lossy(),
        &["rev-parse", "--show-toplevel", "HEAD"],
    ) else {
        return false;
    };
    match &split_lines(&out)[..] {
        [top, at] if at == head => {
            matches!((std::fs::canonicalize(top), std::fs::canonicalize(dir)), (Ok(a), Ok(b)) if a == b)
        }
        _ => false,
    }
}

/// remove_worktree removes a worktree and git's record of it, even when the folder is half gone.
fn remove_worktree(repo: &str, dir: &Path) {
    let _ = run_git(
        repo,
        &["worktree", "remove", "--force", &dir.to_string_lossy()],
    );
    let _ = std::fs::remove_dir_all(dir);
    let _ = run_git(repo, &["worktree", "prune"]);
}

#[cfg(test)]
pub mod testutil {
    use super::*;
    use crate::testbin::{fake_bin, FakeBin};

    pub const TEST_HEAD: &str = "0123456789abcdef0123456789abcdef01234567";

    pub fn test_task() -> ClaudeTask {
        ClaudeTask {
            id: "brief-1".into(),
            kind: "brief".into(),
            prompt: "--help me read this".into(),
            schema: r#"{"type":"object"}"#.into(),
            input: Box::new(|| Ok("the diff".into())),
            model: DEFAULT_CLAUDE_MODEL.into(),
            budget_usd: 2.0,
            tools: read_tools(),
            partial: false,
            session: Session::None,
            repo: "/r".into(),
            head: TEST_HEAD.into(),
            cache: None,
            refresh: false,
        }
    }

    /// fake_claude puts the stand-in claude on PATH, printing the fixture. It records its calls in
    /// <dir>/call.*; env sets more of its knobs (CLAUDE_HANG, CLAUDE_FAIL, CLAUDE_FIXTURE).
    pub fn fake_claude(fixture: &str, env: &str) -> FakeBin {
        let testdata = format!("{}/../testdata/claude", env!("CARGO_MANIFEST_DIR"));
        let script = std::fs::read_to_string(format!("{testdata}/fake-claude")).unwrap();
        let body = script.trim_start_matches("#!/bin/sh\n");
        fake_bin(
            "claude",
            &format!("CLAUDE_FIXTURE='{testdata}/{fixture}'\nCLAUDE_LOG=\"$(dirname \"$0\")/call\"\n{env}\n{body}"),
        )
    }

    /// Recorder collects what a runner emits.
    #[derive(Default, Clone)]
    pub struct Recorder(Arc<Mutex<Vec<ClaudeEvent>>>);

    impl Recorder {
        pub fn emit(&self) -> Emit {
            let events = Arc::clone(&self.0);
            Box::new(move |_, ev| events.lock().unwrap().push(ev.clone()))
        }

        pub fn all(&self) -> Vec<ClaudeEvent> {
            self.0.lock().unwrap().clone()
        }

        pub fn kinds(&self) -> String {
            self.all()
                .iter()
                .map(|e| e.kind.as_str())
                .collect::<Vec<_>>()
                .join(",")
        }
    }

    pub fn read_log(fake: &FakeBin, suffix: &str) -> String {
        std::fs::read_to_string(fake.log_path().with_file_name(format!("call.{suffix}")))
            .unwrap_or_default()
            .trim()
            .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;
    use crate::git::testutil::*;
    use std::time::Instant;

    #[test]
    fn args() {
        let want = [
            "-p",
            "--model",
            "claude-opus-5-5",
            "--tools",
            "Read",
            "Grep",
            "Glob",
            "--strict-mcp-config",
            "--restricted",
            "--safe-mode",
            "--output-format",
            "stream-json",
            "--verbose",
            "--max-budget-usd",
            "2.00",
            "--json-schema",
            r#"{"type":"object"}"#,
            "--no-session-persistence",
            "--",
            "--help me read this",
        ];
        assert_eq!(claude_args(&test_task()), want);
    }

    #[test]
    fn args_without_tools_with_partial_messages_and_sessions() {
        let id = "0b5e7c3a-1f2d-4e5f-8a9b-0c1d2e3f4a5b";
        let mut t = ClaudeTask {
            tools: vec![],
            schema: String::new(),
            partial: true,
            session: Session::Start(id.into()),
            ..test_task()
        };
        let got = claude_args(&t).join(" ");
        for part in [
            "--tools  --strict-mcp-config",
            "--include-partial-messages",
            &format!("--session-id {id} --"),
        ] {
            assert!(got.contains(part), "{got:?} lacks {part:?}");
        }
        assert!(!got.contains("--json-schema") && !got.contains("--no-session-persistence"));
        t.session = Session::Resume(id.into());
        assert!(claude_args(&t)
            .join(" ")
            .contains(&format!("--resume {id} --")));
    }

    #[test]
    fn validate_rejects_what_could_reach_claude_as_a_flag() {
        type Change = fn(&mut ClaudeTask);
        let cases: Vec<(&str, Change)> = vec![
            ("id with a slash", |t| t.id = "../x".into()),
            ("model as a flag", |t| {
                t.model = "--dangerously-skip-permissions".into()
            }),
            ("model with spaces", |t| t.model = "opus sonnet".into()),
            ("a tool that runs", |t| {
                t.tools = vec!["Read".into(), "Bash".into()]
            }),
            ("no budget", |t| t.budget_usd = 0.0),
            ("a session id flag", |t| {
                t.session = Session::Resume("--continue".into())
            }),
            ("short head", |t| t.head = "abc".into()),
        ];
        for (name, change) in cases {
            let mut t = test_task();
            change(&mut t);
            assert!(validate_task(&t).is_err(), "{name}: accepted");
        }
        validate_task(&test_task()).unwrap();
        let mut t = ClaudeTask {
            budget_usd: MAX_CLAUDE_BUDGET_USD,
            ..test_task()
        };
        validate_task(&t).unwrap();
        t.budget_usd = MAX_CLAUDE_BUDGET_USD + 0.01;
        assert!(validate_task(&t).is_err());
    }

    #[test]
    fn cache_key_changes_with_each_part() {
        let base = CacheKey {
            repo: "/r".into(),
            base: TEST_HEAD.into(),
            head: TEST_HEAD.into(),
            kind: "brief".into(),
            version: "v1".into(),
            model: "opus".into(),
            subject: "a.go".into(),
        };
        assert_eq!(base.file(), base.file());
        assert!(
            base.file().starts_with("brief-")
                && base.file().len() == "brief-".len() + 32 + ".json".len()
        );
        let changes: Vec<fn(&mut CacheKey)> = vec![
            |k| k.repo = "/s".into(),
            |k| k.base = "1".repeat(40),
            |k| k.head = "2".repeat(40),
            |k| k.kind = "findings".into(),
            |k| k.version = "v2".into(),
            |k| k.model = "sonnet".into(),
            |k| k.subject = "b.go".into(),
        ];
        for (i, change) in changes.into_iter().enumerate() {
            let mut k = base.clone();
            change(&mut k);
            assert_ne!(k.file(), base.file(), "change {i} kept the key");
        }
    }

    /// repo_task makes a repository with one commit and a task that runs at it.
    fn repo_task() -> (ClaudeTask, tempfile::TempDir) {
        let repo = new_repo();
        write_file(repo.path().join("limit.go"), "package main\n");
        git_in(repo.path(), &["add", "."]);
        git_in(repo.path(), &["commit", "-q", "-m", "first"]);
        let head = git_in(repo.path(), &["rev-parse", "HEAD"]);
        (
            ClaudeTask {
                repo: repo.path().to_str().unwrap().into(),
                head,
                ..test_task()
            },
            repo,
        )
    }

    fn task_like(t: &ClaudeTask) -> ClaudeTask {
        ClaudeTask {
            repo: t.repo.clone(),
            head: t.head.clone(),
            cache: t.cache.clone(),
            refresh: t.refresh,
            ..test_task()
        }
    }

    fn runner(rec: &Recorder, cache: Option<&Path>, tmp: &Path) -> ClaudeRunner {
        ClaudeRunner::new(rec.emit(), cache.map(Path::to_path_buf), tmp.to_path_buf())
    }

    #[test]
    fn runs_claude_in_a_worktree_at_head_and_caches_the_result() {
        let fake = fake_claude("brief.jsonl", "");
        let (mut task, _repo) = repo_task();
        task.cache = Some(CacheKey {
            repo: task.repo.clone(),
            base: task.head.clone(),
            head: task.head.clone(),
            kind: "brief".into(),
            version: "v1".into(),
            ..Default::default()
        });
        let (cache, tmp) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let rec = Recorder::default();
        let r = runner(&rec, Some(cache.path()), tmp.path());
        r.run(task_like(&task));
        let got = rec.all();
        assert_eq!(rec.kinds(), "tool,tool,result");
        assert_eq!(
            got[2].json.as_ref().unwrap().get(),
            r#"{"word":"banana","limit":42}"#
        );
        assert_eq!(read_log(&fake, "stdin"), "the diff");
        assert!(read_log(&fake, "args").ends_with("--\n--help me read this"));
        let wt = PathBuf::from(read_log(&fake, "pwd"));
        assert_eq!(git_in(&wt, &["rev-parse", "HEAD"]), task.head);
        assert!(wt.join("limit.go").exists());

        // The same task again is answered from the cache, without running claude.
        let rec2 = Recorder::default();
        runner(&rec2, Some(cache.path()), tmp.path()).run(task_like(&task));
        assert_eq!(rec2.all(), [got[2].clone()]);
        assert_eq!(read_log(&fake, "count"), "run");
    }

    #[test]
    fn refresh_skips_the_kept_answer_and_keeps_the_new_one() {
        let fake = fake_claude("brief.jsonl", "");
        let (mut task, _repo) = repo_task();
        task.cache = Some(CacheKey {
            repo: task.repo.clone(),
            head: task.head.clone(),
            kind: "brief".into(),
            version: "v1".into(),
            ..Default::default()
        });
        let (cache, tmp) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let rec = Recorder::default();
        let r = runner(&rec, Some(cache.path()), tmp.path());
        r.run(task_like(&task));
        task.refresh = true;
        r.run(task_like(&task));
        task.refresh = false;
        r.run(task_like(&task));
        assert_eq!(read_log(&fake, "count"), "run\nrun");
        assert_eq!(rec.kinds(), "tool,tool,result,tool,tool,result,result");
    }

    #[test]
    fn reuses_the_worktree_and_replaces_a_broken_one() {
        let (task, _repo) = repo_task();
        let tmp = tempfile::tempdir().unwrap();
        let r = runner(&Recorder::default(), None, tmp.path());
        let first = r.ensure_worktree(&task.repo, &task.head).unwrap();
        assert_eq!(r.ensure_worktree(&task.repo, &task.head).unwrap(), first);
        // A crash can leave a folder git no longer knows; it is replaced.
        std::fs::remove_dir_all(&first).unwrap();
        write_file(first.join("junk"), "x");
        assert_eq!(r.ensure_worktree(&task.repo, &task.head).unwrap(), first);
        assert!(first.join("limit.go").exists());
    }

    #[test]
    fn reports_what_claude_said_when_it_fails_without_a_result() {
        let _fake = fake_claude(
            "budget.jsonl",
            "CLAUDE_FIXTURE=/dev/null\nCLAUDE_FAIL='Invalid API key'",
        );
        let (task, _repo) = repo_task();
        let rec = Recorder::default();
        let tmp = tempfile::tempdir().unwrap();
        runner(&rec, None, tmp.path()).run(task);
        let got = rec.all();
        assert!(
            got.len() == 1 && got[0].kind == "error" && got[0].message.contains("Invalid API key"),
            "{got:?}"
        );
    }

    #[test]
    fn failure_says_why_claude_ended() {
        assert_eq!(
            claude_failure(
                Some("exit status: 1".into()),
                "warming up\nInvalid API key\n"
            ),
            "Claude said: Invalid API key"
        );
        assert_eq!(
            claude_failure(Some("exit status: 1".into()), " \n"),
            "Claude stopped: exit status: 1"
        );
        assert_eq!(
            claude_failure(None, ""),
            "Claude stopped without an answer."
        );
    }

    #[test]
    fn does_not_cache_a_failed_run() {
        let fake = fake_claude("budget.jsonl", "");
        let (mut task, _repo) = repo_task();
        task.cache = Some(CacheKey {
            repo: task.repo.clone(),
            head: task.head.clone(),
            kind: "brief".into(),
            version: "v1".into(),
            ..Default::default()
        });
        let (cache, tmp) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let rec = Recorder::default();
        let r = runner(&rec, Some(cache.path()), tmp.path());
        r.run(task_like(&task));
        r.run(task_like(&task));
        assert_eq!(read_log(&fake, "count"), "run\nrun");
        assert_eq!(rec.kinds(), "error,error");
    }

    #[test]
    fn cancel_kills_claude_and_what_it_started() {
        let fake = fake_claude("text.jsonl", "CLAUDE_HANG=1");
        let (task, _repo) = repo_task();
        let rec = Recorder::default();
        let tmp = tempfile::tempdir().unwrap();
        let r = Arc::new(runner(&rec, None, tmp.path()));
        let id = task.id.clone();
        let running = Arc::clone(&r);
        let done = std::thread::spawn(move || running.run(task));
        let deadline = Instant::now() + Duration::from_secs(10);
        let child = loop {
            let child = read_log(&fake, "child");
            if !child.is_empty() {
                break child;
            }
            assert!(Instant::now() < deadline, "claude never started its child");
            std::thread::sleep(Duration::from_millis(20));
        };
        r.cancel(&id);
        done.join().unwrap();
        assert_eq!(rec.all(), [error_event("Stopped.")]);
        let pid: libc::pid_t = child.parse().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        // SAFETY: signal 0 only checks that the process exists.
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(
                Instant::now() < deadline,
                "claude's child {pid} is still running"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn release_removes_idle_worktrees_and_shutdown_removes_all() {
        let (task, repo) = repo_task();
        let tmp = tempfile::tempdir().unwrap();
        let r = runner(&Recorder::default(), None, tmp.path());
        let wt = r.ensure_worktree(&task.repo, &task.head).unwrap();
        r.release(&task.repo);
        assert!(!wt.exists());
        let list = git_in(repo.path(), &["worktree", "list"]);
        assert!(
            !list.contains(wt.file_name().unwrap().to_str().unwrap()),
            "{list}"
        );

        let wt = r.ensure_worktree(&task.repo, &task.head).unwrap();
        r.shutdown();
        assert!(!wt.exists());
    }

    #[test]
    fn status_finds_claude_on_path() {
        let fake = fake_claude("text.jsonl", "");
        let got = claude_status();
        assert!(
            got.installed && got.version == "2.1.318" && got.default_model == DEFAULT_CLAUDE_MODEL,
            "{got:?}"
        );
        std::env::set_var("PATH", fake.dir().to_string() + "/none");
        assert!(!claude_status().installed);
    }
}
