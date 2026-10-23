import {Fragment, type MouseEvent as ReactMouseEvent, type ReactNode, useEffect, useMemo, useRef, useState} from 'react';
import './App.css';
import {
    Changes,
    Commits,
    Conflicts,
    DetectBase,
    Diff,
    ExportPatch,
    Fingerprint,
    History,
    OpenInZed,
    OpenPR,
    PRComments,
    PRStatus,
    RecordHistory,
    Refs,
    CheckUpdate,
    ResolveRepo,
    Stamps,
    SyncReviewed,
    TakePendingRepo,
    Worktrees,
} from '../wailsjs/go/main/App';
import {BrowserOpenURL, EventsOn} from '../wailsjs/runtime/runtime';
import {parseDiff, toSplitRows, Line, SplitRow} from './diff';
import {CommandPanel, CommentBody, CommentsPanel, PRBanner, PRDiscussion, PRThread, PRView, QuickOpen, UpdateBanner} from './panels';
import {buildTree, FileChange, SortMode, TreeNode} from './tree';
import type {main} from '../wailsjs/go/models';
import {basename, buildMarkdown} from './util';
import {RepoPicker} from './repo-picker';
import {Landing} from './landing';
import {TerminalPanel} from './terminal';

const PREFERRED_BASES = ['main', 'staging', 'master'];
const POLL_MS = 3000;
const PR_POLL_MS = 60000;

// Remembered state is a convenience, so every access is guarded.
// UPDATE_DISMISSED_KEY holds the release the user chose to skip.
const UPDATE_DISMISSED_KEY = 'git-tree-compare:update-dismissed';

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

type HistoryItem = {repo: string; base: string; file: string; openedAt: string};
type WorktreeItem = {path: string; branch: string; head: string; detached: boolean; bare: boolean};
type CommitItem = {hash: string; short: string; subject: string; author: string; date: string};
type OpenRequest = {repo?: string; base?: string; error?: string};

function App() {
    const [repo, setRepo] = useState(() => readStore('git-tree-compare:last', {repo: ''}).repo);
    const [refs, setRefs] = useState<string[]>([]);
    const [refLabels, setRefLabels] = useState<Record<string, string>>({}); // ref name -> how to show it
    const [prBase, setPrBase] = useState<main.PRBase | null>(null);
    const [onlyConflicts, setOnlyConflicts] = useState(false);
    const [helpOpen, setHelpOpen] = useState(false);
    const [landing, setLanding] = useState(true); // the start screen, until a repository opens
    const [termOpen, setTermOpen] = useState(false);
    const [termStarted, setTermStarted] = useState(false); // the shell starts the first time the dock opens
    const [picked, setPicked] = useState<string[]>([]); // multi-selection, in tree order; empty means just `selected`
    const pickedSet = useMemo(() => new Set(picked), [picked]);
    const [base, setBase] = useState(() => readStore('git-tree-compare:last', {base: ''}).base);
    const [commit, setCommit] = useState(''); // '' means the working tree
    const [commits, setCommits] = useState<CommitItem[]>([]);
    const [ignoreWS, setIgnoreWS] = useState(() => readStore('git-tree-compare:ignoreWS', false));
    const [worktrees, setWorktrees] = useState<WorktreeItem[]>([]);
    const [changes, setChanges] = useState<FileChange[]>([]);
    const [conflicts, setConflicts] = useState<string[]>([]);
    const [selected, setSelected] = useState<FileChange | null>(null);
    const [diff, setDiff] = useState('');
    const [filter, setFilter] = useState('');
    const [sort, setSort] = useState<SortMode>(() => readStore<SortMode>('git-tree-compare:sort', 'name'));
    const [split, setSplit] = useState(() => readStore('git-tree-compare:split', false));
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const [reviewed, setReviewed] = useState<Record<string, string>>({});
    const [notes, setNotes] = useState<Record<string, string>>({});
    const [noteOpen, setNoteOpen] = useState(false);
    const [pr, setPr] = useState<PRView | null>(null);
    const [prSeen, setPrSeen] = useState('');
    const [discussion, setDiscussion] = useState<PRDiscussion | null>(null); // review comments on the open PR
    const [commentsOpen, setCommentsOpen] = useState(false);
    const [commentsLoading, setCommentsLoading] = useState(false);
    const [update, setUpdate] = useState<main.UpdateInfo | null>(null); // a newer release, if one exists
    const [quickOpen, setQuickOpen] = useState(false);
    const [picking, setPicking] = useState(false);
    const [recent, setRecent] = useState<string[]>([]);
    const [pickError, setPickError] = useState('');
    const [cmdOpen, setCmdOpen] = useState(false);
    const [history, setHistory] = useState<HistoryItem[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const [error, setError] = useState('');
    const [flash, setFlash] = useState('');

    // Values read inside effects and handlers, without re-running them.
    const wantBase = useRef<string | null>(null); // base from the command line, used once
    const wantFile = useRef<string | null>(null); // file from a history entry, selected once
    const reviewedRef = useRef<Record<string, string>>({});
    const fingerprint = useRef<string | null>(null);
    const filterInput = useRef<HTMLInputElement>(null);
    const hunk = useRef(-1);

    const scope = useMemo(() => ({repo, base, commit, ignoreWS}), [repo, base, commit, ignoreWS]);
    const inWorkingTree = commit === '';

    const visibleChanges = useMemo(() => {
        const q = filter.trim().toLowerCase();
        const byName = q ? changes.filter(c => c.path.toLowerCase().includes(q)) : changes;
        return onlyConflicts && conflicts.length ? byName.filter(c => conflicts.includes(c.path)) : byName;
    }, [changes, filter, onlyConflicts, conflicts]);
    const tree = useMemo(() => buildTree(visibleChanges, sort), [visibleChanges, sort]);
    const files = useMemo(() => flattenFiles(tree, collapsed), [tree, collapsed]);
    const conflictSet = useMemo(() => new Set(conflicts), [conflicts]);
    // Open review threads per file, shown as a count on the tree row.
    const commentCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const t of discussion?.threads ?? []) {
            if (!t.resolved) counts[t.path] = (counts[t.path] ?? 0) + 1;
        }
        return counts;
    }, [discussion]);
    const unresolvedCount = Object.values(commentCounts).reduce((sum, n) => sum + n, 0);
    const updateBanner = update && (
        <UpdateBanner update={update} onOpen={() => BrowserOpenURL(update.url)} onLater={dismissUpdate}/>
    );
    // Review threads on the selected file, shown inline in its diff.
    const fileThreads = useMemo(
        () => (selected ? (discussion?.threads ?? []).filter(t => t.path === selected.path) : []),
        [discussion, selected],
    );
    const reviewedCount = changes.filter(c => reviewed[c.path]).length;
    const totals = useMemo(() => sumChanges(changes), [changes]);
    const currentWorktree = worktrees.find(w => w.path === repo);
    const newPrCommits = !!pr && prSeen !== '' && pr.headRefOid !== prSeen;

    function showFlash(message: string) {
        setFlash(message);
        setTimeout(() => setFlash(''), 2500);
    }

    function updateReviewed(next: Record<string, string>) {
        reviewedRef.current = next;
        setReviewed(next);
        writeStore(`git-tree-compare:reviewed:${repo}|${base}`, next);
    }

    function updateNote(path: string, text: string) {
        const next = {...notes};
        if (text.trim()) next[path] = text;
        else delete next[path];
        setNotes(next);
        writeStore(`git-tree-compare:notes:${repo}`, next);
    }

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

    // Requests from the command line: first launch (pending) and later launches (event).
    useEffect(() => {
        function apply(req: OpenRequest | null) {
            if (!req) return;
            if (req.error) setError(req.error);
            if (req.base) wantBase.current = req.base;
            if (req.repo) {
                setRepo(req.repo);
                setLanding(false);
            }
        }
        TakePendingRepo().then(apply).catch(() => {});
        const off = EventsOn('repo:open', (req: OpenRequest) => apply(req));
        const offError = EventsOn('repo:error', (msg: string) => setError(msg));
        return () => {
            off();
            offError();
        };
    }, []);

    // The start screen lists recent repositories too.
    useEffect(() => {
        History().then(items => setRecent(recentRepos(items))).catch(() => {});
    }, []);

    // The in-app picker lists recent repositories from history.
    async function chooseRepo() {
        setPickError('');
        setRecent(recentRepos(await History().catch(() => [])));
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

    // Per-repo state, and the base: explicit flag, then the open PR's base,
    // then the base already chosen, then a common default.
    useEffect(() => {
        if (!repo) return;
        setCollapsed(new Set(readStore<string[]>(`git-tree-compare:collapsed:${repo}`, [])));
        setNotes(readStore<Record<string, string>>(`git-tree-compare:notes:${repo}`, {}));
        fingerprint.current = null;
        Worktrees(repo)
            .then(list => setWorktrees(list.filter(w => !w.bare)))
            .catch(() => setWorktrees([]));
        Promise.all([Refs(repo), DetectBase(repo).catch(() => null)])
            .then(([list, found]) => {
                // The pull request's base commit is the default: it is what GitHub compares against.
                const prCommit = found?.commit ?? '';
                const all = prCommit && !list.includes(prCommit) ? [prCommit, ...list] : list;
                setRefs(all);
                setPrBase(found ?? null);
                setRefLabels(found && prCommit ? {[prCommit]: baseLabel(found)} : {});
                const explicit = wantBase.current;
                wantBase.current = null;
                if (explicit && !all.includes(explicit)) {
                    showFlash(`Base ${shortBase(explicit)} is not in this repository, so the default base is used.`);
                }
                setBase(current => {
                    if (explicit && all.includes(explicit)) return explicit;
                    if (prCommit) return prCommit;
                    if (all.includes(current)) return current;
                    return PREFERRED_BASES.find(b => all.includes(b)) ?? all[0] ?? '';
                });
            })
            .catch(e => setError(String(e)));
    }, [repo]);

    // The open pull request, refreshed every minute.
    useEffect(() => {
        if (!repo) return;
        let cancelled = false;
        const load = () => PRStatus(repo)
            .then(p => !cancelled && setPr(p ?? null))
            .catch(() => !cancelled && setPr(null));
        load();
        const timer = setInterval(load, PR_POLL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [repo]);

    // Checks GitHub for a newer release once at launch. Offline or without gh, it stays quiet.
    useEffect(() => {
        CheckUpdate()
            .then(info => {
                if (info.available && info.latest !== readStore<string>(UPDATE_DISMISSED_KEY, '')) setUpdate(info);
            })
            .catch(() => {});
    }, []);

    // Review comments for the open PR, so the banner can show how many are still open.
    useEffect(() => {
        if (!pr) {
            setDiscussion(null);
            return;
        }
        PRComments(repo).then(setDiscussion).catch(() => setDiscussion(null));
    }, [repo, pr?.number]);

    // Remember the PR head the user last saw, so new commits can be flagged.
    useEffect(() => {
        if (!repo || !pr) return;
        const key = `git-tree-compare:pr-seen:${repo}`;
        const seen = readStore<{number: number; head: string} | null>(key, null);
        if (!seen || seen.number !== pr.number) {
            writeStore(key, {number: pr.number, head: pr.headRefOid});
            setPrSeen(pr.headRefOid);
        } else {
            setPrSeen(seen.head);
        }
    }, [repo, pr?.number, pr?.headRefOid]);

    function markPrSeen() {
        if (!pr) return;
        writeStore(`git-tree-compare:pr-seen:${repo}`, {number: pr.number, head: pr.headRefOid});
        setPrSeen(pr.headRefOid);
    }

    // Commits between base and HEAD, for the commit scope.
    useEffect(() => {
        if (!repo || !base) return;
        setCommit('');
        Commits(repo, base).then(setCommits).catch(() => setCommits([]));
    }, [repo, base]);

    // Reviewed marks belong to one repo and base.
    useEffect(() => {
        if (!repo || !base) return;
        const saved = readStore<Record<string, string>>(`git-tree-compare:reviewed:${repo}|${base}`, {});
        reviewedRef.current = saved;
        setReviewed(saved);
        fingerprint.current = null;
    }, [repo, base]);

    // Reload changed files when the scope changes or on refresh. Keep the
    // selection if the file still changed, otherwise select the first file.
    // Drop reviewed marks for files saved since they were checked.
    useEffect(() => {
        if (!repo || !base) return;
        let cancelled = false;
        setLoading(true);
        Promise.all([
            Changes(scope),
            inWorkingTree ? Conflicts(repo, base).catch(() => [] as string[]) : Promise.resolve([] as string[]),
        ])
            .then(async ([list, conflictList]) => {
                if (cancelled) return;
                setChanges(list);
                setConflicts(conflictList ?? []);
                setError('');

                if (inWorkingTree) {
                    const marked = Object.keys(reviewedRef.current);
                    if (marked.length) {
                        const now = await Stamps(repo, marked);
                        if (cancelled) return;
                        const kept = Object.fromEntries(
                            marked.filter(p => now[p] === reviewedRef.current[p]).map(p => [p, now[p]]),
                        );
                        if (Object.keys(kept).length !== marked.length) updateReviewed(kept);
                    }
                }

                setSelected(prev => {
                    const want = wantFile.current;
                    wantFile.current = null;
                    const target = want ?? prev?.path;
                    return list.find(f => f.path === target) ?? list[0] ?? null;
                });
            })
            .catch(e => !cancelled && setError(String(e)))
            .finally(() => !cancelled && setLoading(false));
        return () => {
            cancelled = true;
        };
    }, [repo, base, commit, ignoreWS, reloadKey]);

    // Auto refresh: poll a cheap fingerprint of the working tree and reload on change.
    useEffect(() => {
        const timer = setInterval(() => {
            if (document.hidden || !repo || !base || loading || !inWorkingTree) return;
            Fingerprint(repo, base)
                .then(fp => {
                    if (fingerprint.current !== null && fp !== fingerprint.current) {
                        setReloadKey(k => k + 1);
                    }
                    fingerprint.current = fp;
                })
                .catch(() => {});
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [repo, base, loading, inWorkingTree]);

    useEffect(() => {
        writeStore('git-tree-compare:last', {repo, base});
    }, [repo, base]);

    useEffect(() => writeStore('git-tree-compare:sort', sort), [sort]);
    useEffect(() => writeStore('git-tree-compare:split', split), [split]);
    useEffect(() => writeStore('git-tree-compare:ignoreWS', ignoreWS), [ignoreWS]);

    useEffect(() => {
        if (!selected) {
            setDiff('');
            return;
        }
        let cancelled = false;
        hunk.current = -1;
        setNoteOpen(false);
        Diff(scope, selected.path)
            .then(text => !cancelled && setDiff(text))
            .catch(e => !cancelled && setError(String(e)));
        if (inWorkingTree) RecordHistory(repo, base, selected.path).catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [selected, repo, base, commit, ignoreWS]);

    // Keyboard: move between files, filter, quick open, run, open in Zed,
    // refresh, review, notes, whitespace, split, hunks.
    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (picking || landing) return;
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
                e.preventDefault();
                setQuickOpen(open => !open);
                return;
            }
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (quickOpen) return;
            const target = e.target as HTMLElement;
            const typing = target instanceof HTMLInputElement || target instanceof HTMLSelectElement
                || target instanceof HTMLTextAreaElement;

            if (e.key === '/' && !typing) {
                e.preventDefault();
                filterInput.current?.focus();
                return;
            }
            if (typing) return;

            switch (e.key) {
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
                    if (helpOpen) setHelpOpen(false);
                    else if (picked.length) setPicked([]);
                    return;
                case '?':
                    setHelpOpen(v => !v);
                    return;
                case 'o':
                    if (selected && selected.status !== 'D') openZed();
                    return;
                case 'r':
                    setReloadKey(k => k + 1);
                    return;
                case 'x':
                    if (inWorkingTree) {
                        const targets = picked.length ? picked : selected ? [selected.path] : [];
                        if (targets.length) setReviewedMany(targets);
                    }
                    return;
                case 'v':
                    setSplit(s => !s);
                    return;
                case 'b':
                    setIgnoreWS(v => !v);
                    return;
                case 'n':
                    if (selected) setNoteOpen(v => !v);
                    return;
                case 't':
                    setCmdOpen(v => !v);
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

    function moveHunk(step: number) {
        const hunks = document.querySelectorAll<HTMLElement>('[data-hunk]');
        if (!hunks.length) return;
        hunk.current = Math.min(Math.max(hunk.current + step, 0), hunks.length - 1);
        hunks[hunk.current].scrollIntoView({block: 'start', behavior: 'smooth'});
    }

    function toggleReviewed(path: string) {
        setReviewedMany([path]);
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
        setCommentsLoading(true);
        try {
            setDiscussion(await PRComments(repo));
        } catch (e) {
            setError(String(e));
        } finally {
            setCommentsLoading(false);
        }
    }

    // Opens a commented file's diff. Files outside this comparison have no diff to show.
    function openCommentFile(path: string) {
        const file = changes.find(c => c.path === path);
        if (!file) {
            showFlash(`${path} is not changed in this comparison. Pick the PR base to see it.`);
            return;
        }
        setSelected(file);
        setCommentsOpen(false);
    }

    // Marks the reviewed files as viewed on the open pull request.
    async function syncReviewed() {
        const paths = Object.keys(reviewed);
        if (!paths.length) {
            showFlash('No reviewed files to sync yet.');
            return;
        }
        try {
            const r = await SyncReviewed(repo, paths);
            const parts = [`marked ${r.marked} viewed on PR #${r.number}`];
            if (r.alreadyDone) parts.push(`${r.alreadyDone} already viewed`);
            if (r.notInPR) parts.push(`${r.notInPR} not changed in the PR`);
            showFlash(parts.join(', ') + '.');
        } catch (e) {
            setError(String(e));
        }
    }

    // Marks every path reviewed, or unmarks them all when they already are.
    function setReviewedMany(paths: string[]) {
        const current = reviewedRef.current;
        if (paths.every(p => current[p])) {
            const next = {...current};
            paths.forEach(p => delete next[p]);
            updateReviewed(next);
            return;
        }
        // Stamp the files now; a later save resets the mark.
        const todo = paths.filter(p => !current[p]);
        Stamps(repo, todo).then(stamps => {
            updateReviewed({...reviewedRef.current, ...stamps});
        });
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

    function switchWorktree(path: string) {
        if (path !== repo) setRepo(path);
    }

    async function openHistory() {
        setHistory(null);
        try {
            setHistory(await History());
        } catch (e) {
            setError(String(e));
            setHistory([]);
        }
    }

    function restore(item: HistoryItem) {
        wantFile.current = item.file;
        setHistory(null);
        if (item.repo !== repo) {
            // The repo's own load picks the base, and uses this one when it is still there.
            wantBase.current = item.base;
            setRepo(item.repo);
            return;
        }
        if (item.base === base) {
            setReloadKey(k => k + 1);
        } else if (refs.includes(item.base)) {
            setBase(item.base);
        } else {
            showFlash(`Base ${shortBase(item.base)} is not in this repository anymore. Keeping ${shortBase(base)}.`);
        }
    }

    async function openZed() {
        if (!selected) return;
        try {
            await OpenInZed(repo, selected.path);
        } catch (e) {
            setError(`Could not open Zed: ${e}`);
        }
    }

    async function openPR() {
        try {
            await OpenPR(repo);
        } catch (e) {
            setError(`Could not open the PR: ${e}`);
        }
    }

    async function exportPatch() {
        try {
            const path = await ExportPatch(scope);
            if (path) showFlash(`Saved ${path}`);
        } catch (e) {
            setError(`Could not save the patch: ${e}`);
        }
    }

    async function copySummary() {
        const md = buildMarkdown({
            repo,
            base,
            scopeLabel: inWorkingTree ? 'working tree' : `commit ${commits.find(c => c.hash === commit)?.short ?? ''}`,
            files: changes,
            reviewed,
            notes,
        });
        try {
            await navigator.clipboard.writeText(md);
            showFlash('Summary copied as Markdown');
        } catch {
            setError('Could not copy the summary');
        }
    }

    return (
        <div id="app">
            <header className="toolbar">
                <button className="btn" onClick={chooseRepo}>Open repo…</button>
                <div className="repo" title={repo}>{repo ? basename(repo) : 'No repository'}</div>
                {worktrees.length > 1 && (
                    <select className="worktree" value={repo} onChange={e => switchWorktree(e.target.value)} title="Worktree">
                        {worktrees.map(w => (
                            <option key={w.path} value={w.path}>{worktreeLabel(w)}</option>
                        ))}
                    </select>
                )}
                <div className="spacer"/>
                <label className="base">
                    <span>Compare against</span>
                    <select value={base} onChange={e => setBase(e.target.value)} disabled={!refs.length}>
                        {refs.map(r => <option key={r} value={r}>{refLabels[r] ?? r}</option>)}
                    </select>
                </label>
                <label className="base">
                    <span>Scope</span>
                    <select value={commit} onChange={e => setCommit(e.target.value)} disabled={!repo}>
                        <option value="">Working tree</option>
                        {commits.map(c => (
                            <option key={c.hash} value={c.hash}>{c.short} {c.subject}</option>
                        ))}
                    </select>
                </label>
                <button className="btn" onClick={() => setQuickOpen(true)} disabled={!files.length} title="Go to file (⌘P)">Go to file</button>
                <button className="btn" onClick={openHistory} disabled={!!history} title="Past comparisons">History</button>
                <button
                    className="btn icon"
                    onClick={() => setReloadKey(k => k + 1)}
                    disabled={!repo || loading}
                    title="Refresh (r)"
                    aria-label="Refresh"
                >↻</button>
            </header>

            {updateBanner}

            {pr && (
                <PRBanner
                    pr={pr}
                    newCommits={newPrCommits}
                    onOpen={openPR}
                    onSeen={markPrSeen}
                    unresolved={unresolvedCount}
                    onSync={inWorkingTree ? syncReviewed : undefined}
                    onComments={toggleComments}
                />
            )}

            {changes.length > 0 && (
                <div className="summary">
                    <span>{changes.length} changed</span>
                    <span className="added">+{totals.added}</span>
                    <span className="deleted">−{totals.deleted}</span>
                    {(['A', 'M', 'D', 'R', 'U'] as const).filter(s => changes.some(c => c.status === s)).map(s => (
                        <span key={s} className={`chip status-${s}`}>{s} {changes.filter(c => c.status === s).length}</span>
                    ))}
                    {inWorkingTree && <span className="reviewed-count">{reviewedCount}/{changes.length} reviewed</span>}
                    {currentWorktree?.branch && <span className="hint">on {currentWorktree.branch}</span>}
                    <label className="check">
                        <input type="checkbox" checked={ignoreWS} onChange={e => setIgnoreWS(e.target.checked)}/>
                        Ignore whitespace (b)
                    </label>
                    <label className="sort">
                        Sort
                        <select value={sort} onChange={e => setSort(e.target.value as SortMode)}>
                            <option value="name">name</option>
                            <option value="size">changes</option>
                        </select>
                    </label>
                    <button className="btn" onClick={() => setCmdOpen(v => !v)} title="Run a command (t)">Run</button>
                    <button className="btn" onClick={copySummary} title="Copy the file list as Markdown">Copy summary</button>
                    <button className="btn" onClick={exportPatch} title="Save the diff as a .patch file">Export patch</button>
                </div>
            )}

            {inWorkingTree && prBase && !prBase.fetched && prBase.name && (
                <div className="warn" role="status">
                    <span>⚠ The PR base {prBase.name} is not in this clone, so the comparison may be out of date.</span>
                    <code>git fetch origin {prBase.name}</code>
                </div>
            )}

            {inWorkingTree && conflicts.length > 0 && (
                <div className="warn" role="status">
                    <span>⚠ {conflicts.length} file{conflicts.length > 1 ? 's' : ''} would conflict with {refLabels[base] ?? base} if merged.</span>
                    <button className="btn" onClick={() => setOnlyConflicts(v => !v)}>
                        {onlyConflicts ? 'Show all files' : 'Show only conflicts'}
                    </button>
                </div>
            )}

            {flash && <div className="flash" role="status">{flash}</div>}

            {error && (
                <div className="error" role="alert">
                    <span>{error}</span>
                    <button className="btn icon" onClick={() => setError('')} aria-label="Dismiss">×</button>
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

            {history && <HistoryPanel items={history} onPick={restore} onClose={() => setHistory(null)}/>}

            {quickOpen && (
                <QuickOpen
                    files={files}
                    onClose={() => setQuickOpen(false)}
                    onPick={file => {
                        setSelected(file);
                        setQuickOpen(false);
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

            <div className="panes">
                <aside className="tree">
                    {repo && changes.length > 0 && (
                        <div className="tree-head">
                            <input
                                ref={filterInput}
                                className="filter"
                                type="search"
                                placeholder="Filter files (/)"
                                value={filter}
                                onChange={e => setFilter(e.target.value)}
                            />
                            {selected && inWorkingTree && (
                                <button
                                    className="btn"
                                    onClick={() => toggleReviewed(selected.path)}
                                    title="Mark reviewed (x)"
                                >
                                    {reviewed[selected.path] ? '☑ Reviewed' : '☐ Reviewed'}
                                </button>
                            )}
                        </div>
                    )}
                    {repo && changes.length > 0 && inWorkingTree && picked.length > 1 && (
                        <div className="tree-select" role="status">
                            <span>{picked.length} selected</span>
                            <button className="btn" onClick={() => setReviewedMany(picked)}>
                                {picked.every(p => reviewed[p]) ? 'Unmark all' : 'Mark all reviewed'}
                            </button>
                            <button className="btn" onClick={() => setPicked([])} title="Clear selection (Esc)">Clear</button>
                        </div>
                    )}
                    {!repo && (
                        <Empty title="Pick a repository" hint="Compare its working tree against a branch, tag or commit.">
                            <button className="btn" onClick={chooseRepo}>Open repo…</button>
                        </Empty>
                    )}
                    {repo && loading && changes.length === 0 && <div className="empty">Loading…</div>}
                    {repo && !loading && changes.length === 0 && (
                        <Empty title="No changes" hint={base ? `Nothing differs from ${base}.` : 'Pick a base to compare against.'}/>
                    )}
                    {repo && changes.length > 0 && visibleChanges.length === 0 && (
                        <Empty title="No matches" hint={`Nothing matches "${filter}".`}/>
                    )}
                    {tree.length > 0 && (
                        <TreeList
                            nodes={tree}
                            selectedPath={selected?.path}
                            picked={pickedSet}
                            collapsed={collapsed}
                            reviewed={inWorkingTree ? reviewed : {}}
                            notes={notes}
                            comments={commentCounts}
                            conflicts={inWorkingTree ? conflictSet : new Set()}
                            onToggle={toggleFolder}
                            onToggleReviewed={toggleReviewed}
                            onPick={pickFile}
                        />
                    )}
                </aside>
                <main className="diff">
                    {commentsOpen && (
                        <CommentsPanel
                            discussion={discussion}
                            loading={commentsLoading}
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
                            onClose={() => setCmdOpen(false)}
                        />
                    )}
                    {selected
                        ? <DiffPanel
                            file={selected}
                            text={diff}
                            split={split}
                            note={notes[selected.path] ?? ''}
                            noteOpen={noteOpen}
                            onToggleNote={() => setNoteOpen(v => !v)}
                            onNote={text => updateNote(selected.path, text)}
                            onToggleSplit={() => setSplit(s => !s)}
                            onOpenZed={openZed}
                            threads={fileThreads}
                            onOpenURL={BrowserOpenURL}
                        />
                        : <Empty title="No file selected" hint="Choose a file in the tree to see its diff."/>}
                </main>
            </div>

            {repo && termStarted && (
                <div className="terminal-dock" hidden={!termOpen}>
                    <TerminalPanel repo={repo} visible={termOpen}/>
                </div>
            )}
        </div>
    );
}

function Empty({title, hint, children}: {title: string; hint?: string; children?: ReactNode}) {
    return (
        <div className="empty">
            <div className="empty-title">{title}</div>
            {hint && <div className="empty-hint">{hint}</div>}
            {children}
        </div>
    );
}

function HistoryPanel({items, onPick, onClose}: {
    items: HistoryItem[];
    onPick: (item: HistoryItem) => void;
    onClose: () => void;
}) {
    return (
        <div className="history" role="dialog" aria-label="Past comparisons">
            <div className="history-head">
                <span>Past comparisons</span>
                <button className="btn icon" onClick={onClose} aria-label="Close">×</button>
            </div>
            {items.length === 0 && <div className="empty-hint">Nothing yet. Open a file to start history.</div>}
            <ul>
                {items.map(item => (
                    <li key={`${item.repo}\u0000${item.base}`}>
                        <button className="history-item" onClick={() => onPick(item)}>
                            <span className="history-main">{basename(item.repo)} vs {item.base}</span>
                            <span className="history-sub">{item.file || 'no file'} · {formatTime(item.openedAt)}</span>
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
}

type TreeProps = {
    selectedPath?: string;
    picked: Set<string>;
    collapsed: Set<string>;
    reviewed: Record<string, string>;
    notes: Record<string, string>;
    comments: Record<string, number>;
    conflicts: Set<string>;
    onToggle: (path: string) => void;
    onToggleReviewed: (path: string) => void;
    onPick: (file: FileChange, e: ReactMouseEvent) => void;
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
        const file = node.file;
        const active = file.path === rest.selectedPath;
        const isReviewed = !!rest.reviewed[file.path];
        const classes = ['row', 'file', active && 'active', rest.picked.has(file.path) && 'picked', node.generated && 'generated', isReviewed && 'reviewed']
            .filter(Boolean).join(' ');
        return (
            <li>
                <div className={classes} style={indent} onClick={e => rest.onPick(file, e)} aria-selected={active}>
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
                    <span className="name" title={file.path}>{node.name}</span>
                    {rest.notes[file.path] && <span className="note-dot" title="Has a note">●</span>}
                    {rest.comments[file.path] > 0 && (
                        <span className="cmt-count" title="Open review comments on GitHub">{rest.comments[file.path]}</span>
                    )}
                    {rest.conflicts.has(file.path) && <span className="conflict" title="Conflicts with base">⚠</span>}
                    <span className="counts"><span className="added">+{file.added}</span> <span className="deleted">−{file.deleted}</span></span>
                </div>
            </li>
        );
    }

    const open = !rest.collapsed.has(node.path);
    return (
        <li>
            <div className="row folder" style={indent} onClick={() => rest.onToggle(node.path)}>
                <span className="caret">{open ? '▾' : '▸'}</span>
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
                    conflicts={rest.conflicts}
                    onToggle={rest.onToggle}
                    onToggleReviewed={rest.onToggleReviewed}
                    onPick={rest.onPick}
                />
            )}
        </li>
    );
}

function DiffPanel(props: {
    file: FileChange;
    text: string;
    split: boolean;
    note: string;
    noteOpen: boolean;
    onToggleNote: () => void;
    onNote: (text: string) => void;
    onToggleSplit: () => void;
    onOpenZed: () => void;
    threads: PRThread[];
    onOpenURL: (url: string) => void;
}) {
    const {file, text, split, note, noteOpen} = props;
    const [copied, setCopied] = useState(false);

    async function copyPath() {
        try {
            await navigator.clipboard.writeText(file.path);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
        } catch {
            // Clipboard can be blocked; nothing else to do.
        }
    }

    return (
        <>
            <div className="diff-header">
                <span className={`chip status-${file.status}`} title={STATUS_LABEL[file.status]}>{STATUS_LABEL[file.status]}</span>
                <div className="diff-title">
                    <div className="diff-path">{file.path}</div>
                    {file.oldPath && <div className="diff-old">renamed from {file.oldPath}</div>}
                </div>
                <button className="btn" onClick={props.onToggleNote} title="Note (n)">{noteOpen ? 'Hide note' : 'Note'}</button>
                <button className="btn" onClick={props.onToggleSplit} title="Toggle split view (v)">
                    {split ? 'Unified' : 'Split'}
                </button>
                <button className="btn" onClick={props.onOpenZed} disabled={file.status === 'D'} title="Open in Zed (o)">Open in Zed</button>
                <button className="btn" onClick={copyPath}>{copied ? 'Copied' : 'Copy path'}</button>
            </div>
            {noteOpen && (
                <textarea
                    className="note"
                    placeholder="A note for this file. It is saved on this machine and included in the Markdown summary."
                    value={note}
                    onChange={e => props.onNote(e.target.value)}
                />
            )}
            <DiffView text={text} split={split} threads={props.threads} onOpenURL={props.onOpenURL}/>
        </>
    );
}

// DiffView draws the file's diff. Review threads sit under their line on the new side.
// A thread whose line is not in the diff (outdated, or the file changed since) is listed at the top.
function DiffView({text, split, threads, onOpenURL}: {
    text: string;
    split: boolean;
    threads: PRThread[];
    onOpenURL: (url: string) => void;
}) {
    const lines = useMemo(() => parseDiff(text), [text]);
    const rows = useMemo(() => (split ? toSplitRows(lines) : []), [lines, split]);
    const byLine = useMemo(() => {
        const map = new Map<number, PRThread[]>();
        for (const t of threads) map.set(t.line, [...(map.get(t.line) ?? []), t]);
        return map;
    }, [threads]);
    const visibleLines = useMemo(() => new Set(lines.map(l => l.newNo)), [lines]);
    const orphans = threads.filter(t => !visibleLines.has(t.line));

    function threadsAt(newNo?: number) {
        if (newNo === undefined) return null;
        return (byLine.get(newNo) ?? []).map((t, j) => (
            <InlineThread key={`${newNo}-${j}`} thread={t} onOpenURL={onOpenURL}/>
        ));
    }

    const orphanBlock = orphans.length > 0 && (
        <div className="thread-orphans">
            {orphans.map((t, i) => <InlineThread key={`orphan-${i}`} thread={t} onOpenURL={onOpenURL}/>)}
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

    if (split) {
        let hunkIndex = -1;
        return (
            <>
                {orphanBlock}
                <div className="diff-body split">
                    {rows.map((row, i) => {
                        if (row.hunk) hunkIndex++;
                        return (
                            <Fragment key={i}>
                                <SplitRowView row={row} hunkIndex={hunkIndex}/>
                                {threadsAt(row.right?.newNo)}
                            </Fragment>
                        );
                    })}
                </div>
            </>
        );
    }

    let hunkIndex = -1;
    return (
        <>
            {orphanBlock}
            <div className="diff-body">
                {lines.map((line, i) => {
                    if (line.kind === 'hunk') {
                        hunkIndex++;
                        return <div key={i} className="line hunk" data-hunk={hunkIndex}>{line.text}</div>;
                    }
                    return (
                        <Fragment key={i}>
                            <UnifiedLine line={line}/>
                            {threadsAt(line.newNo)}
                        </Fragment>
                    );
                })}
            </div>
        </>
    );
}

// InlineThread is one review thread, drawn under the diff line it is attached to.
function InlineThread({thread, onOpenURL}: {thread: PRThread; onOpenURL: (url: string) => void}) {
    return (
        <div className={`cmt-thread inline-thread${thread.resolved ? ' resolved' : ''}`}>
            <div className="cmt-meta">
                <span>{thread.resolved ? 'resolved' : 'open'}</span>
                {thread.outdated && <span className="cmt-tag">outdated</span>}
                <span className="spacer"/>
                {thread.url && <button className="btn link" onClick={() => onOpenURL(thread.url)}>Open on GitHub</button>}
            </div>
            {thread.comments.map((c, i) => <CommentBody key={i} comment={c}/>)}
        </div>
    );
}

function UnifiedLine({line}: {line: Line}) {
    const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
    return (
        <div className={`line ${line.kind}`}>
            <span className="gutter">{line.oldNo ?? ''}</span>
            <span className="gutter">{line.newNo ?? ''}</span>
            <span className="sign">{line.kind === 'meta' ? '' : sign}</span>
            <Content line={line}/>
        </div>
    );
}

function SplitRowView({row, hunkIndex}: {row: SplitRow; hunkIndex: number}) {
    if (row.hunk) {
        return <div className="line hunk" data-hunk={hunkIndex}>{row.hunk.text}</div>;
    }
    return (
        <div className="split-row">
            <div className={`half left ${row.left?.kind ?? 'none'}`}>
                <span className="gutter">{row.left?.oldNo ?? ''}</span>
                <Content line={row.left}/>
            </div>
            <div className={`half right ${row.right?.kind ?? 'none'}`}>
                <span className="gutter">{row.right?.newNo ?? ''}</span>
                <Content line={row.right}/>
            </div>
        </div>
    );
}

// Content draws a line's text, with the changed part of a paired line highlighted.
function Content({line}: {line: Line | null}) {
    if (!line) return <span className="content"/>;
    if (!line.segs) return <span className="content">{line.text || ' '}</span>;
    return (
        <span className="content">
            {line.segs.map((seg, i) => (
                <span key={i} className={seg.changed ? 'word' : undefined}>{seg.text}</span>
            ))}
        </span>
    );
}

const STATUS_LABEL: Record<string, string> = {
    A: 'Added',
    M: 'Modified',
    D: 'Deleted',
    R: 'Renamed',
    U: 'Untracked',
};

function worktreeLabel(w: WorktreeItem) {
    const name = w.branch || (w.detached ? `detached ${w.head.slice(0, 7)}` : w.head.slice(0, 7));
    return `${basename(w.path)} · ${name}`;
}

// shortBase shortens a full commit id for messages; branch names are returned as they are.
function shortBase(ref: string): string {
    return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref;
}

// The shortcut list, shown with ? and kept in step with the key handler above.
const SHORTCUT_GROUPS: {title: string; rows: [string, string][]}[] = [
    {title: 'Files', rows: [
        ['↑ ↓', 'Previous or next file'],
        ['/', 'Filter files'],
        ['⌘P', 'Quick open'],
        ['o', 'Open file in Zed'],
    ]},
    {title: 'Selecting', rows: [
        ['⌘-click', 'Add or remove a file from the selection'],
        ['⇧-click', 'Select a range of files'],
        ['x', 'Mark the selection reviewed (or unmark)'],
        ['Esc', 'Clear the selection'],
    ]},
    {title: 'Diff', rows: [
        ['[ ]', 'Previous or next hunk'],
        ['v', 'Split or unified view'],
        ['b', 'Ignore whitespace'],
        ['n', 'Note for the file'],
    ]},
    {title: 'App', rows: [
        ['t', 'Run a command'],
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
                    <button className="btn icon" onClick={onClose} aria-label="Close">×</button>
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

// baseLabel names the pull request's base in the picker and warnings.
function baseLabel(pb: main.PRBase): string {
    return pb.fetched ? `${pb.name} · PR base ${pb.commit.slice(0, 7)}` : `${pb.name} · PR base not fetched`;
}

function parentOf(path: string) {
    return path.replace(/[\\/][^\\/]*$/, '');
}

// recentRepos returns each repository once, newest first.
function recentRepos(items: HistoryItem[]): string[] {
    const seen = new Set<string>();
    for (const item of items) seen.add(item.repo);
    return [...seen].slice(0, 8);
}

function formatTime(iso: string) {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString();
}

function sumChanges(changes: FileChange[]) {
    return changes.reduce(
        (acc, c) => ({added: acc.added + c.added, deleted: acc.deleted + c.deleted}),
        {added: 0, deleted: 0},
    );
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
