import {type KeyboardEvent, useEffect, useMemo, useRef, useState} from 'react';
import type {main} from '../wailsjs/go/models';
import {RunCommand} from '../wailsjs/go/main/App';
import {FileChange} from './tree';
import {fuzzyScore, shellQuote} from './util';

// QuickOpen jumps to any changed file by typing part of its path.
export function QuickOpen({files, onPick, onClose}: {
    files: FileChange[];
    onPick: (file: FileChange) => void;
    onClose: () => void;
}) {
    const [query, setQuery] = useState('');
    const [index, setIndex] = useState(0);

    const matches = useMemo(() => {
        return files
            .map(f => ({f, score: fuzzyScore(query, f.path)}))
            .filter(m => m.score >= 0)
            .sort((a, b) => a.score - b.score)
            .map(m => m.f)
            .slice(0, 50);
    }, [files, query]);

    function onKey(e: KeyboardEvent) {
        if (e.key === 'Escape') onClose();
        if (e.key === 'ArrowDown') setIndex(i => Math.min(i + 1, matches.length - 1));
        if (e.key === 'ArrowUp') setIndex(i => Math.max(i - 1, 0));
        if (e.key === 'Enter' && matches[index]) onPick(matches[index]);
    }

    return (
        <div className="overlay" onClick={onClose}>
            <div className="quick" onClick={e => e.stopPropagation()}>
                <input
                    autoFocus
                    placeholder="Go to file…"
                    value={query}
                    onChange={e => {
                        setQuery(e.target.value);
                        setIndex(0);
                    }}
                    onKeyDown={onKey}
                />
                <ul>
                    {matches.map((f, i) => (
                        <li
                            key={f.path}
                            className={i === index ? 'active' : ''}
                            onMouseEnter={() => setIndex(i)}
                            onClick={() => onPick(f)}
                        >
                            <span className={`status status-${f.status}`}>{f.status}</span>
                            <span>{f.path}</span>
                        </li>
                    ))}
                    {matches.length === 0 && <li className="none">No matching file</li>}
                </ul>
            </div>
        </div>
    );
}

// CommandPanel runs a command in the repository, such as a test command. A
// {files} placeholder is replaced with the changed paths, shell-quoted.
export function CommandPanel({repo, paths, onClose}: {
    repo: string;
    paths: string[];
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
                <button className="btn" onClick={run} disabled={running || !command.trim()}>
                    {running ? 'Running…' : 'Run'}
                </button>
                <button className="btn icon" onClick={onClose} aria-label="Close">×</button>
            </div>
            {status && <div className="cmd-status">{status}</div>}
            {output && <pre className="cmd-output">{output}</pre>}
        </section>
    );
}

// UpdateBanner offers a newer release. Download opens its GitHub page; Later hides it until the next release.
export function UpdateBanner({update, onOpen, onLater}: {
    update: main.UpdateInfo;
    onOpen: () => void;
    onLater: () => void;
}) {
    return (
        <div className="pr update" role="status">
            <span className="pr-title">Version {update.latest} is out. You have {update.current}.</span>
            <span className="spacer"/>
            <button className="btn" onClick={onOpen}>Download</button>
            <button className="btn" onClick={onLater}>Later</button>
        </div>
    );
}

export type PRView = main.PRInfo;
export type PRDiscussion = main.PRDiscussion;
export type PRThread = main.PRThread;
export type PRComment = main.PRComment;

// PRBanner shows the open pull request and what changed on it since it was last seen.
export function PRBanner({pr, newCommits, unresolved, onOpen, onSeen, onSync, onComments}: {
    pr: PRView;
    newCommits: boolean;
    unresolved: number; // open review threads on GitHub
    onOpen: () => void;
    onSeen: () => void;
    onSync?: () => void; // marks the reviewed files as viewed on GitHub; absent outside the working tree
    onComments: () => void;
}) {
    return (
        <div className="pr" role="status">
            <span className="pr-title">PR #{pr.number} {pr.title}</span>
            {pr.mergeable === 'CONFLICTING' && <span className="pr-flag bad">GitHub: conflicts</span>}
            {newCommits && <span className="pr-flag new">new commits since you last looked</span>}
            <span className="spacer"/>
            {newCommits && <button className="btn" onClick={onSeen}>Mark seen</button>}
            <button className="btn" onClick={onComments} title="Review comments on GitHub">
                Comments{unresolved > 0 ? ` (${unresolved} open)` : ''}
            </button>
            {onSync && (
                <button className="btn" onClick={onSync} title="Mark your reviewed files as viewed on GitHub">
                    Sync reviewed
                </button>
            )}
            <button className="btn" onClick={onOpen}>Open PR</button>
        </div>
    );
}

// CommentsPanel lists the review threads and conversation comments on the open pull request.
// Threads are grouped by file; a file name opens that file's diff.
export function CommentsPanel({discussion, loading, onOpenFile, onOpenURL, onRefresh, onClose}: {
    discussion: PRDiscussion | null;
    loading: boolean;
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
                <span className="cmt-title">
                    {discussion ? `PR #${discussion.number} comments` : 'PR comments'}
                </span>
                <span className="spacer"/>
                <button className="btn" onClick={onRefresh} disabled={loading}>
                    {loading ? 'Loading…' : 'Refresh'}
                </button>
                <button className="btn icon" onClick={onClose} aria-label="Close">×</button>
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
                                {t.url && <button className="btn link" onClick={() => onOpenURL(t.url)}>Open on GitHub</button>}
                            </div>
                            {t.comments.map((c, j) => (
                                <CommentBody key={j} comment={c}/>
                            ))}
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
                                {c.url && <button className="btn link" onClick={() => onOpenURL(c.url)}>Open on GitHub</button>}
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
