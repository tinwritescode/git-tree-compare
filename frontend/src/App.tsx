import {Fragment, memo, type MouseEvent as ReactMouseEvent, type ReactNode, type Ref, type RefObject, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {useVirtualizer} from '@tanstack/react-virtual';
import './App.css';
import {
    BranchPushState,
    CancelClaude,
    Changes,
    CheckUpdate,
    ClaudeStatus,
    CreatePR,
    CurrentPRNumber,
    FindClone,
    Diff,
    DiffAnchor,
    DiffSince,
    ExportPatch,
    InstallCLI,
    InstallUpdate,
    InstalledEditors,
    ListLocal,
    ListPRs,
    OpenAtHead,
    OpenInEditor,
    PRComments,
    PRViewedStates,
    PrepareReview,
    ReleaseClaude,
    ReplyToThread,
    ResolveRepo,
    ReviewBranch,
    ReviewCommit,
    SetThreadResolved,
    SetViewed,
    StartAsk,
    StartBrief,
    StartExplain,
    StartFindings,
    StartPolish,
    StartPRDescription,
    StartRereview,
    StartReviewSummary,
    SubmitReview,
    TakePendingRepo,
} from '../wailsjs/go/main/App';
import {BrowserOpenURL, EventsOn} from '../wailsjs/runtime/runtime';
import {BriefCard, type SinceNote} from './brief';
import {
    briefChip, type BriefRun, briefRunStep, briefState, CLAUDE_TASKS, type ClaudeEvent, type ClaudeModels, type ClaudeTaskKind, modelChoices, modelFor,
    parseClaudeEvent, parseClaudeModels, parsePRDescription, parseRepoList, type PRDescription, type RiskMark, riskMarks, TASK_LABEL,
} from './claude';
import {FindingCard, type FindingControls, ThreadCheckView} from './claude-review';
import {acceptFinding, type Commentable, type Finding, nextFinding, parseFindings, parseSettled, shownFindings, whyQuestion} from './findings';
import {parseRereview, sinceRanges, type ThreadCheck, threadTexts} from './rereview';
import {type PushCheck} from './selfreview';
import {askKey, askTurn, type Conversation, conversationStep, emptyConversation, startTurn, type Turn, turnStep} from './claude-chat';
import {ClaudePanel} from './claude-panel';
import {diffRows, type DiffRow, hunkFor, hunkOfRow, parseDiff, type Line, type SplitRow} from './diff';
import {highlight} from './highlight';
import {emptyQuery, SearchDialog, type SearchHit, type SearchQuery} from './search-dialog';
import {paint, type Token} from './syntax';
import {EditorMenu} from './editor-menu';
import {Command, CommandPalette, CommandPanel, CommentBody, CommentsPanel, FileMenu, PRDiscussion, PRThread, QuickOpen, ThreadActions, type ThreadControls, UpdateBanner} from './panels';
import {
    addDraft, checkLineTarget, commentableLines, type Composer, deleteDraft, type Draft, draftCounts, editDraft, focusFor, parseDrafts, removeDrafts, rowTargets,
    type Side, staleNote, toReviewDrafts, type Typing, typedFor, type Verdict, withoutTyped, withTyped,
} from './drafts';
import {type DraftControls, DraftStack, FinishSheet, type Polisher} from './finish';
import {type InboxRow, type LocalWork} from './inbox';
import {PR, PRList, ReviewRuler} from './prs';
import {RefPicker, type RefMode} from './ref-picker';
import {
    applyServerStates, emptyRecord, isChangedSinceReview, isReviewed, nextBatch, nextUnreviewed, progressText, ReviewRecord, settleBatch,
    toggleReviewed,
} from './review';
import {
    diffRange, type DiffMode, type DiffRange, fallbackNote, loadDiff, parseReviewedHeads, recordReviewedHeads, type ReviewedHeads, type ShownDiff, sinceHead,
} from './since';
import {buildTree, FileChange, SortMode, TreeNode} from './tree';
import {groupByState, NOISE_LABEL, noiseOf, type NoiseReason, parseTreeViews, SECTION_TITLE, type Section, type SectionKind, type TreeViews} from './triage';
import {main} from '../wailsjs/go/models';
import {basename, buildMarkdown, dropOldest, folderOf, newUUID} from './util';
import {Button} from './ui/button';
import {Kbd} from './ui/kbd';
import {RepoPicker} from './repo-picker';
import {Landing} from './landing';
import {OwlHop, OwlSearch, OwlTray, Snail} from './mascots';
import {TerminalPanel} from './terminal';

const PR_POLL_MS = 60000;
const DIFF_CACHE_SIZE = 40; // files whose diff text is kept while a pull request is open

// Remembered state is a convenience, so every access is guarded.
// UPDATE_DISMISSED_KEY holds the release the user chose to skip.
const UPDATE_DISMISSED_KEY = 'git-tree-compare:update-dismissed';
const RECENT_KEY = 'git-tree-compare:recent';
const RECENT_LIMIT = 8;
const TREE_VIEW_KEY = 'git-tree-compare:treeView';
const NO_AI_KEY = 'git-tree-compare:noAI'; // repositories the user turned AI off for
const CLAUDE_MODELS_KEY = 'git-tree-compare:claudeModels'; // the model per kind of Claude task

function readStore<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
        return fallback;
    }
}

function writeStore(key: string, value: unknown) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Storage can be unavailable; the app works without it.
    }
}

const reviewKey = (repo: string, number: number) => `git-tree-compare:review:${repo}#${number}`;
// The head each file of a pull request was marked reviewed at, for "Since my review".
const reviewedAtKey = (repo: string, number: number) => `git-tree-compare:reviewedAt:${repo}#${number}`;
const localReviewKey = (repo: string, r: main.LocalReview) => `git-tree-compare:review:${repo}@${r.base}..${r.head}`;

// The draft comments of a review are saved next to its record, so they survive a restart.
const draftsKeyOf = (reviewStoreKey: string) => `${reviewStoreKey}:drafts`;

// What the reviewer accepted or dismissed of Claude's findings, per review and head (askKey).
const settledKey = (reviewHeadKey: string) => `git-tree-compare:findings:${reviewHeadKey}`;

// newDraftId names a draft so it can be edited, deleted, and dropped once posted.
function newDraftId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// A diff line chosen with a click, where c drafts a line comment.
type LineFocus = {path: string; side: Side; line: number};

type OpenRequest = {repo?: string; error?: string; review?: main.LocalReview; link?: main.OpenLink};

// The Claude panel on the right: an explanation of one hunk, or the review's Ask conversation.
type ClaudePanelState = {kind: 'explain'; turn: Turn} | {kind: 'ask'};

// runClaude listens to a task's events, then starts it, and stops listening once it ends.
// A task that fails to start ends with an error event.
function runClaude({taskId, start, onEvent}: {taskId: string; start: () => Promise<void>; onEvent: (event: ClaudeEvent) => void}): () => void {
    const off = EventsOn(`claude:${taskId}`, (payload: unknown) => {
        const event = parseClaudeEvent(payload);
        if (!event) return;
        onEvent(event);
        if (event.kind === 'result' || event.kind === 'error') off();
    });
    start().catch(e => {
        off();
        onEvent({kind: 'error', message: String(e)});
    });
    return off;
}

// claudeAnswer runs a task the reviewer asked for and resolves with its answer, or rejects with why it failed.
function claudeAnswer({taskId, start}: {taskId: string; start: () => Promise<void>}): Promise<{json: unknown; text: string}> {
    return new Promise((resolve, reject) => {
        runClaude({
            taskId, start, onEvent: event => {
                if (event.kind === 'result') resolve(event);
                else if (event.kind === 'error') reject(new Error(event.message));
            },
        });
    });
}

// What is under review: an open pull request, or a commit or branch read from git alone.
type Subject = {kind: 'pr'; number: number} | {kind: 'local'; review: main.LocalReview};

function App() {
    const [repo, setRepo] = useState(() => readStore('git-tree-compare:last', {repo: ''}).repo);
    const [landing, setLanding] = useState(true); // the start screen, until a repository opens
    const [prs, setPrs] = useState<PR[]>([]);
    const [prsLoading, setPrsLoading] = useState(false);
    const [prsError, setPrsError] = useState('');
    const [prsRead, setPrsRead] = useState(false); // the list has been read from GitHub for this repository
    const [localWork, setLocalWork] = useState<LocalWork | null>(null); // the inbox's checked-out branch and recent commits
    const [subject, setSubject] = useState<Subject | null>(null);
    // A review the command line or a link asked for.
    const [launch, setLaunch] = useState<{kind: 'local'; review: main.LocalReview} | {kind: 'pr'; number: number} | null>(null);
    const [refMode, setRefMode] = useState<RefMode | null>(null); // the commit or branch picker, while open
    const [target, setTarget] = useState<main.ReviewTarget | null>(null);
    const [pollTick, setPollTick] = useState(0);
    const [record, setRecord] = useState<ReviewRecord>(emptyRecord);
    const [reviewedHeads, setReviewedHeads] = useState<ReviewedHeads>({});
    const [syncError, setSyncError] = useState('');
    const [helpOpen, setHelpOpen] = useState(false);
    const [termOpen, setTermOpen] = useState(false);
    const [termStarted, setTermStarted] = useState(false); // the shell starts the first time the dock opens
    const [picked, setPicked] = useState<string[]>([]); // multi-selection, in tree order; empty means just `selected`
    const pickedSet = useMemo(() => new Set(picked), [picked]);
    const [menu, setMenu] = useState<{x: number; y: number; path: string} | null>(null);
    const [ignoreWS, setIgnoreWS] = useState(() => readStore('git-tree-compare:ignoreWS', false));
    const [changes, setChanges] = useState<FileChange[]>([]);
    const [selected, setSelected] = useState<FileChange | null>(null);
    const [diff, setDiff] = useState('');
    const [diffPath, setDiffPath] = useState(''); // the file the diff text belongs to, which lags a new pick
    const [diffNote, setDiffNote] = useState(''); // why the diff shows the whole pull request when asked for less
    const [diffMode, setDiffMode] = useState<DiffMode>('whole'); // whole pull request, or since my review where there is one
    const [filter, setFilter] = useState('');
    const [sort, setSort] = useState<SortMode>(() => readStore<SortMode>('git-tree-compare:sort', 'name'));
    const [split, setSplit] = useState(() => readStore('git-tree-compare:split', false));
    const [fullFile, setFullFile] = useState(() => readStore('git-tree-compare:fullFile', false));
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    // The folder tree or the "By state" sections, chosen per kind of review.
    const [treeViews, setTreeViews] = useState<TreeViews>(() => parseTreeViews(readStore<unknown>(TREE_VIEW_KEY, null)));
    const [closedSections, setClosedSections] = useState<Set<SectionKind>>(() => new Set(['reviewed', 'folded']));
    const [notes, setNotes] = useState<Record<string, string>>({});
    const [noteOpen, setNoteOpen] = useState(false);
    const [prFileURL, setPrFileURL] = useState(''); // this file's diff on the open pull request
    const [editors, setEditors] = useState<main.Editor[]>([]); // editors installed on this machine
    const [editorID, setEditorID] = useState(() => readStore('git-tree-compare:editor', ''));
    const [discussion, setDiscussion] = useState<PRDiscussion | null>(null); // review comments on the open PR
    const [commentsOpen, setCommentsOpen] = useState(false);
    const [commentsLoading, setCommentsLoading] = useState(false);
    const [drafts, setDrafts] = useState<Draft[]>([]); // the pending review, posted when the review is finished
    const [focusLine, setFocusLine] = useState<LineFocus | null>(null);
    const [composer, setComposer] = useState<Composer | null>(null);
    const [finishOpen, setFinishOpen] = useState(false);
    const [verdict, setVerdict] = useState<Verdict>('COMMENT');
    const [summary, setSummary] = useState(''); // the Finish sheet's summary, kept while the sheet is closed
    const [update, setUpdate] = useState<main.UpdateInfo | null>(null); // a newer release, if one exists
    const [installing, setInstalling] = useState(false);
    const [quickOpen, setQuickOpen] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState<SearchQuery>(emptyQuery); // kept until the pull request closes
    // A line to scroll to and flash once its file's diff is drawn, set by a search pick.
    const [jump, setJump] = useState<{path: string; side: Side; line: number; id: number} | null>(null);
    // A file shown whole for one visit because a search hit sat outside its diff. The saved setting is untouched.
    const [tempFull, setTempFull] = useState<string | null>(null);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [paletteMode, setPaletteMode] = useState<'commands' | 'model'>('commands'); // ⌘K lists commands, or Claude models
    const [claudeInfo, setClaudeInfo] = useState<main.ClaudeInfo | null>(null); // null until known, and AI stays hidden
    const [noAIRepos, setNoAIRepos] = useState<string[]>(() => parseRepoList(readStore<unknown>(NO_AI_KEY, [])));
    const [claudeModels, setClaudeModels] = useState<ClaudeModels>(() => parseClaudeModels(readStore<unknown>(CLAUDE_MODELS_KEY, {})));
    const [briefRun, setBriefRun] = useState<BriefRun>({kind: 'off'});
    const [briefOpen, setBriefOpen] = useState(true);
    const [briefRerun, setBriefRerun] = useState<{head: string; n: number} | null>(null); // a head whose brief skips the kept one
    const [findingsRun, setFindingsRun] = useState<BriefRun>({kind: 'off'}); // runs like the brief, once it is done
    // Which lines of each file with findings take a comment, read for the scope they belong to.
    const [findingLines, setFindingLines] = useState<{scope: typeof scope; lines: Commentable}>({scope: null, lines: {}});
    const [settled, setSettled] = useState<string[]>([]); // keys of findings accepted or dismissed at this head
    const [focusedFinding, setFocusedFinding] = useState<string | null>(null);
    const [rereviewRun, setRereviewRun] = useState<BriefRun>({kind: 'off'}); // since your review, for a pull request pushed to after it
    const [askPrefill, setAskPrefill] = useState<{text: string; id: number} | null>(null);
    const [prDraft, setPrDraft] = useState<PRDescription & {drafted: boolean}>({title: '', body: '', drafted: false}); // a branch's pull request, before it is created
    const [pushCheck, setPushCheck] = useState<PushCheck>({kind: 'checking'});
    const [claudePanel, setClaudePanel] = useState<ClaudePanelState | null>(null);
    // Ask conversations by askKey, kept while the app runs, so a review opened again carries on.
    const [conversations, setConversations] = useState<Record<string, Conversation>>({});
    const [picking, setPicking] = useState(false);
    const [recent, setRecent] = useState<string[]>(() => readStore<string[]>(RECENT_KEY, []));
    const [pickError, setPickError] = useState('');
    const [cmdOpen, setCmdOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [flash, setFlash] = useState('');

    // Values read inside effects and handlers, without re-running them.
    const recordRef = useRef<ReviewRecord>(emptyRecord);
    const draftsRef = useRef<{key: string; drafts: Draft[]} | null>(null); // the open review's drafts, and where they are saved
    const typing = useRef<Typing>({}); // what draft editors hold, kept while their diff row is scrolled away
    const owner = useRef<{repo: string; id: string; key: string} | null>(null); // whose review recordRef holds
    const flushing = useRef(false); // one writer to GitHub at a time, so toggles land in order
    const writes = useRef(0); // counts accepted writes, to drop reads that started before them
    const filterInput = useRef<HTMLInputElement>(null);
    const diffView = useRef<DiffHandle>(null);
    const diffCache = useRef<{scope: typeof scope; texts: Map<string, ShownDiff>}>({scope: null, texts: new Map()});
    const seenHead = useRef<{number: number; head: string} | null>(null);

    const openNumber = subject?.kind === 'pr' ? subject.number : null;
    const pr = useMemo(() => prs.find(p => p.number === openNumber) ?? null, [prs, openNumber]);
    const local = subject?.kind === 'local' ? subject.review : null;
    const reviewing = pr !== null || local !== null;
    // The two commits being compared: a local review carries them, a pull request is fetched first.
    const commits = local ?? target;
    const scope = useMemo(
        () => (commits ? {repo, base: commits.base, head: commits.head, ignoreWS} : null),
        [repo, commits?.base, commits?.head, ignoreWS],
    );

    const visibleChanges = useMemo(() => {
        const q = filter.trim().toLowerCase();
        return q ? changes.filter(c => c.path.toLowerCase().includes(q)) : changes;
    }, [changes, filter]);
    const tree = useMemo(() => buildTree(visibleChanges, sort), [visibleChanges, sort]);
    const treeView = subject ? treeViews[subject.kind] : 'folders';
    // Claude runs when it is installed and not turned off here. The brief is for pull requests and branches.
    const aiOn = !!claudeInfo?.installed && !noAIRepos.includes(repo);
    const briefModel = modelFor({models: claudeModels, kind: 'brief', fallback: claudeInfo?.defaultModel ?? ''});
    const findingsModel = modelFor({models: claudeModels, kind: 'findings', fallback: claudeInfo?.defaultModel ?? ''});
    const rereviewModel = modelFor({models: claudeModels, kind: 'rereview', fallback: claudeInfo?.defaultModel ?? ''});
    const briefWanted = aiOn && (pr !== null || local?.kind === 'branch');
    const conversationKey = commits ? askKey({repo, pr: pr?.number ?? null, base: commits.base, head: commits.head}) : null;
    const conversation = (conversationKey && conversations[conversationKey]) || emptyConversation;
    const changedPaths = useMemo(() => new Set(changes.map(c => c.path)), [changes]);
    const brief = useMemo(() => briefState({run: briefRun, paths: changedPaths}), [briefRun, changedPaths]);
    const shownBrief = brief.kind === 'ready' ? brief.brief : null;
    const risks = useMemo<Record<string, RiskMark>>(() => (shownBrief ? riskMarks(shownBrief) : {}), [shownBrief]);
    // Findings and the re-review start once the brief is done, so they do not compete with it.
    const briefDone = briefRun.kind === 'answered' || briefRun.kind === 'error';
    // Null when Claude's answer is not a list of findings.
    const parsedFindings = useMemo(
        () => (findingsRun.kind === 'answered' ? parseFindings({value: findingsRun.json, paths: changedPaths}) : []),
        [findingsRun, changedPaths],
    );
    const allFindings = useMemo(() => parsedFindings ?? [], [parsedFindings]);
    const settledSet = useMemo(() => new Set(settled), [settled]);
    const findings = useMemo(
        () => shownFindings({findings: allFindings, commentable: findingLines.scope === scope ? findingLines.lines : {}, settled: settledSet}),
        [allFindings, findingLines, scope, settledSet],
    );
    // Claude's read on each open thread, once a push landed after the reviewer's review.
    const rereview = useMemo(() => {
        if (rereviewRun.kind !== 'answered') return null;
        const threadIds = new Set((discussion?.threads ?? []).map(t => t.id).filter(Boolean));
        return parseRereview({value: rereviewRun.json, threadIds});
    }, [rereviewRun, discussion]);
    const threadChecks = useMemo<Readonly<Record<string, ThreadCheck>>>(() => rereview?.threads ?? {}, [rereview]);
    const sinceNote: SinceNote | null = rereviewRun.kind === 'running' ? {kind: 'running'}
        : rereviewRun.kind === 'error' ? {kind: 'error', message: rereviewRun.message}
        : rereviewRun.kind === 'answered' ? (rereview ? {kind: 'ready', summary: rereview.summary} : {kind: 'error', message: 'Claude answered, but not with a summary.'})
        : null;
    const sections = useMemo(
        () => groupByState({files: visibleChanges, record, chapters: shownBrief?.chapters ?? []}),
        [visibleChanges, record, shownBrief],
    );
    // The files in the order on screen, skipping closed folders and sections, so arrow keys and x follow what is shown.
    const files = useMemo(
        () => (treeView === 'state'
            ? sections.filter(s => !closedSections.has(s.kind)).flatMap(s => s.files)
            : flattenFiles(tree, collapsed)),
        [treeView, sections, closedSections, tree, collapsed],
    );
    // The ruler shows every file, closed sections included, in the same order.
    const rulerFiles = useMemo(() => (treeView === 'state' ? sections.flatMap(s => s.files) : files), [treeView, sections, files]);
    const reviewed = useMemo(
        () => Object.fromEntries(changes.filter(c => isReviewed(record, c.path)).map(c => [c.path, 'reviewed'])),
        [changes, record],
    );
    const changedSinceReview = useMemo(
        () => new Set(changes.filter(c => isChangedSinceReview(record, c.path)).map(c => c.path)),
        [changes, record],
    );
    const unsynced = useMemo(() => new Set(syncError ? Object.keys(record.pending) : []), [syncError, record]);
    // Open review threads per file, shown as a count on the tree row.
    const commentCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const t of discussion?.threads ?? []) {
            if (!t.resolved) counts[t.path] = (counts[t.path] ?? 0) + 1;
        }
        return counts;
    }, [discussion]);
    const unresolvedCount = Object.values(commentCounts).reduce((sum, n) => sum + n, 0);
    const draftCountByPath = useMemo(() => draftCounts(drafts), [drafts]);
    const fileDrafts = useMemo(() => (selected ? drafts.filter(d => d.path === selected.path) : []), [drafts, selected]);
    const fileFindings = useMemo(() => (selected ? findings.filter(f => f.path === selected.path) : []), [findings, selected]);
    // y and d act on the focused finding while its file is on screen.
    const focusedOnScreen = fileFindings.find(f => f.key === focusedFinding) ?? null;
    const draftLabel = pr ? 'Draft · posts when you finish' : 'Draft · goes in the summary';
    const updateBanner = update && (
        <UpdateBanner
            update={update}
            installing={installing}
            onInstall={installUpdate}
            onOpen={() => BrowserOpenURL(update.url)}
            onLater={dismissUpdate}
        />
    );
    // Review threads on the selected file, shown inline in its diff.
    const fileThreads = useMemo(
        () => (selected ? (discussion?.threads ?? []).filter(t => t.path === selected.path) : []),
        [discussion, selected],
    );
    const reviewedCount = Object.keys(reviewed).length;
    // The head the selected file was reviewed at, when a push changed it since. Only pull requests move.
    const sinceFrom = pr && selected && commits
        ? sinceHead({record, heads: reviewedHeads, path: selected.path, head: commits.head})
        : null;
    const range = useMemo(() => diffRange({mode: diffMode, from: sinceFrom}), [diffMode, sinceFrom]);
    const prURL = pr?.url; // where DiffSince fetches a reviewed commit the clone lacks
    // The menu acts on the whole selection when the right-clicked file is part of it.
    const menuPaths = menu ? (pickedSet.has(menu.path) ? picked : [menu.path]) : [];
    const menuAllReviewed = menuPaths.length > 0 && menuPaths.every(p => reviewed[p]);

    function showFlash(message: string) {
        setFlash(message);
        setTimeout(() => setFlash(''), 2500);
    }

    function commitRecord(next: ReviewRecord) {
        recordRef.current = next;
        setRecord(next);
        if (owner.current) writeStore(owner.current.key, next);
    }

    // Sends pending marks to GitHub, one batch at a time. A failure stops here and keeps them
    // pending; the next poll tries again. A pull request closed mid-way keeps its own queue on disk.
    async function flushReview() {
        const writer = owner.current;
        if (flushing.current || !writer) return;
        flushing.current = true;
        try {
            for (;;) {
                const batch = owner.current === writer ? nextBatch(recordRef.current) : null;
                if (!batch) break;
                await SetViewed(writer.repo, writer.id, batch.paths, batch.viewed);
                writes.current++;
                if (owner.current === writer) commitRecord(settleBatch(recordRef.current, batch));
            }
            setSyncError('');
        } catch (e) {
            setSyncError(String(e));
        } finally {
            flushing.current = false;
        }
    }

    // Marks one file or a selection, on screen now and on GitHub right after.
    function toggleFiles(paths: string[]) {
        if (!paths.length) return;
        const {record: toggled, viewed} = toggleReviewed(recordRef.current, paths);
        // A commit or branch has no pull request to tell, so its mark is settled as soon as it is made.
        const next = pr ? toggled : settleBatch(toggled, {paths, viewed});
        commitRecord(next);
        if (pr && commits) {
            const heads = recordReviewedHeads({heads: reviewedHeads, paths, viewed, head: commits.head});
            setReviewedHeads(heads);
            writeStore(reviewedAtKey(repo, pr.number), heads);
        }
        if (pr) flushReview();
        if (viewed && paths.length === 1 && paths[0] === selected?.path) {
            const following = nextUnreviewed(files, next, paths[0]);
            if (following) setSelected(following);
        }
    }

    function updateNote(path: string, text: string) {
        const next = {...notes};
        if (text.trim()) next[path] = text;
        else delete next[path];
        setNotes(next);
        writeStore(`git-tree-compare:notes:${repo}`, next);
    }

    // changeDrafts applies change to the drafts saved under key and saves the result. The open
    // review's drafts are read from memory, so they are kept even when storage is unavailable.
    function changeDrafts(key: string, change: (drafts: Draft[]) => Draft[]) {
        const open = draftsRef.current?.key === key;
        const next = change(open && draftsRef.current ? draftsRef.current.drafts : parseDrafts(readStore<unknown>(key, null)));
        writeStore(key, next);
        if (open) {
            draftsRef.current = {key, drafts: next};
            setDrafts(next);
        }
    }

    // c: a comment on the focused line, or on the file when no line of it is focused.
    function startComment() {
        if (!selected) return;
        const path = selected.path;
        if (focusLine?.path !== path) {
            setComposer({kind: 'file', path});
            return;
        }
        if (pr) {
            const lines = parseDiff(diffPath === path ? diff : '');
            const check = checkLineTarget({lines, range: range.kind, side: focusLine.side, line: focusLine.line});
            if (check.kind === 'invalid') {
                showFlash(check.reason);
                return;
            }
        }
        setComposer({kind: 'line', path, side: focusLine.side, line: focusLine.line});
    }

    function saveComposer(body: string) {
        const key = draftsRef.current?.key;
        if (!key || !composer) return;
        const c = composer;
        const head = commits?.head ?? null;
        switch (c.kind) {
            case 'line':
                changeDrafts(key, d => addDraft(d, {kind: 'line', id: newDraftId(), path: c.path, line: c.line, side: c.side, body, head}));
                break;
            case 'file':
                changeDrafts(key, d => addDraft(d, {kind: 'file', id: newDraftId(), path: c.path, body, head}));
                break;
            case 'edit':
                changeDrafts(key, d => editDraft(d, {id: c.id, body}));
                break;
            default: {
                const _exhaustive: never = c;
                return _exhaustive;
            }
        }
        closeComposer();
    }

    // Closes the draft editor and forgets what it held.
    function closeComposer() {
        if (composer) typing.current = withoutTyped(typing.current, composer);
        setComposer(null);
    }

    function removeDraft(id: string) {
        const key = draftsRef.current?.key;
        if (key) changeDrafts(key, d => deleteDraft(d, id));
        typing.current = withoutTyped(typing.current, {kind: 'edit', id});
        setComposer(c => (c?.kind === 'edit' && c.id === id ? null : c));
    }

    // Moves the file's note into the pending review as a file comment.
    function addNoteToReview(path: string) {
        const key = draftsRef.current?.key;
        const note = notes[path]?.trim();
        if (!key || !note) return;
        changeDrafts(key, d => addDraft(d, {kind: 'file', id: newDraftId(), path, body: note, head: commits?.head ?? null}));
        updateNote(path, '');
        setNoteOpen(false);
        showFlash(pr ? 'The note is now a draft comment. It posts when you finish.' : 'The note is now a draft comment.');
    }

    // Posts the verdict, summary and every draft in one request. Drafts go only once GitHub has
    // them; a failure throws to the Finish sheet, which shows it and keeps everything.
    async function submitReview() {
        const owned = draftsRef.current;
        if (!pr || !commits || !owned) return;
        const posted = owned.drafts;
        await SubmitReview(repo, pr.url, main.ReviewSubmission.createFrom({
            head: commits.head, event: verdict, body: summary, drafts: toReviewDrafts(posted),
        }));
        changeDrafts(owned.key, d => removeDrafts(d, posted.map(p => p.id)));
        setSummary('');
        setVerdict('COMMENT');
        setFinishOpen(false);
        showFlash(`Review posted on #${pr.number}.`);
        loadComments();
    }

    async function replyToThread(id: string, body: string) {
        await ReplyToThread(repo, id, body);
        await loadComments();
    }

    async function resolveThread(id: string, resolved: boolean) {
        await SetThreadResolved(repo, id, resolved);
        await loadComments();
    }

    // The diff view is memoised, so it gets stable controls that call the latest handlers.
    const latest = useRef({
        replyToThread, resolveThread, saveComposer, closeComposer, removeDraft, composer, selectedPath: selected?.path,
        acceptFindingAsDraft, dismissFinding, askWhy, polishDraft,
    });
    latest.current = {
        replyToThread, resolveThread, saveComposer, closeComposer, removeDraft, composer, selectedPath: selected?.path,
        acceptFindingAsDraft, dismissFinding, askWhy, polishDraft,
    };
    const threadControls = useMemo<ThreadControls>(() => ({
        reply: (id, body) => latest.current.replyToThread(id, body),
        resolve: (id, resolved) => latest.current.resolveThread(id, resolved),
    }), []);
    const draftControls = useMemo<DraftControls>(() => ({
        save: body => latest.current.saveComposer(body),
        cancel: () => latest.current.closeComposer(),
        typed: saved => {
            const c = latest.current.composer;
            return c ? typedFor(typing.current, {composer: c, saved}) : saved;
        },
        type: body => {
            const c = latest.current.composer;
            if (c) typing.current = withTyped(typing.current, {composer: c, body});
        },
        edit: id => setComposer({kind: 'edit', id}),
        remove: id => latest.current.removeDraft(id),
        polish: aiOn ? (req => latest.current.polishDraft(req)) satisfies Polisher : null,
    }), [aiOn]);
    const findingControls = useMemo<FindingControls>(() => ({
        focus: key => setFocusedFinding(key),
        accept: key => latest.current.acceptFindingAsDraft(key),
        dismiss: key => latest.current.dismissFinding(key),
        why: key => latest.current.askWhy(key),
    }), []);
    const focusAt = useCallback((target: {side: Side; line: number}) => {
        const path = latest.current.selectedPath;
        if (path) setFocusLine({path, ...target});
    }, []);

    // Ctrl+` shows or hides the terminal dock. It is captured before the terminal or inputs see the key.
    useEffect(() => {
        function onToggle(e: KeyboardEvent) {
            if (!e.ctrlKey || e.key !== '`') return;
            e.preventDefault();
            e.stopPropagation();
            setTermOpen(v => !v);
        }
        window.addEventListener('keydown', onToggle, true);
        return () => window.removeEventListener('keydown', onToggle, true);
    }, []);

    useEffect(() => {
        if (termOpen) setTermStarted(true);
    }, [termOpen]);

    // Requests from the command line or a link: first launch (pending) and later launches (event).
    useEffect(() => {
        function openLink({slug, pr: number}: main.OpenLink) {
            FindClone(slug, readStore<string[]>(RECENT_KEY, []))
                .then(found => {
                    if (!found) {
                        setPickError(`No clone of ${slug} found near your recent repositories. Open it here once, then use the link again.`);
                        setPicking(true);
                        return;
                    }
                    setRepo(found);
                    setLanding(false);
                    setPicking(false);
                    setLaunch({kind: 'pr', number});
                })
                .catch(e => setError(String(e)));
        }
        function apply(req: OpenRequest | null) {
            if (!req) return;
            if (req.error) setError(req.error);
            if (req.repo) {
                setRepo(req.repo);
                setLanding(false);
            }
            if (req.review) setLaunch({kind: 'local', review: req.review});
            if (req.link) openLink(req.link);
        }
        TakePendingRepo().then(apply).catch(() => {});
        const off = EventsOn('repo:open', (req: OpenRequest) => apply(req));
        const offError = EventsOn('repo:error', (msg: string) => setError(msg));
        return () => {
            off();
            offError();
        };
    }, []);

    function chooseRepo() {
        setPickError('');
        setPicking(true);
    }

    // openRepo resolves any path inside a repository to its root and shows it.
    async function openRepo(path: string) {
        setPickError('');
        try {
            setRepo(await ResolveRepo(path));
            setPicking(false);
            setLanding(false);
        } catch (e) {
            setPickError(String(e));
        }
    }

    useEffect(() => {
        if (tempFull && selected?.path !== tempFull) setTempFull(null);
    }, [selected, tempFull]);

    // A draft being written belongs to the file on screen.
    useEffect(() => {
        setComposer(null);
    }, [selected?.path]);

    // Stable across renders, so the diff does not redraw when unrelated state changes.
    const selectedPath = selected?.path;
    const showWholeFile = useCallback(() => {
        if (selectedPath) setTempFull(selectedPath);
    }, [selectedPath]);

    // Searching covers the changed files that still exist at the pull request's head.
    const searchPaths = useMemo(() => changes.filter(c => c.status !== 'D').map(c => c.path), [changes]);

    function openSearchHit(hit: SearchHit) {
        const file = changes.find(c => c.path === hit.path);
        if (!file) return;
        setSearchOpen(false);
        setSelected(file);
        setJump({path: hit.path, side: 'RIGHT', line: hit.line, id: Date.now()});
    }

    function closeReview() {
        closeClaudePanel();
        setSubject(null);
        setTarget(null);
        setSearchQuery(emptyQuery);
        setSearchOpen(false);
        setCommentsOpen(false);
        setFinishOpen(false);
        setCmdOpen(false);
        setPicked([]);
        setFilter('');
    }

    // Per-repo state. When the checked-out branch has an open pull request, it opens directly.
    useEffect(() => {
        if (!repo) return;
        let cancelled = false;
        closeReview();
        setPrs([]);
        setPrsRead(false);
        setLocalWork(null);
        setCollapsed(new Set(readStore<string[]>(`git-tree-compare:collapsed:${repo}`, [])));
        setNotes(readStore<Record<string, string>>(`git-tree-compare:notes:${repo}`, {}));
        CurrentPRNumber(repo)
            .then(number => {
                if (!cancelled && number) setSubject(s => s ?? {kind: 'pr', number});
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [repo]);

    // Opens a commit, branch or pull request. It runs after the per-repo reset above, so a request
    // that also switched the repository is not wiped by it.
    useEffect(() => {
        if (!launch) return;
        if (launch.kind === 'local') {
            openLocal(launch.review);
            return;
        }
        closeReview();
        setSubject({kind: 'pr', number: launch.number});
    }, [launch]);

    function openLocal(review: main.LocalReview) {
        closeReview();
        setSubject({kind: 'local', review});
    }

    // Opens an inbox row: a pull request, or a local review of the branch or commit.
    function openRow(row: InboxRow) {
        switch (row.kind) {
            case 'pr':
                setSubject({kind: 'pr', number: row.pr.number});
                return;
            case 'branch':
                ReviewBranch(repo, row.branch.name, '').then(openLocal).catch(e => setError(String(e)));
                return;
            case 'commit':
                ReviewCommit(repo, row.commit.hash).then(openLocal).catch(e => setError(String(e)));
                return;
            default: {
                const _exhaustive: never = row;
                return _exhaustive;
            }
        }
    }

    function toggleTreeView() {
        if (!subject) return;
        const kind = subject.kind;
        setTreeViews(views => ({...views, [kind]: views[kind] === 'state' ? 'folders' : 'state'}));
    }

    function toggleSection(kind: SectionKind) {
        setClosedSections(prev => {
            const next = new Set(prev);
            if (next.has(kind)) next.delete(kind);
            else next.add(kind);
            return next;
        });
    }

    // The open pull requests, refreshed every minute while the window is in front.
    useEffect(() => {
        if (!repo) return;
        let cancelled = false;
        setPrsLoading(true);
        ListPRs(repo)
            .then(list => {
                if (cancelled) return;
                setPrs(list);
                setPrsError('');
                setPrsRead(true);
            })
            .catch(e => !cancelled && setPrsError(String(e)))
            .finally(() => !cancelled && setPrsLoading(false));
        return () => {
            cancelled = true;
        };
    }, [repo, pollTick]);

    // Local work for the inbox, read with the pull requests. It needs no GitHub.
    useEffect(() => {
        if (!repo) return;
        let cancelled = false;
        ListLocal(repo).then(found => !cancelled && setLocalWork(found)).catch(() => !cancelled && setLocalWork(null));
        return () => {
            cancelled = true;
        };
    }, [repo, pollTick]);

    useEffect(() => {
        const timer = setInterval(() => {
            if (!document.hidden) setPollTick(t => t + 1);
        }, PR_POLL_MS);
        return () => clearInterval(timer);
    }, []);

    // A pull request that was merged or closed leaves the list, so the review ends.
    useEffect(() => {
        if (!prsRead || openNumber === null || pr) return;
        showFlash(`Pull request #${openNumber} is no longer open.`);
        closeReview();
    }, [prsRead, openNumber, pr]);

    // Checks GitHub for a newer release once at launch. Offline or without gh, it stays quiet.
    useEffect(() => {
        CheckUpdate()
            .then(info => {
                if (info.available && info.latest !== readStore<string>(UPDATE_DISMISSED_KEY, '')) setUpdate(info);
            })
            .catch(() => {});
    }, []);

    // The review record of the open pull request: last known states and marks still to send.
    useEffect(() => {
        const next = pr ? {repo, id: pr.id, key: reviewKey(repo, pr.number)}
            : local ? {repo, id: '', key: localReviewKey(repo, local)}
            : null;
        owner.current = next;
        const saved = next ? readStore<ReviewRecord>(next.key, emptyRecord) : emptyRecord;
        recordRef.current = saved;
        setRecord(saved);
        setReviewedHeads(pr ? parseReviewedHeads(readStore<unknown>(reviewedAtKey(repo, pr.number), null)) : {});
        setSyncError('');
        const savedDrafts = next ? {key: draftsKeyOf(next.key), drafts: parseDrafts(readStore<unknown>(draftsKeyOf(next.key), null))} : null;
        draftsRef.current = savedDrafts;
        setDrafts(savedDrafts?.drafts ?? []);
        typing.current = {};
        setComposer(null);
        setFocusLine(null);
        setSummary('');
        setVerdict('COMMENT');
        setPrDraft({title: '', body: '', drafted: false});
    }, [repo, pr?.id, local?.base, local?.head]);

    // What GitHub says is viewed, on open and on every poll. Marks made here still wait their turn,
    // and a failed send is retried here. A read that started before a write is stale, so it is dropped.
    useEffect(() => {
        if (!pr) return;
        let cancelled = false;
        const version = writes.current;
        PRViewedStates(repo, pr.id)
            .then(states => {
                if (!cancelled && version === writes.current) commitRecord(applyServerStates(recordRef.current, states));
            })
            .catch(() => {})
            .finally(() => {
                if (!cancelled) flushReview();
            });
        return () => {
            cancelled = true;
        };
    }, [repo, pr?.id, pr?.headRefOid, pollTick]);

    // Fetches the pull request, again whenever new commits land on it.
    useEffect(() => {
        if (!pr) {
            seenHead.current = null;
            return;
        }
        let cancelled = false;
        const seen = seenHead.current;
        if (seen?.number === pr.number && seen.head !== pr.headRefOid) {
            showFlash(`New commits on #${pr.number}. The diff is up to date.`);
        }
        seenHead.current = {number: pr.number, head: pr.headRefOid};
        setLoading(true);
        PrepareReview(repo, pr)
            .then(found => {
                if (!cancelled) setTarget(found);
            })
            .catch(e => {
                if (cancelled) return;
                setError(`Could not fetch pull request #${pr.number}: ${e}`);
                setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [repo, pr?.number, pr?.headRefOid]);

    // Review comments, so the header can show how many are still open.
    useEffect(() => {
        if (!pr) {
            setDiscussion(null);
            return;
        }
        PRComments(repo, pr.id).then(setDiscussion).catch(() => setDiscussion(null));
    }, [repo, pr?.id]);

    // Reload changed files when the commits or the whitespace option change. Keep the
    // selection if the file is still part of the pull request, otherwise select the first file on screen (below).
    useEffect(() => {
        if (!scope) {
            setChanges([]);
            setSelected(null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        Changes(scope)
            .then(list => {
                if (cancelled) return;
                setChanges(list);
                setError('');
                setSelected(prev => list.find(f => f.path === prev?.path) ?? null);
            })
            .catch(e => !cancelled && setError(String(e)))
            .finally(() => !cancelled && setLoading(false));
        return () => {
            cancelled = true;
        };
    }, [scope]);

    // Whether claude is installed decides whether any AI shows. Asked once, at launch.
    useEffect(() => {
        ClaudeStatus().then(setClaudeInfo).catch(() => setClaudeInfo(null));
    }, []);

    // The brief of the open pull request or branch, written in the background as soon as it opens,
    // and again when new commits land. Closing the review stops it and removes Claude's checkout.
    useEffect(() => {
        if (!briefWanted || !commits) {
            setBriefRun({kind: 'off'});
            return;
        }
        const id = `brief-${newDraftId()}`;
        setBriefRun({kind: 'running', reading: null});
        const off = runClaude({
            taskId: id,
            start: () => StartBrief(id, changeRef({kind: 'brief', commits, fresh: briefRerun?.head === commits.head})),
            onEvent: event => setBriefRun(run => briefRunStep(run, event)),
        });
        return () => {
            off();
            CancelClaude(id).finally(() => ReleaseClaude(repo)).catch(() => {});
        };
    }, [briefWanted, repo, commits?.base, commits?.head, pr?.number, briefModel, briefRerun]);

    // Findings, once the brief is done, for the same pull request or branch. A re-run of the brief
    // asks for them again too.
    useEffect(() => {
        if (!briefWanted || !commits || !briefDone) {
            setFindingsRun({kind: 'off'});
            return;
        }
        const id = `findings-${newDraftId()}`;
        setFindingsRun({kind: 'running', reading: null});
        const off = runClaude({
            taskId: id,
            start: () => StartFindings(id, changeRef({kind: 'findings', commits, fresh: briefRerun?.head === commits.head})),
            onEvent: event => setFindingsRun(run => briefRunStep(run, event)),
        });
        return () => {
            off();
            CancelClaude(id).catch(() => {});
        };
    }, [briefWanted, briefDone, repo, commits?.base, commits?.head, pr?.number, findingsModel, briefRerun]);

    // Which lines take a comment in each file with findings: a finding elsewhere is dropped.
    useEffect(() => {
        if (!scope) return;
        const known = findingLines.scope === scope ? findingLines.lines : {};
        const missing = [...new Set(allFindings.map(f => f.path))].filter(path => !(path in known));
        if (!missing.length) return;
        let cancelled = false;
        Promise.all(missing.map(path => Diff({...scope, fullFile: false}, path)
            .then(text => [path, commentableLines(parseDiff(text))] as const)
            .catch(() => [path, {RIGHT: new Set<number>(), LEFT: new Set<number>()}] as const)))
            .then(found => {
                if (cancelled) return;
                setFindingLines(prev => ({scope, lines: {...(prev.scope === scope ? prev.lines : {}), ...Object.fromEntries(found)}}));
            });
        return () => {
            cancelled = true;
        };
    }, [scope, allFindings]);

    // The findings settled at this head, saved so they stay settled after a restart.
    useEffect(() => {
        setSettled(conversationKey ? parseSettled(readStore<unknown>(settledKey(conversationKey), [])) : []);
        setFocusedFinding(null);
    }, [conversationKey]);

    // Since your review: once the brief is done, when a push changed files the reviewer had
    // reviewed. It reads the ranges and threads as they are when it starts, and keeps its answer for
    // this head as the reviewer marks those files again.
    const rereviewInput = useRef<{since: {path: string; from: string}[]; threads: main.ThreadText[]}>({since: [], threads: []});
    rereviewInput.current = {
        since: pr && commits ? sinceRanges({paths: changes.map(c => c.path), record, heads: reviewedHeads, head: commits.head}) : [],
        threads: threadTexts(discussion?.threads ?? []),
    };
    const hasSince = rereviewInput.current.since.length > 0;
    const discussionRead = discussion !== null;
    useEffect(() => {
        if (!aiOn || !pr || !commits || !briefDone || !discussionRead) {
            setRereviewRun({kind: 'off'});
            return;
        }
        if (!hasSince) return;
        const {since, threads} = rereviewInput.current;
        const id = `rereview-${newDraftId()}`;
        setRereviewRun({kind: 'running', reading: null});
        const off = runClaude({
            taskId: id,
            start: () => StartRereview(id, main.RereviewRequest.createFrom({
                change: changeRef({kind: 'rereview', commits, fresh: briefRerun?.head === commits.head}), prUrl: pr.url, since, threads,
            })),
            onEvent: event => setRereviewRun(run => briefRunStep(run, event)),
        });
        return () => {
            off();
            CancelClaude(id).catch(() => {});
            setRereviewRun(run => (run.kind === 'running' ? {kind: 'off'} : run));
        };
    }, [aiOn, pr?.number, commits?.base, commits?.head, briefDone, discussionRead, hasSince, rereviewModel, briefRerun]);

    // Whether origin has the branch's reviewed commits, checked as the Finish sheet opens on a branch.
    useEffect(() => {
        if (!finishOpen || !local?.branch) return;
        let cancelled = false;
        setPushCheck({kind: 'checking'});
        BranchPushState(repo, local.branch, local.head)
            .then(state => !cancelled && setPushCheck(state.pushed ? {kind: 'pushed'} : {kind: 'not-pushed', message: state.message}))
            .catch(e => !cancelled && setPushCheck({kind: 'not-pushed', message: String(e)}));
        return () => {
            cancelled = true;
        };
    }, [finishOpen, repo, local?.branch, local?.head]);

    // With nothing selected, the first file in the order on screen opens, before the frame is drawn.
    useLayoutEffect(() => {
        if (!selected) setSelected(files[0] ?? rulerFiles[0] ?? changes[0] ?? null);
    }, [selected, files, rulerFiles, changes]);

    useEffect(() => {
        writeStore('git-tree-compare:last', {repo});
        if (!repo) return;
        setRecent(prev => {
            const next = [repo, ...prev.filter(r => r !== repo)].slice(0, RECENT_LIMIT);
            writeStore(RECENT_KEY, next);
            return next;
        });
    }, [repo]);

    useEffect(() => writeStore('git-tree-compare:sort', sort), [sort]);
    useEffect(() => writeStore('git-tree-compare:split', split), [split]);
    useEffect(() => writeStore('git-tree-compare:fullFile', fullFile), [fullFile]);
    useEffect(() => writeStore('git-tree-compare:ignoreWS', ignoreWS), [ignoreWS]);
    useEffect(() => writeStore(TREE_VIEW_KEY, treeViews), [treeViews]);
    useEffect(() => writeStore(NO_AI_KEY, noAIRepos), [noAIRepos]);
    useEffect(() => writeStore(CLAUDE_MODELS_KEY, claudeModels), [claudeModels]);

    useEffect(() => {
        if (!selected || !scope) {
            setDiff('');
            return;
        }
        let cancelled = false;
        setNoteOpen(false);
        const whole = fullFile || tempFull === selected.path;
        // A diff between two commits never changes, so a file opened again in this scope draws at once.
        if (diffCache.current.scope !== scope) diffCache.current = {scope, texts: new Map()};
        const texts = diffCache.current.texts;
        const path = selected.path;
        const key = `${range.kind === 'since' ? range.from : 'pr'}:${whole ? 'whole' : 'changes'}:${path}`;
        const show = (shown: ShownDiff) => {
            setDiff(shown.text);
            setDiffNote(shown.fallback ? fallbackNote(shown.fallback) : '');
            setDiffPath(path);
        };
        const cached = texts.get(key);
        if (cached !== undefined) {
            show(cached);
            return;
        }
        const fileScope = {...scope, fullFile: whole};
        loadDiff({
            range,
            whole: () => Diff(fileScope, path),
            since: from => DiffSince(fileScope, from, path, prURL ?? ''),
        })
            .then(shown => {
                // A failed read may work next time; a commit that is gone stays gone.
                if (shown.fallback?.kind !== 'error') texts.set(key, shown);
                dropOldest(texts, DIFF_CACHE_SIZE);
                if (!cancelled) show(shown);
            })
            .catch(e => !cancelled && setError(String(e)));
        return () => {
            cancelled = true;
        };
    }, [selected, scope, fullFile, tempFull, range, prURL]);

    useEffect(() => {
        InstalledEditors().then(list => setEditors(list ?? [])).catch(() => setEditors([]));
    }, []);

    useEffect(() => writeStore('git-tree-compare:editor', editorID), [editorID]);

    // Link to this file's diff on the open pull request.
    useEffect(() => {
        if (!pr || !selected) {
            setPrFileURL('');
            return;
        }
        let cancelled = false;
        DiffAnchor(selected.path)
            .then(anchor => !cancelled && setPrFileURL(`${pr.url}/files#diff-${anchor}`))
            .catch(() => !cancelled && setPrFileURL(''));
        return () => {
            cancelled = true;
        };
    }, [pr, selected?.path]);

    // Keyboard: open dialogs, then move between files, filter, review, notes and the rest.
    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (picking || landing || refMode) return;
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                setPaletteOpen(open => !open);
                setPaletteMode('commands');
                return;
            }
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
                e.preventDefault();
                if (reviewing) setSearchOpen(open => !open);
                return;
            }
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
                e.preventDefault();
                if (reviewing) setQuickOpen(open => !open);
                return;
            }
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                // Inside the Finish sheet or a text box, ⌘↵ is theirs.
                if (!reviewing || finishOpen || isTyping(e.target)) return;
                e.preventDefault();
                setFinishOpen(true);
                return;
            }
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (quickOpen || paletteOpen || searchOpen || finishOpen) return;
            if (isTyping(e.target)) {
                return;
            }

            if (e.key === '?') {
                setHelpOpen(v => !v);
                return;
            }
            if (e.key === 'r') {
                setPollTick(t => t + 1);
                return;
            }
            if (e.key === 't') {
                setCmdOpen(v => !v);
                return;
            }
            if (e.key === 'Escape' && helpOpen) {
                setHelpOpen(false);
                return;
            }
            if (!reviewing) return;
            if (e.key === 'Escape' && claudePanel) {
                closeClaudePanel();
                return;
            }

            switch (e.key) {
                case '/':
                    e.preventDefault();
                    filterInput.current?.focus();
                    return;
                case 'ArrowDown':
                case 'ArrowUp': {
                    if (!files.length) return;
                    e.preventDefault();
                    const i = files.findIndex(f => f.path === selected?.path);
                    const next = e.key === 'ArrowDown'
                        ? Math.min(i + 1, files.length - 1)
                        : Math.max(i - 1, 0);
                    setSelected(files[next]);
                    setPicked([]);
                    return;
                }
                case 'Escape':
                    if (picked.length) {
                        setPicked([]);
                    } else {
                        setFocusLine(null);
                        setFocusedFinding(null);
                    }
                    return;
                case 'p':
                    closeReview();
                    return;
                case 'o':
                    if (selected && selected.status !== 'D' && defaultEditor) openIn(defaultEditor);
                    return;
                case 'x':
                    toggleFiles(picked.length ? picked : selected ? [selected.path] : []);
                    return;
                case 'v':
                    setSplit(s => !s);
                    return;
                case 'b':
                    setIgnoreWS(v => !v);
                    return;
                case 'g':
                    toggleTreeView();
                    return;
                case 's':
                    toggleSince();
                    return;
                case 'n':
                    if (selected) setNoteOpen(v => !v);
                    return;
                case 'c':
                    startComment();
                    return;
                case 'C':
                    if (pr) toggleComments();
                    return;
                case 'B':
                    if (brief.kind !== 'off') setBriefOpen(v => !v);
                    return;
                case 'e':
                    explainHunk();
                    return;
                case 'f':
                case 'F':
                    if (aiOn) goFinding(e.key === 'f' ? 1 : -1);
                    return;
                case 'y':
                    if (focusedOnScreen) acceptFindingAsDraft(focusedOnScreen.key);
                    return;
                case 'd':
                    if (focusedOnScreen) dismissFinding(focusedOnScreen.key);
                    return;
                case 'a':
                    if (aiOn) {
                        e.preventDefault(); // the key would land in the question box as it takes focus
                        openAsk();
                    }
                    return;
                case '[':
                case ']':
                    moveHunk(e.key === ']' ? 1 : -1);
                    return;
            }
        }
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    // Switches the diff between the whole pull request and the changes since the reviewer's review.
    function toggleSince() {
        if (sinceFrom) setDiffMode(m => (m === 'since' ? 'whole' : 'since'));
    }

    function moveHunk(step: number) {
        diffView.current?.moveHunk(step);
    }

    // Replaces the app with the latest release and restarts it. On success the app quits itself.
    async function installUpdate() {
        setInstalling(true);
        try {
            await InstallUpdate();
        } catch (e) {
            setError(`Could not install the update: ${e}`);
            setInstalling(false);
        }
    }

    // Hides the update notice until the next release.
    function dismissUpdate() {
        if (update) writeStore(UPDATE_DISMISSED_KEY, update.latest);
        setUpdate(null);
    }

    // Loads the comments, then shows the panel. Clicking again closes it.
    function toggleComments() {
        if (commentsOpen) {
            setCommentsOpen(false);
            return;
        }
        setCommentsOpen(true);
        loadComments();
    }

    async function loadComments() {
        if (!pr) return;
        setCommentsLoading(true);
        try {
            setDiscussion(await PRComments(repo, pr.id));
        } catch (e) {
            setError(String(e));
        } finally {
            setCommentsLoading(false);
        }
    }

    // Opens a commented file's diff.
    function openCommentFile(path: string) {
        const file = changes.find(c => c.path === path);
        if (!file) {
            showFlash(`${path} is no longer changed in this pull request.`);
            return;
        }
        setSelected(file);
        setCommentsOpen(false);
    }

    // Click selects one file; Cmd/Ctrl-click toggles it in the selection; Shift-click selects a range.
    function pickFile(file: FileChange, e: ReactMouseEvent) {
        if (e.shiftKey && selected) {
            const anchor = files.findIndex(f => f.path === selected.path);
            const at = files.findIndex(f => f.path === file.path);
            if (anchor >= 0 && at >= 0) {
                const [lo, hi] = anchor < at ? [anchor, at] : [at, anchor];
                setPicked(files.slice(lo, hi + 1).map(f => f.path));
                return;
            }
        }
        if (e.metaKey || e.ctrlKey) {
            setPicked(prev => {
                const base = prev.length ? prev : selected ? [selected.path] : [];
                return base.includes(file.path) ? base.filter(p => p !== file.path) : [...base, file.path];
            });
            setSelected(file);
            return;
        }
        setPicked([]);
        setSelected(file);
    }

    function toggleFolder(path: string) {
        setCollapsed(prev => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            writeStore(`git-tree-compare:collapsed:${repo}`, [...next]);
            return next;
        });
    }

    // The editor used by the main button, and by the o key: the saved choice if it is still installed.
    const defaultEditor = editors.find(e => e.id === editorID)?.id ?? editors[0]?.id ?? '';

    // A pull request's file opens as a read-only copy at its head, so the editor shows what the diff
    // shows whatever is checked out. A commit or branch opens the working copy.
    async function openIn(id: string, path = selected?.path) {
        await openFile({id, path, at: pr && commits ? {number: pr.number, head: commits.head} : null});
    }

    async function openWorkingCopy(id: string, path = selected?.path) {
        await openFile({id, path, at: null});
    }

    async function openFile({id, path, at}: {id: string; path: string | undefined; at: {number: number; head: string} | null}) {
        if (!path) return;
        const name = editors.find(e => e.id === id)?.name ?? id;
        setEditorID(id);
        try {
            if (at) await OpenAtHead(repo, at.number, at.head, path, id);
            else await OpenInEditor(repo, path, id);
        } catch (e) {
            setError(`Could not open ${name}: ${e}`);
        }
    }

    // Right-click on a file: select it unless it is already in the selection, then open the menu.
    function openFileMenu(file: FileChange, e: ReactMouseEvent) {
        e.preventDefault();
        if (!pickedSet.has(file.path)) {
            setPicked([]);
            setSelected(file);
        }
        setMenu({x: e.clientX, y: e.clientY, path: file.path});
    }

    async function copyMenuPaths() {
        const text = menuPaths.join('\n');
        try {
            await navigator.clipboard.writeText(text);
            showFlash(menuPaths.length > 1 ? `Copied ${menuPaths.length} paths.` : 'Copied path.');
        } catch {
            setError('Could not copy to the clipboard.');
        }
    }

    async function exportPatch() {
        if (!scope) return;
        try {
            const path = await ExportPatch(scope, pr ? `pr-${pr.number}` : scope.head.slice(0, 7));
            if (path) showFlash(`Saved ${path}`);
        } catch (e) {
            setError(`Could not save the patch: ${e}`);
        }
    }

    // Puts the git-tree-compare command on the PATH, so a terminal can open a repository here.
    async function installCLI() {
        try {
            const path = await InstallCLI();
            showFlash(`Installed ${path}`);
        } catch (e) {
            setError(String(e));
        }
    }

    async function copySummary() {
        const title = pr ? `#${pr.number} ${pr.title}` : local?.title;
        if (!title) return;
        const md = buildMarkdown({title, files: changes, reviewed, notes, drafts});
        try {
            await navigator.clipboard.writeText(md);
            showFlash('Summary copied as Markdown');
        } catch {
            setError('Could not copy the summary');
        }
    }

    // Turns AI off for this repository, or back on. Saved, so it stays off after a restart.
    function toggleNoAI() {
        setNoAIRepos(list => (list.includes(repo) ? list.filter(r => r !== repo) : [...list, repo]));
    }

    // changeRef names the change under review for a Claude task, with the model chosen for its kind.
    function changeRef({kind, commits, fresh}: {kind: ClaudeTaskKind; commits: {base: string; head: string}; fresh: boolean}): main.ChangeRef {
        return main.ChangeRef.createFrom({
            repo, base: commits.base, head: commits.head, pr: pr?.number ?? 0, title: pr?.title ?? local?.title ?? '',
            model: modelFor({models: claudeModels, kind, fallback: claudeInfo?.defaultModel ?? ''}), fresh,
        });
    }

    // Writes the brief again for this head, skipping the one kept on disk.
    function rerunBrief() {
        if (commits) setBriefRerun(r => ({head: commits.head, n: (r?.n ?? 0) + 1}));
    }

    // f and ⇧F: the next or previous finding, from the focused one, else the focused line, else the
    // top of the file on screen.
    function goFinding(step: 1 | -1) {
        if (!findings.length) {
            showFlash(findingsRun.kind === 'running' ? 'Claude is still looking for findings.' : 'No Claude findings to show.');
            return;
        }
        const focused = findings.find(f => f.key === focusedFinding);
        const from = focused ?? (focusLine && focusLine.path === selected?.path ? focusLine : selected ? {path: selected.path, line: 0} : null);
        const next = nextFinding({findings, order: rulerFiles.map(f => f.path), from, step});
        if (next) showFinding(next);
    }

    function showFinding(f: Finding) {
        const file = changes.find(c => c.path === f.path);
        if (!file) return;
        setFocusedFinding(f.key);
        if (selected?.path !== f.path) {
            setSelected(file);
            setPicked([]);
        }
        setFocusLine({path: f.path, side: f.side, line: f.line});
        setJump({path: f.path, side: f.side, line: f.line, id: Date.now()});
    }

    // settleFinding hides a finding at this head, after an accept or a dismiss, and saves that.
    function settleFinding(key: string) {
        const next = [...settled, key];
        setSettled(next);
        if (conversationKey) writeStore(settledKey(conversationKey), next);
        setFocusedFinding(f => (f === key ? null : f));
    }

    // y: the finding becomes a line draft, opened for the reviewer to edit before it posts.
    function acceptFindingAsDraft(key: string) {
        const finding = findings.find(f => f.key === key);
        const store = draftsRef.current?.key;
        if (!finding || !store) return;
        const draft = acceptFinding(finding, {id: newDraftId(), head: commits?.head ?? null});
        changeDrafts(store, d => addDraft(d, draft));
        settleFinding(key);
        if (finding.path === selected?.path) setComposer({kind: 'edit', id: draft.id});
        showFlash(pr ? 'The finding is now a draft comment. Edit it; it posts when you finish.' : 'The finding is now a draft comment.');
    }

    // d: the finding stays hidden at this head.
    function dismissFinding(key: string) {
        settleFinding(key);
        showFlash('Dismissed. It stays hidden for this head.');
    }

    // Why? asks Claude about the finding in the Ask panel, with the question ready to edit and send.
    function askWhy(key: string) {
        const finding = findings.find(f => f.key === key);
        if (!finding) return;
        setFocusedFinding(key);
        setAskPrefill({text: whyQuestion(finding), id: Date.now()});
        openAsk();
    }

    // polishDraft asks Claude to rewrite a draft, for the editor to show beside the reviewer's words.
    function polishDraft({body, onEvent}: {body: string; onEvent: (event: ClaudeEvent) => void}): () => void {
        if (!commits) {
            onEvent({kind: 'error', message: 'No review is open.'});
            return () => {};
        }
        const taskId = `polish-${newDraftId()}`;
        const off = runClaude({
            taskId,
            start: () => StartPolish(taskId, main.PolishRequest.createFrom({change: changeRef({kind: 'polish', commits, fresh: false}), body})),
            onEvent,
        });
        return () => {
            off();
            CancelClaude(taskId).catch(() => {});
        };
    }

    // The Finish sheet's summary, drafted by Claude from the drafts and verdict. It never submits.
    async function draftSummary(): Promise<string> {
        if (!commits) throw new Error('No review is open.');
        const taskId = `summary-${newDraftId()}`;
        const answer = await claudeAnswer({
            taskId,
            start: () => StartReviewSummary(taskId, main.SummaryRequest.createFrom({
                change: changeRef({kind: 'summary', commits, fresh: false}), verdict, drafts: toReviewDrafts(drafts),
            })),
        });
        const text = answer.text.trim();
        if (!text) throw new Error('Claude answered with nothing.');
        return text;
    }

    // A title and description for the branch's pull request, drafted by Claude. Asking again skips the kept one.
    async function draftPRDescription() {
        if (!commits) return;
        const taskId = `prdesc-${newDraftId()}`;
        const answer = await claudeAnswer({
            taskId,
            start: () => StartPRDescription(taskId, changeRef({kind: 'prdesc', commits, fresh: prDraft.drafted})),
        });
        const description = parsePRDescription(answer.json);
        if (!description) throw new Error('Claude answered, but not with a title and description.');
        setPrDraft({...description, drafted: true});
    }

    // Opens the branch's pull request once the reviewer confirmed it. The backend checks the push again.
    async function createPullRequest(): Promise<string> {
        if (!local?.branch || !local.baseBranch) throw new Error('This review is not of a branch.');
        const url = await CreatePR(repo, main.PRCreateRequest.createFrom({
            base: local.baseBranch, branch: local.branch, head: local.head, title: prDraft.title, body: prDraft.body,
        }));
        showFlash(`Opened ${url}`);
        setPollTick(t => t + 1);
        return url;
    }

    // e: Claude explains the hunk around the focused line, or the first hunk in view.
    function explainHunk() {
        if (!aiOn || !commits || !selected || diffPath !== selected.path) return;
        const focus = focusLine?.path === selected.path ? focusLine : null;
        const hunk = hunkFor({text: diff, focus, index: diffView.current?.hunkInView() ?? 0});
        if (!hunk) {
            showFlash('This file has no hunk to explain.');
            return;
        }
        stopClaude();
        const taskId = `explain-${newDraftId()}`;
        const path = selected.path;
        setClaudePanel({kind: 'explain', turn: startTurn({taskId, ask: `${path} ${hunk.header}`})});
        runClaude({
            taskId,
            start: () => StartExplain(taskId, main.ExplainRequest.createFrom({change: changeRef({kind: 'explain', commits, fresh: false}), path, hunk: hunk.text})),
            onEvent: event => setClaudePanel(p => (p?.kind === 'explain' && p.turn.taskId === taskId ? {kind: 'explain', turn: turnStep(p.turn, event)} : p)),
        });
    }

    // a: opens the Ask panel for this review.
    function openAsk() {
        if (!aiOn || !commits) return;
        if (claudePanel?.kind !== 'ask') stopClaude();
        setClaudePanel({kind: 'ask'});
    }

    function askClaude(question: string) {
        if (!commits || !conversationKey) return;
        const key = conversationKey;
        const taskId = `ask-${newDraftId()}`;
        const asked = askTurn({conversation, taskId, question, newSessionId: newUUID});
        if (!asked) return;
        setAskPrefill(null);
        setConversations(all => ({...all, [key]: asked.conversation}));
        runClaude({
            taskId,
            start: () => StartAsk(taskId, main.AskRequest.createFrom({
                change: changeRef({kind: 'ask', commits, fresh: false}), session: asked.send.session, resume: asked.send.resume, question,
            })),
            onEvent: event => setConversations(all => ({
                ...all, [key]: conversationStep({conversation: all[key] ?? emptyConversation, taskId, event}),
            })),
        });
    }

    // stopClaude stops the answer the panel is waiting for, if any.
    function stopClaude() {
        const running = claudePanel?.kind === 'explain' ? [claudePanel.turn] : claudePanel?.kind === 'ask' ? conversation.turns : [];
        for (const turn of running) {
            if (turn.status.kind === 'running') CancelClaude(turn.taskId).catch(() => {});
        }
    }

    function closeClaudePanel() {
        stopClaude();
        setClaudePanel(null);
        setAskPrefill(null);
    }

    function setClaudeModel(kind: ClaudeTaskKind, model: string) {
        setClaudeModels(models => ({...models, [kind]: model}));
        showFlash(`${TASK_LABEL[kind]} uses ${model} from now on.`);
    }

    // The ⌘K list of Claude models, per kind of task.
    const modelCommands: Command[] = claudeInfo ? CLAUDE_TASKS.flatMap(kind => {
        const current = modelFor({models: claudeModels, kind, fallback: claudeInfo.defaultModel});
        return modelChoices(claudeInfo.defaultModel).map(model => ({
            id: `model:${kind}:${model}`,
            label: `${TASK_LABEL[kind]}: ${model}${model === claudeInfo.defaultModel ? ' (default)' : ''}${model === current ? ' ✓' : ''}`,
            run: () => setClaudeModel(kind, model),
        }));
    }) : [];

    const commands: Command[] = [
        ...(reviewing ? [
            {id: 'back', label: 'Back to pull requests', hint: 'p', run: closeReview},
            {id: 'file', label: 'Go to file', hint: '⌘P', run: () => setQuickOpen(true)},
            {id: 'search', label: 'Search in files', hint: '⇧⌘F', run: () => setSearchOpen(true)},
            {id: 'comment', label: 'Comment on the focused line, or the file', hint: 'c', run: startComment},
            {id: 'finish', label: 'Finish review', hint: '⌘↵', run: () => setFinishOpen(true)},
        ] : []),
        ...(pr ? [
            {id: 'comments', label: 'Show comments', hint: '⇧C', run: toggleComments},
            {id: 'github', label: 'Open pull request on GitHub', run: () => BrowserOpenURL(pr.url)},
        ] : []),
        ...(reviewing ? [
            {id: 'ws', label: ignoreWS ? 'Show whitespace changes' : 'Ignore whitespace changes', hint: 'b', run: () => setIgnoreWS(v => !v)},
            {id: 'sort', label: sort === 'name' ? 'Sort files by size of change' : 'Sort files by name', run: () => setSort(s => (s === 'name' ? 'size' : 'name'))},
            {id: 'view', label: treeView === 'state' ? 'Show files by folder' : 'Group files by state', hint: 'g', run: toggleTreeView},
            ...(sinceFrom ? [{
                id: 'since', label: diffMode === 'since' ? 'Show the whole pull request' : 'Show changes since my review', hint: 's', run: toggleSince,
            }] : []),
            {id: 'run', label: 'Run a command', hint: 't', run: () => setCmdOpen(v => !v)},
            {id: 'summary', label: 'Copy summary as Markdown', run: copySummary},
            {id: 'patch', label: 'Export patch', run: exportPatch},
        ] : []),
        ...(brief.kind !== 'off' ? [
            {id: 'brief', label: briefOpen ? 'Hide the Claude brief' : 'Show the Claude brief', hint: '⇧B', run: () => setBriefOpen(v => !v)},
            {id: 'rebrief', label: 'Re-run Claude brief', run: rerunBrief},
        ] : []),
        ...(aiOn && reviewing ? [
            {id: 'explain', label: 'Explain this hunk with Claude', hint: 'e', run: explainHunk},
            {id: 'ask', label: 'Ask Claude about this change', hint: 'a', run: openAsk},
            {id: 'finding-next', label: 'Next Claude finding', hint: 'f', run: () => goFinding(1)},
            {id: 'finding-prev', label: 'Previous Claude finding', hint: '⇧F', run: () => goFinding(-1)},
        ] : []),
        ...(aiOn ? [{id: 'model', label: 'Claude model…', run: () => {
            setPaletteMode('model');
            setPaletteOpen(true);
        }}] : []),
        ...(claudeInfo?.installed && repo ? [{
            id: 'noai', label: noAIRepos.includes(repo) ? 'Use AI for this repository' : 'No AI for this repository', run: toggleNoAI,
        }] : []),
        {id: 'refresh', label: 'Refresh', hint: 'r', run: () => setPollTick(t => t + 1)},
        {id: 'terminal', label: termOpen ? 'Hide terminal' : 'Show terminal', hint: '⌃`', run: () => setTermOpen(v => !v)},
        {id: 'repo', label: 'Open another repository', run: chooseRepo},
        {id: 'commit', label: 'Review a commit…', run: () => setRefMode('commit')},
        {id: 'branch', label: 'Review a branch…', run: () => setRefMode('branch')},
        {id: 'keys', label: 'Keyboard shortcuts', hint: '?', run: () => setHelpOpen(true)},
        {id: 'cli', label: "Install 'git-tree-compare' command in PATH", run: installCLI},
    ];

    return (
        <div id="app">
            {updateBanner && !landing && updateBanner}

            {flash && <div className="flash" role="status">{flash}</div>}

            {error && (
                <div className="error" role="alert">
                    <span>{error}</span>
                    <Button variant="ghost" size="icon" onClick={() => setError('')} aria-label="Dismiss">×</Button>
                </div>
            )}

            {landing && (
                <Landing
                    banner={updateBanner}
                    last={repo}
                    recent={recent}
                    error={pickError}
                    onOpen={openRepo}
                    onPick={chooseRepo}
                    onShortcuts={() => setHelpOpen(true)}
                />
            )}

            {helpOpen && <ShortcutsSheet onClose={() => setHelpOpen(false)}/>}

            {finishOpen && reviewing && (
                <FinishSheet
                    drafts={drafts.length}
                    onClose={() => setFinishOpen(false)}
                    mode={pr ? {
                        kind: 'pr', isMine: pr.isMine, verdict, body: summary, onVerdict: setVerdict, onBody: setSummary, onSubmit: submitReview,
                        staleNote: commits ? staleNote(drafts, commits.head) : null, onDraftSummary: aiOn ? draftSummary : null,
                    } : {
                        kind: 'local',
                        onCopySummary: () => {
                            copySummary();
                            setFinishOpen(false);
                        },
                        onExportPatch: exportPatch,
                        selfReview: local?.branch && local.baseBranch ? {
                            branch: local.branch, base: local.baseBranch, push: pushCheck, title: prDraft.title, body: prDraft.body, drafted: prDraft.drafted,
                            onTitle: title => setPrDraft(d => ({...d, title, drafted: false})),
                            onBody: body => setPrDraft(d => ({...d, body, drafted: false})),
                            onDraft: aiOn ? draftPRDescription : null, onCreate: createPullRequest, onOpenURL: BrowserOpenURL,
                        } : null,
                    }}
                />
            )}

            {menu && (
                <FileMenu
                    x={menu.x}
                    y={menu.y}
                    paths={menuPaths}
                    allReviewed={menuAllReviewed}
                    onOpenInEditor={path => openIn(defaultEditor, path)}
                    onOpenWorkingCopy={pr ? path => openWorkingCopy(defaultEditor, path) : null}
                    onCopyPaths={copyMenuPaths}
                    onToggleReviewed={() => toggleFiles(menuPaths)}
                    onClose={() => setMenu(null)}
                />
            )}

            {quickOpen && (
                <QuickOpen
                    files={changes}
                    onClose={() => setQuickOpen(false)}
                    onPick={path => {
                        const file = changes.find(c => c.path === path);
                        if (file) setSelected(file);
                        setQuickOpen(false);
                    }}
                />
            )}

            {refMode && (
                <RefPicker
                    repo={repo}
                    mode={refMode}
                    onOpen={openLocal}
                    onError={setError}
                    onClose={() => setRefMode(null)}
                />
            )}

            {searchOpen && commits && (
                <SearchDialog
                    repo={repo}
                    head={commits.head}
                    paths={searchPaths}
                    query={searchQuery}
                    onQuery={setSearchQuery}
                    onClose={() => setSearchOpen(false)}
                    onPick={openSearchHit}
                />
            )}

            {paletteOpen && (
                <CommandPalette
                    commands={paletteMode === 'model' ? modelCommands : commands}
                    onClose={() => {
                        setPaletteOpen(false);
                        setPaletteMode('commands');
                    }}
                />
            )}

            {picking && (
                <RepoPicker
                    start={repo ? parentOf(repo) : ''}
                    recent={recent}
                    openError={pickError}
                    onOpen={openRepo}
                    onClose={() => setPicking(false)}
                />
            )}

            {!landing && !reviewing && (
                <PRList
                    repo={repo}
                    prs={prs}
                    local={localWork}
                    loading={prsLoading}
                    error={prsError}
                    reviewedCount={p => storedReviewedCount(repo, p)}
                    active={!picking && !paletteOpen && !helpOpen && openNumber === null}
                    onOpen={openRow}
                    onRefresh={() => setPollTick(t => t + 1)}
                    onChangeRepo={chooseRepo}
                    onCommands={() => setPaletteOpen(true)}
                />
            )}

            {reviewing && (
                <>
                    <header className="review-bar">
                        <Button onClick={closeReview} title="All pull requests (p)">All PRs</Button>
                        <div className="review-title">
                            {pr && (
                                <>
                                    <span className="review-name"><span className="pr-num">{pr.number}</span> {pr.title}</span>
                                    <span className="review-sub">
                                        {pr.author} wants {pr.headRefName} in {pr.baseRefName}
                                        {pr.mergeable === 'CONFLICTING' && <span className="pr-tag bad">Conflicts</span>}
                                        {pr.isDraft && <span className="pr-tag">Draft</span>}
                                    </span>
                                </>
                            )}
                            {local && (
                                <>
                                    <span className="review-name">{local.title}</span>
                                    <span className="review-sub">{local.detail}</span>
                                </>
                            )}
                        </div>
                        {unsynced.size > 0 && (
                            <span className="sync-note" role="status" title={syncError}>
                                {unsynced.size} not on GitHub yet, retrying
                            </span>
                        )}
                        {briefChip(brief) && (
                            <button
                                type="button"
                                className={`claude-chip ${brief.kind}`}
                                onClick={() => setBriefOpen(v => !v)}
                                title={brief.kind === 'error' ? brief.message : 'Show or hide the brief (⇧B)'}
                                aria-live="polite"
                            >
                                {briefChip(brief)}
                            </button>
                        )}
                        {findingsRun.kind !== 'off' && (
                            <button
                                type="button"
                                className={`claude-chip ${findingsRun.kind === 'answered' && parsedFindings === null ? 'error' : findingsRun.kind}`}
                                onClick={() => goFinding(1)}
                                title={findingsRun.kind === 'error' ? findingsRun.message : 'Go to the next finding (f)'}
                                aria-live="polite"
                            >
                                {findingsRun.kind === 'running' ? 'Claude checking for issues…'
                                    : findingsRun.kind === 'error' || parsedFindings === null ? 'Findings failed'
                                    : `${findings.length} finding${findings.length === 1 ? '' : 's'}`}
                            </button>
                        )}
                        <span className="review-count" title="Files reviewed, and files a push changed after you reviewed them">
                            {progressText({reviewed: reviewedCount, total: changes.length, changed: changedSinceReview.size})}
                        </span>
                        {pr && (
                            <Button onClick={toggleComments} aria-pressed={commentsOpen} title="Review comments (⇧C)">
                                Comments{unresolvedCount > 0 ? ` ${unresolvedCount}` : ''}
                            </Button>
                        )}
                        <Button onClick={() => setFinishOpen(true)} title={pr ? 'Submit your review with a verdict (⌘↵)' : 'Copy the summary or export a patch (⌘↵)'}>
                            Finish review{drafts.length ? ` · ${drafts.length}` : ''} <Kbd>⌘↵</Kbd>
                        </Button>
                        <Button onClick={() => setPaletteOpen(true)} title="All commands">Commands <Kbd>⌘K</Kbd></Button>
                    </header>

                    <ReviewRuler
                        files={rulerFiles}
                        current={selected?.path}
                        reviewed={reviewed}
                        changed={changedSinceReview}
                        onPick={path => {
                            const file = changes.find(c => c.path === path);
                            if (file) setSelected(file);
                            setPicked([]);
                        }}
                    />

                    <div className="panes">
                        <aside className="tree">
                            {changes.length > 0 && (
                                <div className="tree-head">
                                    <input
                                        ref={filterInput}
                                        className="filter"
                                        type="search"
                                        aria-label="Filter files"
                                        placeholder="Filter files (/)"
                                        value={filter}
                                        onChange={e => setFilter(e.target.value)}
                                    />
                                    <Button
                                        aria-pressed={treeView === 'state'}
                                        onClick={toggleTreeView}
                                        title={treeView === 'state' ? 'Show files by folder (g)' : 'Group files by state (g)'}
                                    >
                                        {treeView === 'state' ? 'By state' : 'Folders'}
                                    </Button>
                                </div>
                            )}
                            {picked.length > 1 && (
                                <div className="tree-select" role="status">
                                    <span>{picked.length} selected</span>
                                    <Button onClick={() => toggleFiles(picked)}>
                                        {picked.every(p => reviewed[p]) ? 'Unmark all' : 'Mark all reviewed'}
                                    </Button>
                                    <Button onClick={() => setPicked([])} title="Clear selection (Esc)">Clear</Button>
                                </div>
                            )}
                            {loading && changes.length === 0 && (
                                <Empty title={pr ? 'Fetching pull request…' : 'Reading changes…'} mascot={<Snail/>}/>
                            )}
                            {!loading && commits && changes.length === 0 && (
                                <Empty title="No changed files" hint={pr ? 'This pull request changes nothing.' : 'Nothing changed here.'} mascot={<OwlTray/>}/>
                            )}
                            {changes.length > 0 && visibleChanges.length === 0 && (
                                <Empty title="No matches" hint={`Nothing matches "${filter}".`} mascot={<OwlSearch/>}/>
                            )}
                            {tree.length > 0 && treeView === 'folders' && (
                                <TreeList
                                    nodes={tree}
                                    selectedPath={selected?.path}
                                    picked={pickedSet}
                                    collapsed={collapsed}
                                    reviewed={reviewed}
                                    notes={notes}
                                    comments={commentCounts}
                                    drafts={draftCountByPath}
                                    changedSinceReview={changedSinceReview}
                                    unsynced={unsynced}
                                    risks={risks}
                                    onToggle={toggleFolder}
                                    onToggleReviewed={path => toggleFiles([path])}
                                    onPick={pickFile}
                                    onContextMenu={openFileMenu}
                                />
                            )}
                            {treeView === 'state' && (
                                <StateList
                                    sections={sections}
                                    closed={closedSections}
                                    onToggleSection={toggleSection}
                                    selectedPath={selected?.path}
                                    picked={pickedSet}
                                    reviewed={reviewed}
                                    notes={notes}
                                    comments={commentCounts}
                                    drafts={draftCountByPath}
                                    changedSinceReview={changedSinceReview}
                                    unsynced={unsynced}
                                    risks={risks}
                                    onToggleReviewed={path => toggleFiles([path])}
                                    onPick={pickFile}
                                    onContextMenu={openFileMenu}
                                />
                            )}
                        </aside>
                        <main className="diff">
                            {changes.length > 0 && reviewedCount === changes.length && (
                                <div className="passed" role="status">
                                    <OwlHop/>
                                    <span>All {changes.length} files reviewed</span>
                                    <Button onClick={() => setFinishOpen(true)}>Finish review <Kbd>⌘↵</Kbd></Button>
                                </div>
                            )}
                            {commentsOpen && (
                                <CommentsPanel
                                    discussion={discussion}
                                    loading={commentsLoading}
                                    controls={threadControls}
                                    checks={threadChecks}
                                    onOpenFile={openCommentFile}
                                    onOpenURL={BrowserOpenURL}
                                    onRefresh={loadComments}
                                    onClose={() => setCommentsOpen(false)}
                                />
                            )}
                            {cmdOpen && (
                                <CommandPanel
                                    repo={repo}
                                    paths={visibleChanges.map(c => c.path)}
                                    checks={pr ? {number: pr.number, onOpenURL: BrowserOpenURL} : null}
                                    onClose={() => setCmdOpen(false)}
                                />
                            )}
                            {brief.kind !== 'off' && (
                                <BriefCard state={brief} since={sinceNote} open={briefOpen} onToggle={() => setBriefOpen(v => !v)} onOpenFile={openCommentFile}/>
                            )}
                            {selected
                                ? <DiffPanel
                                    file={selected}
                                    text={diff}
                                    split={split}
                                    reviewed={!!reviewed[selected.path]}
                                    onToggleReviewed={() => toggleFiles([selected.path])}
                                    note={notes[selected.path] ?? ''}
                                    noteOpen={noteOpen}
                                    onToggleNote={() => setNoteOpen(v => !v)}
                                    onNote={text => updateNote(selected.path, text)}
                                    onToggleSplit={() => setSplit(s => !s)}
                                    fullFile={fullFile || tempFull === selected.path}
                                    onToggleFullFile={() => (tempFull === selected.path ? setTempFull(null) : setFullFile(v => !v))}
                                    jump={jump?.path === selected.path && diffPath === selected.path ? jump : null}
                                    onJumpOutside={showWholeFile}
                                    since={sinceFrom ? range.kind : null}
                                    onToggleSince={toggleSince}
                                    diffNote={diffPath === selected.path ? diffNote : ''}
                                    editors={editors}
                                    defaultEditor={defaultEditor}
                                    onOpenIn={openIn}
                                    onOpenWorkingCopy={pr ? openWorkingCopy : null}
                                    prFileURL={prFileURL}
                                    threads={fileThreads}
                                    onOpenURL={BrowserOpenURL}
                                    diffView={diffView}
                                    drafts={fileDrafts}
                                    draftLabel={draftLabel}
                                    composer={composer}
                                    focus={focusLine?.path === selected.path ? focusLine : null}
                                    onFocusLine={focusAt}
                                    onComment={startComment}
                                    onAddNoteToReview={() => addNoteToReview(selected.path)}
                                    draftControls={draftControls}
                                    threadControls={pr ? threadControls : null}
                                    threadChecks={threadChecks}
                                    findings={fileFindings}
                                    focusedFinding={focusedFinding}
                                    findingControls={findingControls}
                                />
                                : <Empty title="No file selected" hint="Choose a file in the tree to see its diff."/>}
                        </main>
                        {claudePanel?.kind === 'explain' && (
                            <ClaudePanel title="explain" turns={[claudePanel.turn]} ask={null} onClose={closeClaudePanel}/>
                        )}
                        {claudePanel?.kind === 'ask' && (
                            <ClaudePanel
                                title="ask"
                                turns={conversation.turns}
                                ask={{onSend: askClaude, busy: conversation.turns.some(t => t.status.kind === 'running'), prefill: askPrefill}}
                                onClose={closeClaudePanel}
                            />
                        )}
                    </div>
                </>
            )}

            {repo && termStarted && (
                <div className="terminal-dock" hidden={!termOpen}>
                    <TerminalPanel repo={repo} visible={termOpen}/>
                </div>
            )}
        </div>
    );
}

// storedReviewedCount reads a pull request's progress from what was saved the last time it was open.
function storedReviewedCount(repo: string, pr: PR): number {
    const saved = readStore<ReviewRecord>(reviewKey(repo, pr.number), emptyRecord);
    const paths = new Set([...Object.keys(saved.states), ...Object.keys(saved.pending)]);
    return [...paths].filter(p => isReviewed(saved, p)).length;
}

function Empty({title, hint, mascot, children}: {title: string; hint?: string; mascot?: ReactNode; children?: ReactNode}) {
    return (
        <div className="empty">
            {mascot}
            <div className="empty-title">{title}</div>
            {hint && <div className="empty-hint">{hint}</div>}
            {children}
        </div>
    );
}

// What a file row needs, in the folder tree and in the "By state" sections alike.
type RowProps = {
    selectedPath?: string;
    picked: Set<string>;
    reviewed: Record<string, string>;
    notes: Record<string, string>;
    comments: Record<string, number>;
    drafts: Record<string, number>; // draft comments per file
    changedSinceReview: Set<string>;
    unsynced: Set<string>;
    risks: Record<string, RiskMark>; // the brief's worst risk per file
    onToggleReviewed: (path: string) => void;
    onPick: (file: FileChange, e: ReactMouseEvent) => void;
    onContextMenu: (file: FileChange, e: ReactMouseEvent) => void;
};

type TreeProps = RowProps & {
    collapsed: Set<string>;
    onToggle: (path: string) => void;
};

function TreeList(props: TreeProps & {nodes: TreeNode[]; depth?: number}) {
    const {nodes, depth = 0, ...rest} = props;
    return (
        <ul className="tree-list">
            {nodes.map(node => <TreeItem key={node.path} node={node} depth={depth} {...rest}/>)}
        </ul>
    );
}

function TreeItem(props: TreeProps & {node: TreeNode; depth: number}) {
    const {node, depth, ...rest} = props;
    const indent = {paddingLeft: 8 + depth * 14};

    if (node.file) {
        return <FileRow file={node.file} label={node.name} depth={depth} dim={node.generated} {...rest}/>;
    }

    const open = !rest.collapsed.has(node.path);
    return (
        <li>
            <div className="row folder" style={indent} onClick={() => rest.onToggle(node.path)}>
                <span className={open ? 'caret open' : 'caret'}>▸</span>
                <span className="name">{node.name}</span>
                <span className="counts"><span className="added">+{node.added}</span> <span className="deleted">−{node.deleted}</span></span>
            </div>
            {open && (
                <TreeList
                    nodes={node.children}
                    depth={depth + 1}
                    selectedPath={rest.selectedPath}
                    picked={rest.picked}
                    collapsed={rest.collapsed}
                    reviewed={rest.reviewed}
                    notes={rest.notes}
                    comments={rest.comments}
                    drafts={rest.drafts}
                    changedSinceReview={rest.changedSinceReview}
                    unsynced={rest.unsynced}
                    risks={rest.risks}
                    onToggle={rest.onToggle}
                    onToggleReviewed={rest.onToggleReviewed}
                    onPick={rest.onPick}
                    onContextMenu={rest.onContextMenu}
                />
            )}
        </li>
    );
}

// FileRow is one changed file: its review checkbox, status, name and markers.
function FileRow(props: RowProps & {file: FileChange; label: ReactNode; depth: number; dim?: boolean; noise?: NoiseReason | null}) {
    const {file, label, depth, dim, noise, ...rest} = props;
    const active = file.path === rest.selectedPath;
    const isReviewed = !!rest.reviewed[file.path];
    const classes = ['row', 'file', active && 'active', rest.picked.has(file.path) && 'picked', dim && 'generated', isReviewed && 'reviewed']
        .filter(Boolean).join(' ');
    return (
        <li>
            <div className={classes} style={{paddingLeft: 8 + depth * 14}} onClick={e => rest.onPick(file, e)} onContextMenu={e => rest.onContextMenu(file, e)} aria-selected={active}>
                <input
                    type="checkbox"
                    className="review"
                    checked={isReviewed}
                    onClick={e => e.stopPropagation()}
                    onChange={() => rest.onToggleReviewed(file.path)}
                    aria-label={`Reviewed: ${file.path}`}
                    title="Mark reviewed (x)"
                />
                <span className={`status status-${file.status}`} title={STATUS_LABEL[file.status]}>{file.status}</span>
                <span className="name" title={file.path}>{label}</span>
                {rest.risks[file.path] && (
                    <span className={`risk-dot risk-${rest.risks[file.path].level}`} title={`Claude: ${rest.risks[file.path].why}`}>●</span>
                )}
                {noise && <span className="noise-tag">{NOISE_LABEL[noise]}</span>}
                {rest.notes[file.path] && <span className="note-dot" title="Has a note">●</span>}
                {rest.comments[file.path] > 0 && (
                    <span className="cmt-count" title="Open review comments on GitHub">{rest.comments[file.path]}</span>
                )}
                {rest.drafts[file.path] > 0 && (
                    <span className="draft-count" title="Draft comments in your pending review">{rest.drafts[file.path]} draft</span>
                )}
                {rest.changedSinceReview.has(file.path) && <span className="changed-tag" title="Changed by a push after you reviewed it">changed</span>}
                {rest.unsynced.has(file.path) && <span className="unsynced" title="Not on GitHub yet, retrying">●</span>}
                <span className="counts"><span className="added">+{file.added}</span> <span className="deleted">−{file.deleted}</span></span>
            </div>
        </li>
    );
}

// StateList is the "By state" tree: one section per review state, files in reading order, each
// named by its file name with its folder beside it. Noise sits in Folded with the reason.
function StateList(props: RowProps & {sections: Section[]; closed: Set<SectionKind>; onToggleSection: (kind: SectionKind) => void}) {
    const {sections, closed, onToggleSection, ...rest} = props;
    return (
        <ul className="tree-list">
            {sections.map(section => {
                const open = !closed.has(section.kind);
                return (
                    <li key={section.kind}>
                        <div className="row folder section-head" onClick={() => onToggleSection(section.kind)} aria-expanded={open}>
                            <span className={open ? 'caret open' : 'caret'}>▸</span>
                            <span className="name">{SECTION_TITLE[section.kind]}</span>
                            <span className="counts">{section.files.length}</span>
                        </div>
                        {open && (
                            <ul className="tree-list">
                                {(section.chapters.length ? section.chapters : [{title: '', files: section.files}]).map((group, i) => (
                                    <Fragment key={i}>
                                        {group.title && <li className="chapter-head" title="A step of the change, from Claude's brief">{group.title}</li>}
                                        {group.files.map(file => (
                                            <FileRow
                                                key={file.path}
                                                file={file}
                                                label={<>{basename(file.path)}<span className="dir">{folderOf(file.path)}</span></>}
                                                depth={1}
                                                noise={section.kind === 'folded' ? noiseOf(file) : null}
                                                {...rest}
                                            />
                                        ))}
                                    </Fragment>
                                ))}
                            </ul>
                        )}
                    </li>
                );
            })}
        </ul>
    );
}

function DiffPanel(props: {
    file: FileChange;
    text: string;
    split: boolean;
    reviewed: boolean;
    onToggleReviewed: () => void;
    note: string;
    noteOpen: boolean;
    onToggleNote: () => void;
    onNote: (text: string) => void;
    onToggleSplit: () => void;
    fullFile: boolean;
    onToggleFullFile: () => void;
    editors: main.Editor[];
    defaultEditor: string;
    onOpenIn: (id: string) => void;
    onOpenWorkingCopy: ((id: string) => void) | null; // a pull request opens at its head; this opens the local file
    prFileURL: string;
    threads: PRThread[];
    onOpenURL: (url: string) => void;
    jump: {side: Side; line: number; id: number} | null;
    onJumpOutside: () => void; // the jump line is not in this diff
    since: DiffRange['kind'] | null; // the range shown, when the file changed since your review
    onToggleSince: () => void;
    diffNote: string; // why the whole pull request is shown instead of the changes since your review
    diffView: RefObject<DiffHandle | null>;
    drafts: Draft[]; // this file's drafts, line and file
    draftLabel: string;
    composer: Composer | null;
    focus: LineFocus | null;
    onFocusLine: (target: {side: Side; line: number}) => void;
    onComment: () => void;
    onAddNoteToReview: () => void;
    draftControls: DraftControls;
    threadControls: ThreadControls | null;
    threadChecks: Readonly<Record<string, ThreadCheck>>;
    findings: Finding[]; // this file's findings
    focusedFinding: string | null;
    findingControls: FindingControls;
}) {
    const {file, text, split, note, noteOpen, composer} = props;
    const fileLevel = props.drafts.filter(d => d.kind === 'file');
    const editing = composer?.kind === 'edit' ? composer.id : null;
    const addingFile = composer?.kind === 'file' && composer.path === file.path;
    // The line editor and focus are passed to the memoised diff only when they are on this file.
    const lineComposer = composer?.kind === 'line' && composer.path === file.path ? composer : composer?.kind === 'edit' ? composer : null;
    return (
        <>
            <div className="diff-header">
                <span className={`chip status-${file.status}`} title={STATUS_LABEL[file.status]}>{STATUS_LABEL[file.status]}</span>
                <div className="diff-title">
                    <div className="diff-path">{file.path}</div>
                    {file.oldPath && <div className="diff-old">renamed from {file.oldPath}</div>}
                </div>
                <Button className="review-toggle" aria-pressed={props.reviewed} onClick={props.onToggleReviewed} title="Mark reviewed here and on GitHub (x)">
                    {props.reviewed ? 'Reviewed' : 'Mark reviewed'} <Kbd>x</Kbd>
                </Button>
                {props.since && (
                    <div className="since-toggle" role="group" aria-label="Diff range">
                        <Button aria-pressed={props.since === 'whole'} onClick={props.since === 'whole' ? undefined : props.onToggleSince} title="Every change in the pull request (s)">
                            Whole PR
                        </Button>
                        <Button aria-pressed={props.since === 'since'} onClick={props.since === 'since' ? undefined : props.onToggleSince} title="Only what changed after you marked this file reviewed (s)">
                            Since my review
                        </Button>
                    </div>
                )}
                <Button onClick={props.onComment} title="Comment on the line you clicked, or on the file (c)">Comment</Button>
                <Button onClick={props.onToggleNote} title="Note (n)">{noteOpen ? 'Hide note' : 'Note'}</Button>
                <Button onClick={props.onToggleSplit} title="Toggle split view (v)">
                    {split ? 'Unified' : 'Split'}
                </Button>
                <Button
                    aria-pressed={props.fullFile}
                    onClick={props.onToggleFullFile}
                    title="Show the whole file, with the changes marked, instead of only the lines around them"
                >
                    {props.fullFile ? 'Changes only' : 'Full file'}
                </Button>
                {props.prFileURL && (
                    <Button onClick={() => props.onOpenURL(props.prFileURL)} title="Open this file's diff on the pull request">Open on GitHub</Button>
                )}
                <EditorMenu editors={props.editors} current={props.defaultEditor} disabled={file.status === 'D'} onOpen={props.onOpenIn}
                    onOpenWorkingCopy={props.onOpenWorkingCopy}/>
            </div>
            {props.diffNote && <div className="diff-note" role="status">{props.diffNote}</div>}
            {noteOpen && (
                <>
                    <textarea
                        className="note"
                        placeholder="A note for this file. It is saved on this machine and included in the Markdown summary."
                        value={note}
                        onChange={e => props.onNote(e.target.value)}
                    />
                    <div className="note-actions">
                        <Button onClick={props.onAddNoteToReview} disabled={!note.trim()} title="Turn this note into a file comment in your pending review">
                            Add to review
                        </Button>
                    </div>
                </>
            )}
            {(fileLevel.length > 0 || addingFile) && (
                <div className="file-drafts">
                    <DraftStack
                        drafts={fileLevel}
                        editing={editing}
                        adding={addingFile}
                        label={props.draftLabel}
                        placeholder="Comment on this file"
                        controls={props.draftControls}
                    />
                </div>
            )}
            <DiffView
                text={text}
                path={file.path}
                split={split}
                threads={props.threads}
                onOpenURL={props.onOpenURL}
                jump={props.jump}
                onJumpOutside={props.fullFile ? undefined : props.onJumpOutside}
                ref={props.diffView}
                drafts={props.drafts}
                draftLabel={props.draftLabel}
                composer={lineComposer}
                focus={props.focus}
                onFocusLine={props.onFocusLine}
                draftControls={props.draftControls}
                threadControls={props.threadControls}
                threadChecks={props.threadChecks}
                findings={props.findings}
                focusedFinding={props.focusedFinding}
                findingControls={props.findingControls}
            />
        </>
    );
}

// DiffHandle lets the app move through the hunks of the diff on screen, and asks which one is in view.
export type DiffHandle = {moveHunk: (step: number) => void; hunkInView: () => number};

const ROW_HEIGHT = 24; // a diff line, matching .diff-body's line-height; only rows with threads are measured
const THREAD_HEIGHT = 96; // a guess for a row's review threads until the row is measured
const DRAFT_HEIGHT = 84; // a guess for a draft or its editor under a row, until the row is measured
const FINDING_HEIGHT = 120; // a guess for a Claude finding under a row, until the row is measured
const HEADER_HEIGHT = 48; // the sticky file header, which a row scrolled to the top must clear
const BODY_PADDING = 6;
const GUTTERS_WIDTH = 114; // two line-number gutters, the sign and the right padding of a unified line

// DiffView draws the file's diff. Review threads sit under their line on the new side.
// A thread whose line is not in the diff (outdated, or the file changed since) is listed at the top.
// Only the rows in view are drawn, so a file of any length opens and scrolls at the same speed.
// It is memoised: a diff can be thousands of lines, and most app state never touches it.
const DiffView = memo(function DiffView({
    text, path, split, threads, onOpenURL, jump, onJumpOutside, ref, drafts, draftLabel, composer, focus, onFocusLine, draftControls, threadControls,
    threadChecks, findings, focusedFinding, findingControls,
}: {
    text: string;
    path: string; // picks the language for syntax colours
    split: boolean;
    threads: PRThread[];
    onOpenURL: (url: string) => void;
    jump: {side: Side; line: number; id: number} | null; // a line to scroll to and flash
    onJumpOutside?: () => void; // asks for the whole file when the line is not in this diff
    ref?: Ref<DiffHandle>;
    drafts: Draft[]; // line drafts are drawn under their line
    draftLabel: string;
    composer: Composer | null; // a line editor on this file, or a draft being edited
    focus: {side: Side; line: number} | null;
    onFocusLine: (target: {side: Side; line: number}) => void;
    draftControls: DraftControls;
    threadControls: ThreadControls | null;
    threadChecks: Readonly<Record<string, ThreadCheck>>; // Claude's read on threads, by id
    findings: Finding[]; // Claude's findings, drawn under their line
    focusedFinding: string | null;
    findingControls: FindingControls;
}) {
    const lines = useMemo(() => parseDiff(text), [text]);
    const rows = useMemo(() => diffRows(lines, split), [lines, split]);
    // Lines draw plain first and take their colours when the tokenizer is done.
    const [tokens, setTokens] = useState<Map<Line, Token[]>>(() => new Map());
    useEffect(() => {
        let stale = false;
        setTokens(new Map());
        highlight(lines, path).then(map => !stale && setTokens(map), () => {});
        return () => {
            stale = true;
        };
    }, [lines, path]);
    const byLine = useMemo(() => {
        const map = new Map<number, PRThread[]>();
        for (const t of threads) map.set(t.line, [...(map.get(t.line) ?? []), t]);
        return map;
    }, [threads]);
    const visibleLines = useMemo(() => new Set(lines.map(l => l.newNo)), [lines]);
    const threadsOf = useCallback(
        (row: DiffRow) => (row.kind !== 'hunk' && row.newNo !== undefined ? byLine.get(row.newNo) ?? [] : []),
        [byLine],
    );
    // Line drafts by side and line, and what each row carries under it: drafts, and a new draft's editor.
    const draftsAt = useMemo(() => {
        const map = new Map<string, Draft[]>();
        for (const d of drafts) {
            if (d.kind === 'line') map.set(`${d.side}:${d.line}`, [...(map.get(`${d.side}:${d.line}`) ?? []), d]);
        }
        return map;
    }, [drafts]);
    const findingsAt = useMemo(() => {
        const map = new Map<string, Finding[]>();
        for (const f of findings) map.set(`${f.side}:${f.line}`, [...(map.get(`${f.side}:${f.line}`) ?? []), f]);
        return map;
    }, [findings]);
    const draftsOf = useCallback((row: DiffRow) => {
        const targets = rowTargets(row);
        return {
            targets,
            drafts: targets.flatMap(t => draftsAt.get(`${t.side}:${t.line}`) ?? []),
            findings: targets.flatMap(t => findingsAt.get(`${t.side}:${t.line}`) ?? []),
            adding: composer?.kind === 'line' && targets.some(t => t.side === composer.side && t.line === composer.line),
        };
    }, [draftsAt, findingsAt, composer]);
    // Changes only with the rows, their threads, drafts or findings, which is when the sizes must be estimated again.
    const estimateSize = useCallback((i: number) => {
        const extra = draftsOf(rows[i]);
        return ROW_HEIGHT + threadsOf(rows[i]).length * THREAD_HEIGHT + (extra.drafts.length + (extra.adding ? 1 : 0)) * DRAFT_HEIGHT
            + extra.findings.length * FINDING_HEIGHT;
    }, [rows, threadsOf, draftsOf]);
    // The longest line sets the width, so the horizontal scroll does not change as rows come and go.
    const width = useMemo(() => {
        let columns = 0;
        for (const l of lines) columns = Math.max(columns, l.text.length + 7 * (l.text.split('\t').length - 1)); // a tab is 8 columns
        return `calc(${columns}ch + ${GUTTERS_WIDTH}px)`;
    }, [lines]);

    const [body, setBody] = useState<HTMLDivElement | null>(null);
    const scrollMargin = useOffsetTop(body);
    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => body?.parentElement ?? null,
        estimateSize,
        overscan: 30,
        scrollMargin,
        scrollPaddingStart: HEADER_HEIGHT,
        paddingStart: BODY_PADDING,
        paddingEnd: BODY_PADDING,
    });

    // Sizes are kept by row index, so a new diff, view or set of threads starts from fresh estimates.
    useLayoutEffect(() => {
        virtualizer.measure();
    }, [virtualizer, estimateSize]);

    // [ and ] step through the hunks; a new diff starts again before the first.
    const hunkAt = useRef(-1);
    useEffect(() => {
        hunkAt.current = -1;
    }, [lines]);
    useImperativeHandle(ref, () => ({
        moveHunk(step: number) {
            const hunks = rows.flatMap((row, i) => (row.kind === 'hunk' ? [i] : []));
            if (!hunks.length) return;
            hunkAt.current = Math.min(Math.max(hunkAt.current + step, 0), hunks.length - 1);
            virtualizer.scrollToIndex(hunks[hunkAt.current], {align: 'start', behavior: 'smooth'});
        },
        // The hunk of the first row below the sticky header.
        hunkInView() {
            const top = (virtualizer.scrollOffset ?? 0) + HEADER_HEIGHT;
            const first = virtualizer.getVirtualItems().find(item => item.end > top);
            return hunkOfRow(rows, first?.index ?? 0);
        },
    }), [rows, virtualizer]);

    // Each jump runs once: scroll its line to the middle and flash it, or ask for the whole file.
    const jumped = useRef(0);
    const [flash, setFlash] = useState<{index: number; id: number} | null>(null);
    useEffect(() => {
        if (!jump || jumped.current === jump.id || !lines.length) return;
        const index = jump.side === 'LEFT'
            ? rows.findIndex(row => rowTargets(row).some(t => t.side === 'LEFT' && t.line === jump.line))
            : rows.findIndex(row => row.kind !== 'hunk' && row.newNo === jump.line);
        if (index < 0) {
            if (jump.side === 'RIGHT' && !visibleLines.has(jump.line) && onJumpOutside) onJumpOutside();
            return;
        }
        jumped.current = jump.id;
        virtualizer.scrollToIndex(index, {align: 'center'});
        setFlash({index, id: jump.id});
    }, [jump, lines, rows, visibleLines, onJumpOutside, virtualizer]);
    const orphans = threads.filter(t => !visibleLines.has(t.line));

    const orphanBlock = orphans.length > 0 && (
        <div className="thread-orphans">
            {orphans.map((t, i) => <InlineThread key={`orphan-${i}`} thread={t} check={threadChecks[t.id]} onOpenURL={onOpenURL} controls={threadControls}/>)}
        </div>
    );

    if (!lines.length) {
        return (
            <>
                {orphanBlock}
                <div className="empty"><div className="empty-hint">No textual changes (binary file, mode-only change, or only whitespace).</div></div>
            </>
        );
    }

    return (
        <>
            {orphanBlock}
            <div
                ref={setBody}
                className={split ? 'diff-body split' : 'diff-body'}
                style={{height: virtualizer.getTotalSize(), minWidth: split ? undefined : width}}
            >
                {virtualizer.getVirtualItems().map(item => {
                    const row = rows[item.index];
                    const flashed = flash?.index === item.index ? flash.id : 0;
                    const rowThreads = threadsOf(row);
                    const extra = draftsOf(row);
                    const focused = focus && extra.targets.some(t => t.side === focus.side && t.line === focus.line) ? focus.side : undefined;
                    return (
                        <div
                            key={item.key}
                            data-index={item.index}
                            data-focus={focused}
                            ref={rowThreads.length || extra.drafts.length || extra.findings.length || extra.adding ? virtualizer.measureElement : undefined}
                            className="diff-row"
                            style={{transform: `translateY(${item.start - scrollMargin}px)`}}
                            onClick={e => {
                                // A click on a line focuses it for c; clicks in threads and drafts are theirs.
                                if (!(e.target instanceof Element) || e.target.closest('.cmt-thread, .draft-stack, .finding')) return;
                                const target = focusFor(row, e.target.closest('.half.left') ? 'left' : 'right');
                                if (target) onFocusLine(target);
                            }}
                        >
                            <DiffRowView key={flashed} row={row} tokens={tokens} flashed={flashed > 0}/>
                            {rowThreads.map((t, j) => (
                                <InlineThread key={`${item.index}-${j}`} thread={t} check={threadChecks[t.id]} onOpenURL={onOpenURL} controls={threadControls}/>
                            ))}
                            {extra.findings.length > 0 && (
                                <div className="inline-drafts">
                                    {extra.findings.map(f => <FindingCard key={f.key} finding={f} focused={f.key === focusedFinding} controls={findingControls}/>)}
                                </div>
                            )}
                            {(extra.drafts.length > 0 || extra.adding) && (
                                <div className="inline-drafts">
                                    <DraftStack
                                        drafts={extra.drafts}
                                        editing={composer?.kind === 'edit' ? composer.id : null}
                                        adding={extra.adding}
                                        label={draftLabel}
                                        placeholder="Comment on this line"
                                        controls={draftControls}
                                    />
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </>
    );
});

// useOffsetTop follows where el sits in its scrolling parent, as the panels above it open and close.
function useOffsetTop(el: HTMLElement | null): number {
    const [top, setTop] = useState(0);
    useLayoutEffect(() => {
        const parent = el?.parentElement;
        if (!el || !parent) return;
        const update = () => setTop(el.offsetTop);
        const resize = new ResizeObserver(update);
        const watch = () => {
            resize.disconnect();
            for (const child of parent.children) {
                if (child !== el) resize.observe(child);
            }
        };
        const children = new MutationObserver(() => {
            watch();
            update();
        });
        update();
        watch();
        children.observe(parent, {childList: true});
        return () => {
            resize.disconnect();
            children.disconnect();
        };
    }, [el]);
    return top;
}

// DiffRowView draws one row: a hunk header, a unified line or a split pair.
function DiffRowView({row, tokens, flashed}: {row: DiffRow; tokens: Map<Line, Token[]>; flashed: boolean}) {
    switch (row.kind) {
        case 'hunk':
            return <div className="line hunk" data-hunk={row.hunk}>{row.text}</div>;
        case 'line':
            return <UnifiedLine line={row.line} tokens={tokens.get(row.line)} flashed={flashed}/>;
        case 'pair':
            return <SplitRowView row={row.row} tokens={tokens} flashed={flashed}/>;
        default: {
            const _exhaustive: never = row;
            return _exhaustive;
        }
    }
}

// InlineThread is one review thread, drawn under the diff line it is attached to.
function InlineThread({thread, check, onOpenURL, controls}: {
    thread: PRThread;
    check: ThreadCheck | undefined; // Claude's read, when a push may have answered it
    onOpenURL: (url: string) => void;
    controls: ThreadControls | null;
}) {
    return (
        <div className={`cmt-thread inline-thread${thread.resolved ? ' resolved' : ''}`}>
            <div className="cmt-meta">
                <span>{thread.resolved ? 'resolved' : 'open'}</span>
                {thread.outdated && <span className="cmt-tag">outdated</span>}
                <span className="spacer"/>
                {thread.url && <Button variant="link"  onClick={() => onOpenURL(thread.url)}>Open on GitHub</Button>}
            </div>
            {thread.comments.map((c, i) => <CommentBody key={i} comment={c}/>)}
            {check && <ThreadCheckView check={check}/>}
            {controls && <ThreadActions thread={thread} controls={controls}/>}
        </div>
    );
}

const UnifiedLine = memo(function UnifiedLine({line, tokens, flashed}: {line: Line; tokens?: Token[]; flashed: boolean}) {
    const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
    return (
        <div className={`line ${line.kind}${flashed ? ' jumped' : ''}`} data-new={line.kind === 'del' ? undefined : line.newNo}>
            <span className="gutter">{line.oldNo ?? ''}</span>
            <span className="gutter">{line.newNo ?? ''}</span>
            <span className="sign">{line.kind === 'meta' ? '' : sign}</span>
            <Content line={line} tokens={tokens}/>
        </div>
    );
});

const SplitRowView = memo(function SplitRowView({row, tokens, flashed}: {row: SplitRow; tokens: Map<Line, Token[]>; flashed: boolean}) {
    return (
        <div className="split-row">
            <div className={`half left ${row.left?.kind ?? 'none'}`}>
                <span className="gutter">{row.left?.oldNo ?? ''}</span>
                <Content line={row.left} tokens={row.left ? tokens.get(row.left) : undefined}/>
            </div>
            <div className={`half right ${row.right?.kind ?? 'none'}${flashed ? ' jumped' : ''}`} data-new={row.right?.newNo}>
                <span className="gutter">{row.right?.newNo ?? ''}</span>
                <Content line={row.right} tokens={row.right ? tokens.get(row.right) : undefined}/>
            </div>
        </div>
    );
});

// Content draws a line's text in its syntax colours, with the changed part of a paired line marked.
function Content({line, tokens}: {line: Line | null; tokens?: Token[]}) {
    if (!line) return <span className="content"/>;
    if (!line.text) return <span className="content"> </span>;
    return (
        <span className="content">
            {paint(tokens ?? [{text: line.text}], line.segs).map((piece, i) => (
                // Plain text needs no element of its own; a large diff draws far fewer nodes.
                piece.changed || piece.color
                    ? (
                        <span key={i} className={piece.changed ? 'word' : undefined} style={piece.color ? {color: piece.color} : undefined}>
                            {piece.text}
                        </span>
                    )
                    : <Fragment key={i}>{piece.text}</Fragment>
            ))}
        </span>
    );
}

const STATUS_LABEL: Record<string, string> = {
    A: 'Added',
    M: 'Modified',
    D: 'Deleted',
    R: 'Renamed',
};

// The shortcut list, shown with ? and kept in step with the key handler above.
const SHORTCUT_GROUPS: {title: string; rows: [string, string][]}[] = [
    {title: 'Pull requests', rows: [
        ['↑ ↓', 'Move through the list'],
        ['Enter', 'Open the pull request, branch or commit'],
        ['p', 'Back to all pull requests'],
        ['⇧C', 'Show comments'],
    ]},
    {title: 'Files', rows: [
        ['↑ ↓', 'Previous or next file'],
        ['/', 'Filter'],
        ['⌘P', 'Go to file'],
        ['⇧⌘F', 'Search in the changed files'],
        ['o', 'Open file in the default editor (read-only at the head for a pull request)'],
        ['g', 'Group files by state, or show them by folder'],
    ]},
    {title: 'Reviewing', rows: [
        ['x', 'Mark reviewed here and on GitHub, then go to the next file'],
        ['⌘-click', 'Add or remove a file from the selection'],
        ['⇧-click', 'Select a range of files'],
        ['Esc', 'Close the Claude panel (stopping Claude), clear the selection, or the focused line'],
        ['c', 'Comment on the line you clicked, or on the file'],
        ['⌘↵', 'Finish review; in the Finish sheet, submit'],
        ['⇧B', "Show or hide Claude's brief"],
        ['e', 'Claude explains the hunk around the line you clicked, or the first hunk in view'],
        ['a', 'Ask Claude about this change'],
        ['f ⇧F', "Next or previous Claude finding"],
        ['y', 'Accept the focused finding as a draft comment you can edit'],
        ['d', 'Dismiss the focused finding for this head'],
        ['⌘⇧P', 'In a draft comment, Claude polishes it; you accept or keep yours'],
    ]},
    {title: 'Diff', rows: [
        ['[ ]', 'Previous or next hunk'],
        ['v', 'Split or unified view'],
        ['b', 'Ignore whitespace'],
        ['s', 'Whole pull request, or only the changes since your review'],
        ['n', 'Note for the file'],
    ]},
    {title: 'App', rows: [
        ['⌘K', 'All commands'],
        ['t', 'Run a command, and see the pull request\'s checks'],
        ['r', 'Refresh'],
        ['?', 'Show or hide this list'],
    ]},
];

function ShortcutsSheet({onClose}: {onClose: () => void}) {
    return (
        <div className="overlay" onClick={onClose}>
            <div className="shortcuts" role="dialog" aria-label="Keyboard shortcuts" onClick={e => e.stopPropagation()}>
                <div className="shortcuts-head">
                    <span>Keyboard shortcuts</span>
                    <Button size="icon"  onClick={onClose} aria-label="Close">×</Button>
                </div>
                {SHORTCUT_GROUPS.map(group => (
                    <section key={group.title} className="shortcuts-group">
                        <h3>{group.title}</h3>
                        <dl>
                            {group.rows.map(([keys, what]) => (
                                <div key={keys} className="shortcuts-row">
                                    <dt><kbd>{keys}</kbd></dt>
                                    <dd>{what}</dd>
                                </div>
                            ))}
                        </dl>
                    </section>
                ))}
            </div>
        </div>
    );
}

// isTyping: the key went to a text box, so single-letter shortcuts stay out of its way.
function isTyping(target: EventTarget | null): boolean {
    return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
}

function parentOf(path: string) {
    return path.replace(/[\\/][^\\/]*$/, '');
}

// flattenFiles lists the files in the order the tree shows them, skipping the
// contents of collapsed folders so arrow keys match what is on screen.
function flattenFiles(nodes: TreeNode[], collapsed: Set<string>): FileChange[] {
    return nodes.flatMap(n => {
        if (n.file) return [n.file];
        return collapsed.has(n.path) ? [] : flattenFiles(n.children, collapsed);
    });
}

export default App;
