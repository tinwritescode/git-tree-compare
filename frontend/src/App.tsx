import {Fragment, memo, type MouseEvent as ReactMouseEvent, type ReactNode, type Ref, type RefObject, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {useVirtualizer} from '@tanstack/react-virtual';
import './App.css';
import {
    Changes,
    CheckUpdate,
    CurrentPRNumber,
    FindClone,
    Diff,
    DiffAnchor,
    ExportPatch,
    InstallCLI,
    InstallUpdate,
    InstalledEditors,
    ListPRs,
    OpenInEditor,
    PRComments,
    PRViewedStates,
    PrepareReview,
    ResolveRepo,
    SetViewed,
    TakePendingRepo,
} from '../wailsjs/go/main/App';
import {BrowserOpenURL, EventsOn} from '../wailsjs/runtime/runtime';
import {diffRows, type DiffRow, parseDiff, type Line, type SplitRow} from './diff';
import {highlight} from './highlight';
import {emptyQuery, SearchDialog, type SearchHit, type SearchQuery} from './search-dialog';
import {paint, type Token} from './syntax';
import {EditorMenu} from './editor-menu';
import {Command, CommandPalette, CommandPanel, CommentBody, CommentsPanel, FileMenu, PRDiscussion, PRThread, QuickOpen, UpdateBanner} from './panels';
import {PR, PRList, ReviewRuler} from './prs';
import {RefPicker, type RefMode} from './ref-picker';
import {
    applyServerStates, emptyRecord, isChangedSinceReview, isReviewed, nextBatch, nextUnreviewed, ReviewRecord, settleBatch, toggleReviewed,
} from './review';
import {buildTree, FileChange, SortMode, TreeNode} from './tree';
import type {main} from '../wailsjs/go/models';
import {basename, buildMarkdown, dropOldest} from './util';
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
const localReviewKey = (repo: string, r: main.LocalReview) => `git-tree-compare:review:${repo}@${r.base}..${r.head}`;

type OpenRequest = {repo?: string; error?: string; review?: main.LocalReview; link?: main.OpenLink};

// What is under review: an open pull request, or a commit or branch read from git alone.
type Subject = {kind: 'pr'; number: number} | {kind: 'local'; review: main.LocalReview};

function App() {
    const [repo, setRepo] = useState(() => readStore('git-tree-compare:last', {repo: ''}).repo);
    const [landing, setLanding] = useState(true); // the start screen, until a repository opens
    const [prs, setPrs] = useState<PR[]>([]);
    const [prsLoading, setPrsLoading] = useState(false);
    const [prsError, setPrsError] = useState('');
    const [prsRead, setPrsRead] = useState(false); // the list has been read from GitHub for this repository
    const [subject, setSubject] = useState<Subject | null>(null);
    // A review the command line or a link asked for.
    const [launch, setLaunch] = useState<{kind: 'local'; review: main.LocalReview} | {kind: 'pr'; number: number} | null>(null);
    const [refMode, setRefMode] = useState<RefMode | null>(null); // the commit or branch picker, while open
    const [target, setTarget] = useState<main.ReviewTarget | null>(null);
    const [pollTick, setPollTick] = useState(0);
    const [record, setRecord] = useState<ReviewRecord>(emptyRecord);
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
    const [filter, setFilter] = useState('');
    const [sort, setSort] = useState<SortMode>(() => readStore<SortMode>('git-tree-compare:sort', 'name'));
    const [split, setSplit] = useState(() => readStore('git-tree-compare:split', false));
    const [fullFile, setFullFile] = useState(() => readStore('git-tree-compare:fullFile', false));
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const [notes, setNotes] = useState<Record<string, string>>({});
    const [noteOpen, setNoteOpen] = useState(false);
    const [prFileURL, setPrFileURL] = useState(''); // this file's diff on the open pull request
    const [editors, setEditors] = useState<main.Editor[]>([]); // editors installed on this machine
    const [editorID, setEditorID] = useState(() => readStore('git-tree-compare:editor', ''));
    const [discussion, setDiscussion] = useState<PRDiscussion | null>(null); // review comments on the open PR
    const [commentsOpen, setCommentsOpen] = useState(false);
    const [commentsLoading, setCommentsLoading] = useState(false);
    const [update, setUpdate] = useState<main.UpdateInfo | null>(null); // a newer release, if one exists
    const [installing, setInstalling] = useState(false);
    const [quickOpen, setQuickOpen] = useState(false);
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState<SearchQuery>(emptyQuery); // kept until the pull request closes
    // A line to scroll to and flash once its file's diff is drawn, set by a search pick.
    const [jump, setJump] = useState<{path: string; line: number; id: number} | null>(null);
    // A file shown whole for one visit because a search hit sat outside its diff. The saved setting is untouched.
    const [tempFull, setTempFull] = useState<string | null>(null);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [picking, setPicking] = useState(false);
    const [recent, setRecent] = useState<string[]>(() => readStore<string[]>(RECENT_KEY, []));
    const [pickError, setPickError] = useState('');
    const [cmdOpen, setCmdOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [flash, setFlash] = useState('');

    // Values read inside effects and handlers, without re-running them.
    const recordRef = useRef<ReviewRecord>(emptyRecord);
    const owner = useRef<{repo: string; id: string; key: string} | null>(null); // whose review recordRef holds
    const flushing = useRef(false); // one writer to GitHub at a time, so toggles land in order
    const writes = useRef(0); // counts accepted writes, to drop reads that started before them
    const filterInput = useRef<HTMLInputElement>(null);
    const diffView = useRef<DiffHandle>(null);
    const diffCache = useRef<{scope: typeof scope; texts: Map<string, string>}>({scope: null, texts: new Map()});
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
    const files = useMemo(() => flattenFiles(tree, collapsed), [tree, collapsed]);
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
        setJump({path: hit.path, line: hit.line, id: Date.now()});
    }

    function closeReview() {
        setSubject(null);
        setTarget(null);
        setSearchQuery(emptyQuery);
        setSearchOpen(false);
        setCommentsOpen(false);
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
        setSyncError('');
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
    // selection if the file is still part of the pull request, otherwise select the first file.
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
                setSelected(prev => list.find(f => f.path === prev?.path) ?? list[0] ?? null);
            })
            .catch(e => !cancelled && setError(String(e)))
            .finally(() => !cancelled && setLoading(false));
        return () => {
            cancelled = true;
        };
    }, [scope]);

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
        const key = `${whole ? 'whole' : 'changes'}:${selected.path}`;
        const cached = texts.get(key);
        if (cached !== undefined) {
            setDiff(cached);
            setDiffPath(selected.path);
            return;
        }
        Diff({...scope, fullFile: whole}, selected.path)
            .then(text => {
                texts.set(key, text);
                dropOldest(texts, DIFF_CACHE_SIZE);
                if (cancelled) return;
                setDiff(text);
                setDiffPath(selected.path);
            })
            .catch(e => !cancelled && setError(String(e)));
        return () => {
            cancelled = true;
        };
    }, [selected, scope, fullFile, tempFull]);

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
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (quickOpen || paletteOpen || searchOpen) return;
            const target = e.target as HTMLElement;
            const typing = target instanceof HTMLInputElement || target instanceof HTMLSelectElement
                || target instanceof HTMLTextAreaElement;
            if (typing) {
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
                    if (picked.length) setPicked([]);
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
                case 'n':
                    if (selected) setNoteOpen(v => !v);
                    return;
                case 'c':
                    toggleComments();
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

    async function openIn(id: string, path = selected?.path) {
        if (!path) return;
        const name = editors.find(e => e.id === id)?.name ?? id;
        setEditorID(id);
        try {
            await OpenInEditor(repo, path, id);
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
        const md = buildMarkdown({title, files: changes, reviewed, notes});
        try {
            await navigator.clipboard.writeText(md);
            showFlash('Summary copied as Markdown');
        } catch {
            setError('Could not copy the summary');
        }
    }

    const commands: Command[] = [
        ...(reviewing ? [
            {id: 'back', label: 'Back to pull requests', hint: 'p', run: closeReview},
            {id: 'file', label: 'Go to file', hint: '⌘P', run: () => setQuickOpen(true)},
            {id: 'search', label: 'Search in files', hint: '⇧⌘F', run: () => setSearchOpen(true)},
        ] : []),
        ...(pr ? [
            {id: 'comments', label: 'Show comments', hint: 'c', run: toggleComments},
            {id: 'github', label: 'Open pull request on GitHub', run: () => BrowserOpenURL(pr.url)},
        ] : []),
        ...(reviewing ? [
            {id: 'ws', label: ignoreWS ? 'Show whitespace changes' : 'Ignore whitespace changes', hint: 'b', run: () => setIgnoreWS(v => !v)},
            {id: 'sort', label: sort === 'name' ? 'Sort files by size of change' : 'Sort files by name', run: () => setSort(s => (s === 'name' ? 'size' : 'name'))},
            {id: 'run', label: 'Run a command', hint: 't', run: () => setCmdOpen(v => !v)},
            {id: 'summary', label: 'Copy summary as Markdown', run: copySummary},
            {id: 'patch', label: 'Export patch', run: exportPatch},
        ] : []),
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

            {menu && (
                <FileMenu
                    x={menu.x}
                    y={menu.y}
                    paths={menuPaths}
                    allReviewed={menuAllReviewed}
                    onOpenInEditor={path => openIn(defaultEditor, path)}
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

            {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)}/>}

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
                    loading={prsLoading}
                    error={prsError}
                    reviewedCount={p => storedReviewedCount(repo, p)}
                    active={!picking && !paletteOpen && !helpOpen && openNumber === null}
                    onOpen={p => setSubject({kind: 'pr', number: p.number})}
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
                        <span className="review-count" title="Files reviewed"><strong>{reviewedCount}</strong>/{changes.length}</span>
                        {pr && (
                            <Button onClick={toggleComments} aria-pressed={commentsOpen} title="Review comments (c)">
                                Comments{unresolvedCount > 0 ? ` ${unresolvedCount}` : ''}
                            </Button>
                        )}
                        <Button onClick={() => setPaletteOpen(true)} title="All commands">Commands <Kbd>⌘K</Kbd></Button>
                    </header>

                    <ReviewRuler
                        files={files}
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
                            {tree.length > 0 && (
                                <TreeList
                                    nodes={tree}
                                    selectedPath={selected?.path}
                                    picked={pickedSet}
                                    collapsed={collapsed}
                                    reviewed={reviewed}
                                    notes={notes}
                                    comments={commentCounts}
                                    changedSinceReview={changedSinceReview}
                                    unsynced={unsynced}
                                    onToggle={toggleFolder}
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
                                    {pr ? (
                                        <>
                                            <span>All {changes.length} files reviewed. Approve or request changes on GitHub.</span>
                                            <Button onClick={() => BrowserOpenURL(pr.url)}>Open on GitHub</Button>
                                        </>
                                    ) : (
                                        <span>All {changes.length} files reviewed.</span>
                                    )}
                                </div>
                            )}
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
                                    editors={editors}
                                    defaultEditor={defaultEditor}
                                    onOpenIn={openIn}
                                    prFileURL={prFileURL}
                                    threads={fileThreads}
                                    onOpenURL={BrowserOpenURL}
                                    diffView={diffView}
                                />
                                : <Empty title="No file selected" hint="Choose a file in the tree to see its diff."/>}
                        </main>
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

type TreeProps = {
    selectedPath?: string;
    picked: Set<string>;
    collapsed: Set<string>;
    reviewed: Record<string, string>;
    notes: Record<string, string>;
    comments: Record<string, number>;
    changedSinceReview: Set<string>;
    unsynced: Set<string>;
    onToggle: (path: string) => void;
    onToggleReviewed: (path: string) => void;
    onPick: (file: FileChange, e: ReactMouseEvent) => void;
    onContextMenu: (file: FileChange, e: ReactMouseEvent) => void;
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
                <div className={classes} style={indent} onClick={e => rest.onPick(file, e)} onContextMenu={e => rest.onContextMenu(file, e)} aria-selected={active}>
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
                    {rest.changedSinceReview.has(file.path) && <span className="changed-tag" title="Changed by a push after you reviewed it">changed</span>}
                    {rest.unsynced.has(file.path) && <span className="unsynced" title="Not on GitHub yet, retrying">●</span>}
                    <span className="counts"><span className="added">+{file.added}</span> <span className="deleted">−{file.deleted}</span></span>
                </div>
            </li>
        );
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
                    changedSinceReview={rest.changedSinceReview}
                    unsynced={rest.unsynced}
                    onToggle={rest.onToggle}
                    onToggleReviewed={rest.onToggleReviewed}
                    onPick={rest.onPick}
                    onContextMenu={rest.onContextMenu}
                />
            )}
        </li>
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
    prFileURL: string;
    threads: PRThread[];
    onOpenURL: (url: string) => void;
    jump: {line: number; id: number} | null;
    onJumpOutside: () => void; // the jump line is not in this diff
    diffView: RefObject<DiffHandle | null>;
}) {
    const {file, text, split, note, noteOpen} = props;
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
                <EditorMenu editors={props.editors} current={props.defaultEditor} disabled={file.status === 'D'} onOpen={props.onOpenIn}/>
            </div>
            {noteOpen && (
                <textarea
                    className="note"
                    placeholder="A note for this file. It is saved on this machine and included in the Markdown summary."
                    value={note}
                    onChange={e => props.onNote(e.target.value)}
                />
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
            />
        </>
    );
}

// DiffHandle lets the app move through the hunks of the diff on screen.
export type DiffHandle = {moveHunk: (step: number) => void};

const ROW_HEIGHT = 24; // a diff line, matching .diff-body's line-height; only rows with threads are measured
const THREAD_HEIGHT = 96; // a guess for a row's review threads until the row is measured
const HEADER_HEIGHT = 48; // the sticky file header, which a row scrolled to the top must clear
const BODY_PADDING = 6;
const GUTTERS_WIDTH = 114; // two line-number gutters, the sign and the right padding of a unified line

// DiffView draws the file's diff. Review threads sit under their line on the new side.
// A thread whose line is not in the diff (outdated, or the file changed since) is listed at the top.
// Only the rows in view are drawn, so a file of any length opens and scrolls at the same speed.
// It is memoised: a diff can be thousands of lines, and most app state never touches it.
const DiffView = memo(function DiffView({text, path, split, threads, onOpenURL, jump, onJumpOutside, ref}: {
    text: string;
    path: string; // picks the language for syntax colours
    split: boolean;
    threads: PRThread[];
    onOpenURL: (url: string) => void;
    jump: {line: number; id: number} | null; // a new-side line to scroll to and flash
    onJumpOutside?: () => void; // asks for the whole file when the line is not in this diff
    ref?: Ref<DiffHandle>;
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
    // Changes only with the rows or their threads, which is when the sizes must be estimated again.
    const estimateSize = useCallback((i: number) => ROW_HEIGHT + threadsOf(rows[i]).length * THREAD_HEIGHT, [rows, threadsOf]);
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
    }), [rows, virtualizer]);

    // Each jump runs once: scroll its line to the middle and flash it, or ask for the whole file.
    const jumped = useRef(0);
    const [flash, setFlash] = useState<{index: number; id: number} | null>(null);
    useEffect(() => {
        if (!jump || jumped.current === jump.id || !lines.length) return;
        const index = rows.findIndex(row => row.kind !== 'hunk' && row.newNo === jump.line);
        if (index < 0) {
            if (!visibleLines.has(jump.line) && onJumpOutside) onJumpOutside();
            return;
        }
        jumped.current = jump.id;
        virtualizer.scrollToIndex(index, {align: 'center'});
        setFlash({index, id: jump.id});
    }, [jump, lines, rows, visibleLines, onJumpOutside, virtualizer]);
    const orphans = threads.filter(t => !visibleLines.has(t.line));

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
                    return (
                        <div
                            key={item.key}
                            data-index={item.index}
                            ref={rowThreads.length ? virtualizer.measureElement : undefined}
                            className="diff-row"
                            style={{transform: `translateY(${item.start - scrollMargin}px)`}}
                        >
                            <DiffRowView key={flashed} row={row} tokens={tokens} flashed={flashed > 0}/>
                            {rowThreads.map((t, j) => <InlineThread key={`${item.index}-${j}`} thread={t} onOpenURL={onOpenURL}/>)}
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
function InlineThread({thread, onOpenURL}: {thread: PRThread; onOpenURL: (url: string) => void}) {
    return (
        <div className={`cmt-thread inline-thread${thread.resolved ? ' resolved' : ''}`}>
            <div className="cmt-meta">
                <span>{thread.resolved ? 'resolved' : 'open'}</span>
                {thread.outdated && <span className="cmt-tag">outdated</span>}
                <span className="spacer"/>
                {thread.url && <Button variant="link"  onClick={() => onOpenURL(thread.url)}>Open on GitHub</Button>}
            </div>
            {thread.comments.map((c, i) => <CommentBody key={i} comment={c}/>)}
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
        ['Enter', 'Open the pull request'],
        ['p', 'Back to all pull requests'],
        ['c', 'Show comments'],
    ]},
    {title: 'Files', rows: [
        ['↑ ↓', 'Previous or next file'],
        ['/', 'Filter'],
        ['⌘P', 'Go to file'],
        ['⇧⌘F', 'Search in the changed files'],
        ['o', 'Open file in the default editor'],
    ]},
    {title: 'Reviewing', rows: [
        ['x', 'Mark reviewed here and on GitHub, then go to the next file'],
        ['⌘-click', 'Add or remove a file from the selection'],
        ['⇧-click', 'Select a range of files'],
        ['Esc', 'Clear the selection'],
    ]},
    {title: 'Diff', rows: [
        ['[ ]', 'Previous or next hunk'],
        ['v', 'Split or unified view'],
        ['b', 'Ignore whitespace'],
        ['n', 'Note for the file'],
    ]},
    {title: 'App', rows: [
        ['⌘K', 'All commands'],
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
