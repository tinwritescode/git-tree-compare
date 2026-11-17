// No console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod checks;
mod claude;
mod claude_stream;
mod claude_tasks;
mod cli;
mod cli_install;
mod deeplink;
mod dirs;
mod editors;
mod files;
mod gh;
mod git;
mod headcopy;
mod legacy_storage;
mod localreview;
mod noise;
mod prcomments;
mod prcreate;
mod proc;
mod prsync;
mod review_submit;
mod run;
mod search;
mod shellpath;
mod since;
mod terminal;
#[cfg(test)]
mod testbin;
mod updates;

use base64::Engine;
use claude::{ClaudeRunner, ClaudeTask};
use claude_tasks::{
    AskRequest, ChangeRef, ExplainRequest, PolishRequest, RereviewRequest, SummaryRequest,
};
use cli::{parse_launch_args, Launch};
use deeplink::OpenLink;
use git::{FileChange, Scope};
use localreview::LocalReview;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;

// Event names sent to the frontend.
const EVENT_REPO_OPEN: &str = "repo:open";
const EVENT_REPO_ERROR: &str = "repo:error";
/// base64 of the bytes the shell wrote
const EVENT_TERM_DATA: &str = "term:data";
const EVENT_TERM_EXIT: &str = "term:exit";

/// CmdError is how a command fails: the frontend gets the error and its causes as one message.
struct CmdError(anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for CmdError {
    fn from(e: E) -> Self {
        CmdError(e.into())
    }
}

impl Serialize for CmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("{:#}", self.0))
    }
}

type Res<T> = Result<T, CmdError>;

/// OpenRequest asks the frontend to show a repository, or reports why it could not.
/// Review is set when the command line asked for a commit or a branch. Link is set instead of Repo
/// when a URL asked for a pull request: only the frontend knows which repositories were opened before.
#[derive(Serialize, Clone, Default)]
struct OpenRequest {
    repo: String,
    error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    review: Option<LocalReview>,
    #[serde(skip_serializing_if = "Option::is_none")]
    link: Option<OpenLink>,
}

struct AppState {
    /// the last request, kept until the frontend takes it
    pending: Mutex<Option<OpenRequest>>,
    claude: Arc<ClaudeRunner>,
}

/// request_open resolves the launch path to its repository root, and any commit or branch in it,
/// and tells the frontend to show them.
fn request_open(app: &AppHandle, l: &Launch) {
    let req = git::resolve_repo(&l.path).and_then(|root| {
        Ok(OpenRequest {
            review: localreview::launch_review(&root, l)?,
            repo: root,
            ..Default::default()
        })
    });
    publish(
        app,
        req.unwrap_or_else(|e| OpenRequest {
            error: format!("{e:#}"),
            ..Default::default()
        }),
    );
}

/// on_url handles a git-tree-compare:// link, which macOS delivers to the running app or starts it with.
fn on_url(app: &AppHandle, raw: &str) {
    publish(
        app,
        match deeplink::parse_open_url(raw) {
            Ok(link) => OpenRequest {
                link: Some(link),
                ..Default::default()
            },
            Err(e) => OpenRequest {
                error: format!("{e:#}"),
                ..Default::default()
            },
        },
    );
    show_window(app);
}

/// publish stores the request, so a frontend that is not listening yet can take it later, and sends it.
fn publish(app: &AppHandle, req: OpenRequest) {
    *app.state::<AppState>()
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(req.clone());
    let _ = if req.error.is_empty() {
        app.emit(EVENT_REPO_OPEN, req)
    } else {
        app.emit(EVENT_REPO_ERROR, req.error)
    };
}

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// Commands. Each runs off the main thread (async), as most of them run git or gh.

/// take_pending_repo returns and clears the last open request; the frontend calls it on mount.
#[tauri::command]
async fn take_pending_repo(state: State<'_, AppState>) -> Res<Option<OpenRequest>> {
    Ok(state
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take())
}

#[tauri::command]
async fn home_dir() -> Res<String> {
    let home = std::env::home_dir().ok_or_else(|| anyhow::anyhow!("no home folder"))?;
    Ok(home.to_string_lossy().into_owned())
}

#[tauri::command]
async fn list_dir(path: String) -> Res<dirs::DirListing> {
    Ok(dirs::list_dir(&path)?)
}

#[tauri::command]
async fn resolve_repo(path: String) -> Res<String> {
    Ok(git::resolve_repo(&path)?)
}

#[tauri::command]
async fn find_clone(slug: String, known: Vec<String>) -> Res<String> {
    Ok(deeplink::find_clone(&slug, &known))
}

#[tauri::command]
async fn list_prs(repo: String) -> Res<Vec<gh::PRInfo>> {
    Ok(gh::list_prs(&repo)?)
}

#[tauri::command]
async fn current_pr_number(repo: String) -> Res<i64> {
    Ok(gh::current_pr_number(&repo))
}

#[tauri::command]
async fn prepare_review(repo: String, pr: gh::PRInfo) -> Res<gh::ReviewTarget> {
    Ok(gh::prepare_review(&repo, &pr)?)
}

#[tauri::command]
async fn review_commit(repo: String, rev: String) -> Res<LocalReview> {
    Ok(localreview::review_commit(&repo, &rev)?)
}

#[tauri::command]
async fn review_branch(repo: String, branch: String, base: String) -> Res<LocalReview> {
    Ok(localreview::review_branch(&repo, &branch, &base)?)
}

#[tauri::command]
async fn list_refs(repo: String) -> Res<localreview::RefList> {
    Ok(localreview::list_refs(&repo)?)
}

#[tauri::command]
async fn list_local(repo: String) -> Res<localreview::LocalSubjects> {
    Ok(localreview::list_local(&repo))
}

#[tauri::command]
async fn pr_viewed_states(repo: String, pr_id: String) -> Res<HashMap<String, String>> {
    Ok(prsync::pr_viewed_states(&repo, &pr_id)?)
}

#[tauri::command]
async fn set_viewed(repo: String, pr_id: String, paths: Vec<String>, viewed: bool) -> Res<()> {
    Ok(prsync::set_viewed(&repo, &pr_id, &paths, viewed)?)
}

#[tauri::command]
async fn pr_comments(repo: String, pr_id: String) -> Res<prcomments::PRDiscussion> {
    Ok(prcomments::pr_comments(&repo, &pr_id)?)
}

#[tauri::command]
async fn submit_review(
    repo: String,
    pr_url: String,
    submission: review_submit::ReviewSubmission,
) -> Res<()> {
    Ok(review_submit::submit_review(&repo, &pr_url, &submission)?)
}

#[tauri::command]
async fn reply_to_thread(repo: String, thread_id: String, body: String) -> Res<()> {
    Ok(prcomments::reply_to_thread(&repo, &thread_id, &body)?)
}

#[tauri::command]
async fn set_thread_resolved(repo: String, thread_id: String, resolved: bool) -> Res<()> {
    Ok(prcomments::set_thread_resolved(
        &repo, &thread_id, resolved,
    )?)
}

#[tauri::command]
async fn branch_push_state(repo: String, branch: String, head: String) -> Res<prcreate::PushState> {
    Ok(prcreate::branch_push_state(&repo, &branch, &head))
}

#[tauri::command]
async fn create_pr(repo: String, req: prcreate::PRCreateRequest) -> Res<String> {
    Ok(prcreate::create_pr(&repo, &req)?)
}

/// export_patch writes the review's diff to a .patch file the user chooses. name, such as "pr-12",
/// goes into the suggested file name. It returns the saved path, or "" when the dialog was cancelled.
#[tauri::command]
async fn export_patch(app: AppHandle, scope: Scope, name: String) -> Res<String> {
    let out = git::scope_diff(&scope, &[], "")?;
    let repo_name = std::path::Path::new(&scope.repo)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    let chosen = app
        .dialog()
        .file()
        .set_file_name(format!("{repo_name}-{name}.patch"))
        .add_filter("Patch", &["patch"])
        .blocking_save_file();
    let Some(path) = chosen else {
        return Ok(String::new());
    };
    let path = path.into_path()?;
    std::fs::write(&path, out)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn check_update() -> Res<updates::UpdateInfo> {
    Ok(updates::check_update()?)
}

/// install_update downloads the latest release, replaces this app with it, and relaunches. The app
/// quits on success, so the caller gets an error only when nothing was changed.
#[tauri::command]
async fn install_update(app: AppHandle) -> Res<()> {
    let app_path = updates::app_bundle_path()?;
    let release = updates::fetch_latest_release()?;
    updates::install_release(&release, &app_path)?;
    updates::relaunch_after_quit(&app_path)
        .map_err(|e| e.context("the update is installed, but the app could not restart"))?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
async fn install_cli() -> Res<String> {
    Ok(cli_install::install_cli()?.to_string_lossy().into_owned())
}

#[tauri::command]
async fn changes(scope: Scope) -> Res<Vec<FileChange>> {
    Ok(git::changed_files(&scope)?)
}

#[tauri::command]
async fn diff(scope: Scope, path: String) -> Res<String> {
    Ok(git::file_diff(&scope, &path)?)
}

#[tauri::command]
async fn diff_since(
    scope: Scope,
    from: String,
    path: String,
    pr_url: String,
) -> Res<since::SinceDiff> {
    Ok(since::diff_since(&scope, &from, &path, &pr_url)?)
}

#[tauri::command]
async fn run_command(repo: String, command: String) -> Res<run::RunResult> {
    Ok(run::run_command(&repo, &command))
}

#[tauri::command]
async fn search_files(
    repo: String,
    head: String,
    paths: Vec<String>,
    query: search::SearchQuery,
) -> Res<search::SearchResult> {
    Ok(search::search_files(&repo, &head, &paths, &query)?)
}

#[tauri::command]
async fn diff_anchor(path: String) -> Res<String> {
    Ok(files::diff_anchor(&path))
}

#[tauri::command]
async fn installed_editors() -> Res<Vec<editors::Editor>> {
    Ok(editors::installed_editors())
}

#[tauri::command]
async fn open_in_editor(repo: String, path: String, editor: String) -> Res<()> {
    Ok(editors::open_in_editor(&repo, &path, &editor)?)
}

#[tauri::command]
async fn open_at_head(
    repo: String,
    number: i64,
    head: String,
    path: String,
    editor: String,
) -> Res<()> {
    Ok(headcopy::open_at_head(
        &repo, number, &head, &path, &editor,
    )?)
}

#[tauri::command]
async fn pr_checks(repo: String, number: i64) -> Res<Vec<checks::Check>> {
    Ok(checks::pr_checks(&repo, number)?)
}

/// open_url opens a web page in the default browser. Only https pages: the frontend links to GitHub.
#[tauri::command]
async fn open_url(url: String) -> Res<()> {
    let parsed = url::Url::parse(&url)?;
    if parsed.scheme() != "https" {
        return Err(anyhow::anyhow!("{url:?} is not an https link").into());
    }
    let status = std::process::Command::new("open")
        .arg(parsed.as_str())
        .status()?;
    if !status.success() {
        return Err(anyhow::anyhow!("open {status}").into());
    }
    Ok(())
}

/// legacy_storage returns what the Wails build kept in localStorage, for the frontend to copy once.
#[tauri::command]
async fn legacy_storage() -> Res<Vec<(String, String)>> {
    Ok(legacy_storage::legacy_items())
}

#[tauri::command]
async fn claude_status() -> Res<claude::ClaudeInfo> {
    Ok(claude::claude_status())
}

/// start_claude starts a task a builder made, or returns why the builder refused. Its progress
/// arrives as claude:<taskId> events, ending with one result or one error.
fn start_claude(state: &AppState, task: anyhow::Result<ClaudeTask>) -> Res<()> {
    Ok(state.claude.start(task?)?)
}

#[tauri::command]
async fn start_brief(state: State<'_, AppState>, task_id: String, req: ChangeRef) -> Res<()> {
    start_claude(&state, claude_tasks::brief_task(&task_id, req))
}

#[tauri::command]
async fn start_explain(
    state: State<'_, AppState>,
    task_id: String,
    req: ExplainRequest,
) -> Res<()> {
    start_claude(&state, claude_tasks::explain_task(&task_id, req))
}

#[tauri::command]
async fn start_ask(state: State<'_, AppState>, task_id: String, req: AskRequest) -> Res<()> {
    start_claude(&state, claude_tasks::ask_task(&task_id, req))
}

#[tauri::command]
async fn start_findings(state: State<'_, AppState>, task_id: String, req: ChangeRef) -> Res<()> {
    start_claude(&state, claude_tasks::findings_task(&task_id, req))
}

#[tauri::command]
async fn start_rereview(
    state: State<'_, AppState>,
    task_id: String,
    req: RereviewRequest,
) -> Res<()> {
    start_claude(&state, claude_tasks::rereview_task(&task_id, req))
}

#[tauri::command]
async fn start_polish(state: State<'_, AppState>, task_id: String, req: PolishRequest) -> Res<()> {
    start_claude(&state, claude_tasks::polish_task(&task_id, req))
}

#[tauri::command]
async fn start_review_summary(
    state: State<'_, AppState>,
    task_id: String,
    req: SummaryRequest,
) -> Res<()> {
    start_claude(&state, claude_tasks::summary_task(&task_id, req))
}

#[tauri::command]
async fn start_pr_description(
    state: State<'_, AppState>,
    task_id: String,
    req: ChangeRef,
) -> Res<()> {
    start_claude(&state, claude_tasks::pr_description_task(&task_id, req))
}

#[tauri::command]
async fn cancel_claude(state: State<'_, AppState>, task_id: String) -> Res<()> {
    state.claude.cancel(&task_id);
    Ok(())
}

/// release_claude removes the checkouts Claude read for a repository, once its review closes.
#[tauri::command]
async fn release_claude(state: State<'_, AppState>, repo: String) -> Res<()> {
    state.claude.release(&repo);
    Ok(())
}

/// start_terminal starts a login shell in repo. Output arrives as term:data events; its exit as term:exit.
#[tauri::command]
async fn start_terminal(app: AppHandle, repo: String, cols: u16, rows: u16) -> Res<()> {
    Ok(terminal::start(&repo, (cols, rows), move |ev| {
        let _ = match ev {
            terminal::TermEvent::Data(bytes) => app.emit(
                EVENT_TERM_DATA,
                base64::engine::general_purpose::STANDARD.encode(bytes),
            ),
            terminal::TermEvent::Exit => app.emit(EVENT_TERM_EXIT, ()),
        };
    })?)
}

#[tauri::command]
async fn write_terminal(data: String) -> Res<()> {
    Ok(terminal::write(&data)?)
}

#[tauri::command]
async fn resize_terminal(cols: u16, rows: u16) -> Res<()> {
    Ok(terminal::resize(cols, rows)?)
}

#[tauri::command]
async fn stop_terminal() -> Res<()> {
    terminal::stop();
    Ok(())
}

fn main() {
    // Before any thread starts: it sets PATH for the whole process.
    shellpath::load_login_path();
    // The CLI wrapper passes a repository path, and maybe a commit or branch in it.
    let args: Vec<String> = std::env::args().skip(1).collect();
    let launch = parse_launch_args(&args);

    let app = tauri::Builder::default()
        // A second launch with a path hands it to this window and exits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let l = parse_launch_args(argv.get(1..).unwrap_or_default());
            if !l.path.is_empty() {
                request_open(app, &l);
            }
            show_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let handle = app.handle().clone();
            let emit_handle = handle.clone();
            let emit = Box::new(move |task_id: &str, ev: &claude_stream::ClaudeEvent| {
                let _ = emit_handle.emit(&format!("{}{task_id}", claude::EVENT_CLAUDE_PREFIX), ev);
            });
            let runner = ClaudeRunner::new(emit, claude::claude_cache_dir(), std::env::temp_dir());
            app.manage(AppState {
                pending: Mutex::default(),
                claude: Arc::new(runner),
            });

            let url_handle = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    on_url(&url_handle, url.as_str());
                }
            });
            std::thread::spawn(cli_install::refresh_installed_cli);
            if !launch.path.is_empty() {
                request_open(&handle, &launch);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            take_pending_repo,
            home_dir,
            list_dir,
            resolve_repo,
            find_clone,
            list_prs,
            current_pr_number,
            prepare_review,
            review_commit,
            review_branch,
            list_refs,
            list_local,
            pr_viewed_states,
            set_viewed,
            pr_comments,
            submit_review,
            reply_to_thread,
            set_thread_resolved,
            branch_push_state,
            create_pr,
            export_patch,
            check_update,
            install_update,
            install_cli,
            changes,
            diff,
            diff_since,
            run_command,
            search_files,
            diff_anchor,
            installed_editors,
            open_in_editor,
            open_at_head,
            pr_checks,
            open_url,
            legacy_storage,
            claude_status,
            start_brief,
            start_explain,
            start_ask,
            start_findings,
            start_rereview,
            start_polish,
            start_review_summary,
            start_pr_description,
            cancel_claude,
            release_claude,
            start_terminal,
            write_terminal,
            resize_terminal,
            stop_terminal,
        ])
        .build(tauri::generate_context!())
        .expect("the app's config is built into the binary");

    app.run(|app, event| {
        // As the app quits: Claude and the shell stop, and Claude's worktrees are removed.
        if let RunEvent::Exit = event {
            app.state::<AppState>().claude.shutdown();
            terminal::stop();
        }
    });
}
