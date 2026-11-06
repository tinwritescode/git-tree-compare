import {type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState} from 'react';
import type {main} from '../wailsjs/go/models';
import {PRChecks, RunCommand} from '../wailsjs/go/main/App';
import {checkChip, checksSummary} from './checks';
import {fuzzyScore, shellQuote} from './util';
import {Button} from './ui/button';
import {Kbd} from './ui/kbd';

export type PickerItem = {id: string; label: string; leading?: ReactNode; hint?: string};

// Picker is a searchable list in a dialog: type to narrow it, arrows to move, Enter to choose.
export function Picker({placeholder, empty, items, order, typed, onPick, onClose}: {
    placeholder: string;
    empty: string;
    items: PickerItem[];
    order?: (a: PickerItem, b: PickerItem) => number; // breaks ties between equal matches
    typed?: (query: string) => PickerItem; // a last entry that takes the typed text as it is
    onPick: (id: string) => void;
    onClose: () => void;
}) {
    const [query, setQuery] = useState('');
    const [index, setIndex] = useState(0);

    const matches = useMemo(() => {
        const found = items
            .map(item => ({item, score: fuzzyScore(query, item.label)}))
            .filter(m => m.score >= 0)
            .sort((a, b) => a.score - b.score || (order?.(a.item, b.item) ?? 0))
            .map(m => m.item)
            .slice(0, 50);
        const q = query.trim();
        return typed && q ? [...found, typed(q)] : found;
    }, [items, order, typed, query]);

    function onKey(e: KeyboardEvent) {
        if (e.key === 'Escape') onClose();
        if (e.key === 'ArrowDown') setIndex(i => Math.min(i + 1, matches.length - 1));
        if (e.key === 'ArrowUp') setIndex(i => Math.max(i - 1, 0));
        if (e.key === 'Enter' && matches[index]) onPick(matches[index].id);
    }

    return (
        <div className="overlay" onClick={onClose}>
            <div className="quick" role="dialog" aria-label={placeholder} onClick={e => e.stopPropagation()}>
                <input
                    autoFocus
                    placeholder={placeholder}
                    value={query}
                    onChange={e => {
                        setQuery(e.target.value);
                        setIndex(0);
                    }}
                    onKeyDown={onKey}
                />
                <ul>
                    {matches.map((item, i) => (
                        <li
                            key={item.id}
                            className={i === index ? 'active' : ''}
                            onMouseEnter={() => setIndex(i)}
                            onClick={() => onPick(item.id)}
                        >
                            {item.leading}
                            <span>{item.label}</span>
                            {item.hint && <kbd>{item.hint}</kbd>}
                        </li>
                    ))}
                    {matches.length === 0 && <li className="none">{empty}</li>}
                </ul>
            </div>
        </div>
    );
}

// QuickOpen jumps to a changed file by typing part of its path.
export function QuickOpen({files, onPick, onClose}: {
    files: {path: string; status: string}[];
    onPick: (path: string) => void;
    onClose: () => void;
}) {
    const items = useMemo(() => files.map(f => ({
        id: f.path,
        label: f.path,
        leading: <span className={`status status-${f.status}`}>{f.status}</span>,
    })), [files]);
    return <Picker placeholder="Go to file…" empty="No matching file" items={items} onPick={onPick} onClose={onClose}/>;
}

export type Command = {id: string; label: string; hint?: string; run: () => void};

// CommandPalette holds the actions that do not earn a permanent place on screen.
export function CommandPalette({commands, onClose}: {commands: Command[]; onClose: () => void}) {
    const items = useMemo(() => commands.map(({id, label, hint}) => ({id, label, hint})), [commands]);
    function pick(id: string) {
        onClose();
        commands.find(c => c.id === id)?.run();
    }
    return <Picker placeholder="Type a command…" empty="No matching command" items={items} onPick={pick} onClose={onClose}/>;
}

// CommandPanel runs a command in the repository, such as a test command. A
// {files} placeholder is replaced with the changed paths, shell-quoted. For a pull request it
// also lists the CI checks on its head.
export function CommandPanel({repo, paths, checks, onClose}: {
    repo: string;
    paths: string[];
    checks: {number: number; onOpenURL: (url: string) => void} | null;
    onClose: () => void;
}) {
    const key = `git-tree-compare:cmd:${repo}`;
    const [command, setCommand] = useState(() => {
        try {
            return localStorage.getItem(key) ?? '';
        } catch {
            return '';
        }
    });
    const [output, setOutput] = useState('');
    const [status, setStatus] = useState('');
    const [running, setRunning] = useState(false);
    const input = useRef<HTMLInputElement>(null);

    useEffect(() => {
        input.current?.focus();
    }, []);

    async function run() {
        const expanded = command.replace(/\{files\}/g, paths.map(shellQuote).join(' '));
        if (!expanded.trim()) return;
        try {
            localStorage.setItem(key, command);
        } catch {
            // Storage can be unavailable; the command just is not remembered.
        }
        setRunning(true);
        setStatus(`$ ${expanded}`);
        try {
            const res = await RunCommand(repo, expanded);
            setOutput(res.output || '(no output)');
            setStatus(res.timedOut
                ? 'Timed out after 5 minutes'
                : res.exitCode === 0 ? 'Finished, exit 0' : `Failed, exit ${res.exitCode}`);
        } catch (e) {
            setOutput(String(e));
            setStatus('Could not run the command');
        } finally {
            setRunning(false);
        }
    }

    return (
        <section className="cmd" aria-label="Run a command">
            <div className="cmd-bar">
                <input
                    ref={input}
                    value={command}
                    placeholder="e.g. go test ./...   or   npx vitest related {files}"
                    onChange={e => setCommand(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter') run();
                        if (e.key === 'Escape') onClose();
                    }}
                />
                <Button onClick={run} disabled={running || !command.trim()}>
                    {running ? 'Running…' : 'Run'}
                </Button>
                <Button size="icon"  onClick={onClose} aria-label="Close">×</Button>
            </div>
            {status && <div className="cmd-status">{status}</div>}
            {output && <pre className="cmd-output">{output}</pre>}
            {checks && <ChecksList repo={repo} number={checks.number} onOpenURL={checks.onOpenURL}/>}
        </section>
    );
}

type ChecksState = {kind: 'loading'} | {kind: 'ready'; checks: main.Check[]} | {kind: 'failed'; message: string};

// ChecksList shows the CI checks on a pull request's head, failing and running ones first.
function ChecksList({repo, number, onOpenURL}: {repo: string; number: number; onOpenURL: (url: string) => void}) {
    const [state, setState] = useState<ChecksState>({kind: 'loading'});
    const reads = useRef(0); // drops a read that a later refresh overtook

    async function load() {
        const read = ++reads.current;
        setState({kind: 'loading'});
        try {
            const checks = await PRChecks(repo, number);
            if (read === reads.current) setState({kind: 'ready', checks});
        } catch (e) {
            if (read === reads.current) setState({kind: 'failed', message: String(e)});
        }
    }

    useEffect(() => {
        load();
    }, [repo, number]);

    return (
        <div className="checks" aria-label="Checks">
            <div className="checks-head">
                <span>Checks</span>
                <span className="cmd-status">
                    {state.kind === 'loading' ? 'Reading checks…' : state.kind === 'ready' ? checksSummary(state.checks) : 'Could not read the checks'}
                </span>
                <span className="spacer"/>
                <Button onClick={load} disabled={state.kind === 'loading'} title="Read the checks from GitHub again">Refresh</Button>
            </div>
            {state.kind === 'failed' && <div className="cmd-status" role="alert">{state.message}</div>}
            {state.kind === 'ready' && state.checks.length > 0 && (
                <ul className="checks-list">
                    {state.checks.map((c, i) => {
                        const chip = checkChip(c);
                        return (
                            <li key={`${c.name}-${i}`}>
                                <span className={`chip check-${chip.kind}`}>{chip.label}</span>
                                {c.link
                                    ? <Button variant="link" onClick={() => onOpenURL(c.link)} title="Open this check on GitHub">{c.name}</Button>
                                    : <span>{c.name}</span>}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

// UpdateBanner offers a newer release. Install and restart replaces the app in place when the release
// has a checksummed build; otherwise Download opens its GitHub page. Later hides it until the next release.
export function UpdateBanner({update, installing, onInstall, onOpen, onLater}: {
    update: main.UpdateInfo;
    installing: boolean;
    onInstall: () => void;
    onOpen: () => void;
    onLater: () => void;
}) {
    return (
        <div className="pr update" role="status">
            <span className="pr-title">Version {update.latest} is out. You have {update.current}.</span>
            <span className="spacer"/>
            {update.installable ? (
                <>
                    <Button onClick={onOpen} disabled={installing}>Release notes</Button>
                    <Button onClick={onInstall} disabled={installing}>
                        {installing ? 'Installing...' : 'Install and restart'}
                    </Button>
                </>
            ) : (
                <Button onClick={onOpen}>Download</Button>
            )}
            <Button onClick={onLater} disabled={installing}>Later</Button>
        </div>
    );
}

export type PRDiscussion = main.PRDiscussion;
export type PRThread = main.PRThread;
export type PRComment = main.PRComment;

// ThreadControls post to GitHub at once: each is a reviewer's explicit click. A rejected promise
// carries GitHub's error.
export type ThreadControls = {
    reply: (threadID: string, body: string) => Promise<void>;
    resolve: (threadID: string, resolved: boolean) => Promise<void>;
};

// ThreadActions are Reply and Resolve under a review thread. A reply that fails keeps its text.
export function ThreadActions({thread, controls}: {thread: PRThread; controls: ThreadControls}) {
    const [replying, setReplying] = useState(false);
    const [body, setBody] = useState('');
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState('');

    async function run(action: () => Promise<void>) {
        setBusy(true);
        setFailure('');
        try {
            await action();
            return true;
        } catch (e) {
            setFailure(String(e));
            return false;
        } finally {
            setBusy(false);
        }
    }

    async function send() {
        if (!body.trim() || busy) return;
        if (await run(() => controls.reply(thread.id, body))) {
            setBody('');
            setReplying(false);
        }
    }

    if (!thread.id) return null;
    return (
        <div className="thread-actions">
            {replying ? (
                <>
                    <textarea
                        autoFocus
                        value={body}
                        placeholder="Reply. It posts on GitHub when you send it."
                        disabled={busy}
                        onChange={e => setBody(e.target.value)}
                        onKeyDown={e => {
                            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                                e.preventDefault();
                                send();
                            }
                            if (e.key === 'Escape') setReplying(false);
                        }}
                    />
                    <div className="draft-actions">
                        <span className="spacer"/>
                        <Button onClick={() => setReplying(false)} disabled={busy}>Cancel</Button>
                        <Button onClick={send} disabled={busy || !body.trim()}>{busy ? 'Sending…' : 'Send reply'} <Kbd>⌘↵</Kbd></Button>
                    </div>
                </>
            ) : (
                <div className="draft-actions">
                    <Button onClick={() => setReplying(true)} disabled={busy}>Reply</Button>
                    <Button onClick={() => run(() => controls.resolve(thread.id, !thread.resolved))} disabled={busy}>
                        {thread.resolved ? 'Reopen' : 'Resolve'}
                    </Button>
                </div>
            )}
            {failure && <div className="finish-error" role="alert">{failure}</div>}
        </div>
    );
}

// CommentsPanel lists the review threads and conversation comments on the open pull request.
// Threads are grouped by file; a file name opens that file's diff.
export function CommentsPanel({discussion, loading, controls, onOpenFile, onOpenURL, onRefresh, onClose}: {
    discussion: PRDiscussion | null;
    loading: boolean;
    controls: ThreadControls;
    onOpenFile: (path: string) => void;
    onOpenURL: (url: string) => void;
    onRefresh: () => void;
    onClose: () => void;
}) {
    const byFile = useMemo(() => {
        const groups = new Map<string, PRThread[]>();
        for (const t of discussion?.threads ?? []) {
            groups.set(t.path, [...(groups.get(t.path) ?? []), t]);
        }
        return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
    }, [discussion]);
    const total = discussion ? discussion.threads.length + discussion.comments.length : 0;

    return (
        <section className="cmt" aria-label="Pull request comments">
            <div className="cmt-bar">
                <span className="cmt-title">Comments</span>
                <span className="spacer"/>
                <Button onClick={onRefresh} disabled={loading}>
                    {loading ? 'Loading…' : 'Refresh'}
                </Button>
                <Button size="icon"  onClick={onClose} aria-label="Close">×</Button>
            </div>

            {discussion && total === 0 && !loading && (
                <div className="cmt-empty">No comments on this pull request yet.</div>
            )}

            {byFile.map(([path, threads]) => (
                <div className="cmt-file" key={path}>
                    <button className="cmt-path" onClick={() => onOpenFile(path)} title="Open this file">{path}</button>
                    {threads.map((t, i) => (
                        <div className={`cmt-thread${t.resolved ? ' resolved' : ''}`} key={`${t.url}-${i}`}>
                            <div className="cmt-meta">
                                <span>line {t.line || '?'}</span>
                                {t.resolved && <span className="cmt-tag">resolved</span>}
                                {t.outdated && <span className="cmt-tag">outdated</span>}
                                <span className="spacer"/>
                                {t.url && <Button variant="link"  onClick={() => onOpenURL(t.url)}>Open on GitHub</Button>}
                            </div>
                            {t.comments.map((c, j) => (
                                <CommentBody key={j} comment={c}/>
                            ))}
                            <ThreadActions thread={t} controls={controls}/>
                        </div>
                    ))}
                </div>
            ))}

            {discussion && discussion.comments.length > 0 && (
                <div className="cmt-file">
                    <div className="cmt-path static">Conversation</div>
                    {discussion.comments.map((c, i) => (
                        <div className="cmt-thread" key={`${c.url}-${i}`}>
                            <div className="cmt-meta">
                                <span className="spacer"/>
                                {c.url && <Button variant="link"  onClick={() => onOpenURL(c.url)}>Open on GitHub</Button>}
                            </div>
                            <CommentBody comment={c}/>
                        </div>
                    ))}
                </div>
            )}

            {discussion?.truncated && (
                <div className="cmt-empty">Showing the first 100 threads and comments. Open the PR on GitHub for the rest.</div>
            )}
        </section>
    );
}

export function CommentBody({comment}: {comment: PRComment}) {
    return (
        <div className="cmt-comment">
            <div className="cmt-author">{comment.author}</div>
            <div className="cmt-body">{comment.body}</div>
        </div>
    );
}

export interface FileMenuProps {
    x: number;
    y: number;
    paths: string[]; // the files the actions apply to
    allReviewed: boolean;
    onOpenInEditor: (path: string) => void;
    onOpenWorkingCopy: ((path: string) => void) | null; // set for a pull request, whose files open at its head
    onCopyPaths: () => void;
    onToggleReviewed: () => void;
    onClose: () => void;
}

// FileMenu is the right-click menu for files in the tree. It acts on every file in paths.
export function FileMenu({x, y, paths, allReviewed, onOpenInEditor, onOpenWorkingCopy, onCopyPaths, onToggleReviewed, onClose}: FileMenuProps) {
    useEffect(() => {
        const close = (e: globalThis.KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', close);
        return () => window.removeEventListener('keydown', close);
    }, [onClose]);

    const single = paths.length === 1 ? paths[0] : null;
    // Keep the menu inside the window when it opens near the right or bottom edge.
    const left = Math.min(x, window.innerWidth - 220);
    const top = Math.min(y, window.innerHeight - 130);

    function run(action: () => void) {
        action();
        onClose();
    }

    return (
        <div className="ctx-scrim" onMouseDown={onClose} onContextMenu={e => { e.preventDefault(); onClose(); }}>
            <ul className="ctx-menu" role="menu" style={{left, top}} onMouseDown={e => e.stopPropagation()}>
                {single && <li role="none"><button role="menuitem" onClick={() => run(() => onOpenInEditor(single))}>Open in editor</button></li>}
                {single && onOpenWorkingCopy && (
                    <li role="none"><button role="menuitem" onClick={() => run(() => onOpenWorkingCopy(single))}>Open working copy</button></li>
                )}
                <li role="none">
                    <button role="menuitem" onClick={() => run(onCopyPaths)}>
                        {paths.length > 1 ? `Copy ${paths.length} paths` : 'Copy path'}
                    </button>
                </li>
                <li role="separator" className="ctx-sep"/>
                <li role="none">
                    <button role="menuitem" onClick={() => run(onToggleReviewed)}>
                        {allReviewed ? 'Mark unreviewed' : paths.length > 1 ? `Mark ${paths.length} reviewed` : 'Mark reviewed'}
                    </button>
                </li>
            </ul>
        </div>
    );
}

