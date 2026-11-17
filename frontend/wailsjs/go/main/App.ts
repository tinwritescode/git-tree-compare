// The backend's commands, as the Rust side in src-tauri/src/main.rs names them.
import {invoke} from '@tauri-apps/api/core';
import {listenersReady} from '../../runtime/runtime';
import type {main} from '../models';

// call runs a command once the event listeners asked for so far are live, so a command that answers
// through an event cannot beat its listener.
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    await listenersReady();
    return invoke<T>(cmd, args);
}

export const BranchPushState = (repo: string, branch: string, head: string) =>
    call<main.PushState>('branch_push_state', {repo, branch, head});
export const CancelClaude = (taskId: string) => call<void>('cancel_claude', {taskId});
export const Changes = (scope: main.Scope) => call<Array<main.FileChange>>('changes', {scope});
export const CheckUpdate = () => call<main.UpdateInfo>('check_update');
export const ClaudeStatus = () => call<main.ClaudeInfo>('claude_status');
export const CreatePR = (repo: string, req: main.PRCreateRequest) => call<string>('create_pr', {repo, req});
export const CurrentPRNumber = (repo: string) => call<number>('current_pr_number', {repo});
export const Diff = (scope: main.Scope, path: string) => call<string>('diff', {scope, path});
export const DiffAnchor = (path: string) => call<string>('diff_anchor', {path});
export const DiffSince = (scope: main.Scope, from: string, path: string, prUrl: string) =>
    call<main.SinceDiff>('diff_since', {scope, from, path, prUrl});
export const ExportPatch = (scope: main.Scope, name: string) => call<string>('export_patch', {scope, name});
export const FindClone = (slug: string, known: Array<string>) => call<string>('find_clone', {slug, known});
export const HomeDir = () => call<string>('home_dir');
export const InstallCLI = () => call<string>('install_cli');
export const InstallUpdate = () => call<void>('install_update');
export const InstalledEditors = () => call<Array<main.Editor>>('installed_editors');
export const ListDir = (path: string) => call<main.DirListing>('list_dir', {path});
export const ListLocal = (repo: string) => call<main.LocalSubjects>('list_local', {repo});
export const ListPRs = (repo: string) => call<Array<main.PRInfo>>('list_prs', {repo});
export const ListRefs = (repo: string) => call<main.RefList>('list_refs', {repo});
export const OpenAtHead = (repo: string, number: number, head: string, path: string, editor: string) =>
    call<void>('open_at_head', {repo, number, head, path, editor});
export const OpenInEditor = (repo: string, path: string, editor: string) =>
    call<void>('open_in_editor', {repo, path, editor});
export const PRChecks = (repo: string, number: number) => call<Array<main.Check>>('pr_checks', {repo, number});
export const PRComments = (repo: string, prId: string) => call<main.PRDiscussion>('pr_comments', {repo, prId});
export const PRViewedStates = (repo: string, prId: string) =>
    call<Record<string, string>>('pr_viewed_states', {repo, prId});
export const PrepareReview = (repo: string, pr: main.PRInfo) => call<main.ReviewTarget>('prepare_review', {repo, pr});
export const ReleaseClaude = (repo: string) => call<void>('release_claude', {repo});
export const ReplyToThread = (repo: string, threadId: string, body: string) =>
    call<void>('reply_to_thread', {repo, threadId, body});
export const ResizeTerminal = (cols: number, rows: number) => call<void>('resize_terminal', {cols, rows});
export const ResolveRepo = (path: string) => call<string>('resolve_repo', {path});
export const ReviewBranch = (repo: string, branch: string, base: string) =>
    call<main.LocalReview>('review_branch', {repo, branch, base});
export const ReviewCommit = (repo: string, rev: string) => call<main.LocalReview>('review_commit', {repo, rev});
export const RunCommand = (repo: string, command: string) => call<main.RunResult>('run_command', {repo, command});
export const SearchFiles = (repo: string, head: string, paths: Array<string>, query: main.SearchQuery) =>
    call<main.SearchResult>('search_files', {repo, head, paths, query});
export const SetThreadResolved = (repo: string, threadId: string, resolved: boolean) =>
    call<void>('set_thread_resolved', {repo, threadId, resolved});
export const SetViewed = (repo: string, prId: string, paths: Array<string>, viewed: boolean) =>
    call<void>('set_viewed', {repo, prId, paths, viewed});
export const StartAsk = (taskId: string, req: main.AskRequest) => call<void>('start_ask', {taskId, req});
export const StartBrief = (taskId: string, req: main.ChangeRef) => call<void>('start_brief', {taskId, req});
export const StartExplain = (taskId: string, req: main.ExplainRequest) => call<void>('start_explain', {taskId, req});
export const StartFindings = (taskId: string, req: main.ChangeRef) => call<void>('start_findings', {taskId, req});
export const StartPRDescription = (taskId: string, req: main.ChangeRef) =>
    call<void>('start_pr_description', {taskId, req});
export const StartPolish = (taskId: string, req: main.PolishRequest) => call<void>('start_polish', {taskId, req});
export const StartRereview = (taskId: string, req: main.RereviewRequest) =>
    call<void>('start_rereview', {taskId, req});
export const StartReviewSummary = (taskId: string, req: main.SummaryRequest) =>
    call<void>('start_review_summary', {taskId, req});
export const StartTerminal = (repo: string, cols: number, rows: number) =>
    call<void>('start_terminal', {repo, cols, rows});
export const StopTerminal = () => call<void>('stop_terminal');
export const SubmitReview = (repo: string, prUrl: string, submission: main.ReviewSubmission) =>
    call<void>('submit_review', {repo, prUrl, submission});
export const TakePendingRepo = () => call<main.OpenRequest | null>('take_pending_repo');
export const WriteTerminal = (data: string) => call<void>('write_terminal', {data});
export const LegacyStorage = () => call<Array<[string, string]>>('legacy_storage');
