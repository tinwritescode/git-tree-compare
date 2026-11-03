import {useEffect, useMemo, useRef, useState} from 'react';
import type {main} from '../wailsjs/go/models';
import {basename, inkShare, tickWeight, timeAgo} from './util';
import {Button} from './ui/button';
import {Kbd} from './ui/kbd';
import {OwlTray, Snail} from './mascots';

export type PR = main.PRInfo;

const GROUPS: {id: string; title: string}[] = [
    {id: 'requested', title: 'Waiting for your review'},
    {id: 'mine', title: 'Your pull requests'},
    {id: 'other', title: 'Other open pull requests'},
];

// PRList is the home of a repository: every open pull request, the ones asking for this reviewer first.
export function PRList({repo, prs, loading, error, reviewedCount, active, onOpen, onRefresh, onChangeRepo, onCommands}: {
    repo: string;
    prs: PR[];
    loading: boolean;
    error: string;
    reviewedCount: (pr: PR) => number;
    active: boolean; // false while a dialog is on top, so the keys go there
    onOpen: (pr: PR) => void;
    onRefresh: () => void;
    onChangeRepo: () => void;
    onCommands: () => void; // opens the palette, which also reviews a commit or branch
}) {
    const [query, setQuery] = useState('');
    const [index, setIndex] = useState(0);
    const filterInput = useRef<HTMLInputElement>(null);

    const groups = useMemo(() => {
        const q = query.trim().toLowerCase();
        const found = q
            ? prs.filter(pr => `${pr.number} ${pr.title} ${pr.author} ${pr.headRefName}`.toLowerCase().includes(q))
            : prs;
        return GROUPS.map(g => ({...g, prs: found.filter(pr => pr.group === g.id)})).filter(g => g.prs.length);
    }, [prs, query]);
    const ordered = useMemo(() => groups.flatMap(g => g.prs), [groups]);
    const current = ordered[Math.min(index, ordered.length - 1)];

    useEffect(() => {
        if (!active) return;
        function onKey(e: KeyboardEvent) {
            const typing = e.target instanceof HTMLInputElement;
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === '/' && !typing) {
                e.preventDefault();
                filterInput.current?.focus();
            } else if (e.key === 'ArrowDown' || (e.key === 'j' && !typing)) {
                e.preventDefault();
                setIndex(i => Math.min(i + 1, ordered.length - 1));
            } else if (e.key === 'ArrowUp' || (e.key === 'k' && !typing)) {
                e.preventDefault();
                setIndex(i => Math.max(i - 1, 0));
            } else if (e.key === 'Enter' && current) {
                onOpen(current);
            }
        }
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [active, ordered, current, onOpen]);

    return (
        <main className="prs">
            <header className="prs-head">
                <button className="prs-repo" onClick={onChangeRepo} title={repo}>{basename(repo)}</button>
                <span className="prs-count">{prs.length === 1 ? '1 open pull request' : `${prs.length} open pull requests`}</span>
                <span className="spacer"/>
                <input
                    ref={filterInput}
                    className="filter prs-filter"
                    type="search"
                    aria-label="Filter pull requests"
                    placeholder="Filter (/)"
                    value={query}
                    onChange={e => {
                        setQuery(e.target.value);
                        setIndex(0);
                    }}
                />
                <Button onClick={onRefresh} disabled={loading} title="Refresh (r)">{loading ? 'Loading…' : 'Refresh'}</Button>
                <Button onClick={onCommands} title="All commands, including reviewing a commit or branch">Commands <Kbd>⌘K</Kbd></Button>
            </header>

            {error && (
                <div className="prs-note" role="alert">
                    <strong>Could not read pull requests.</strong>
                    <span>{error}</span>
                    <span>Check that this repository is on GitHub and that <code>gh auth status</code> shows you logged in.</span>
                </div>
            )}
            {!error && loading && prs.length === 0 && (
                <div className="prs-note mascot-state" role="status">
                    <Snail/>
                    <strong>Fetching pull requests…</strong>
                </div>
            )}
            {!error && !loading && prs.length === 0 && (
                <div className="prs-note mascot-state">
                    <OwlTray/>
                    <strong>No open pull requests.</strong>
                    <span>When one opens on GitHub it appears here within a minute.</span>
                </div>
            )}
            {!error && prs.length > 0 && ordered.length === 0 && (
                <div className="prs-note"><span>Nothing matches “{query}”.</span></div>
            )}

            <div className="prs-scroll">
                {groups.map(group => (
                    <section className="prs-group" key={group.id}>
                        <h2>{group.title}</h2>
                        <ul>
                            {group.prs.map(pr => (
                                <li key={pr.number}>
                                    <PRRow
                                        pr={pr}
                                        selected={pr === current}
                                        reviewed={reviewedCount(pr)}
                                        onOpen={() => onOpen(pr)}
                                        onHover={() => setIndex(ordered.indexOf(pr))}
                                    />
                                </li>
                            ))}
                        </ul>
                    </section>
                ))}
            </div>
        </main>
    );
}

function PRRow({pr, selected, reviewed, onOpen, onHover}: {
    pr: PR;
    selected: boolean;
    reviewed: number;
    onOpen: () => void;
    onHover: () => void;
}) {
    return (
        <button className={`pr-row${selected ? ' selected' : ''}`} onClick={onOpen} onMouseMove={onHover}>
            <span className="pr-num">{pr.number}</span>
            <span className="pr-main">
                <span className="pr-name">
                    {pr.title}
                    {pr.isDraft && <span className="pr-tag">Draft</span>}
                    {pr.mergeable === 'CONFLICTING' && <span className="pr-tag bad">Conflicts</span>}
                    {pr.reviewDecision === 'APPROVED' && <span className="pr-tag good">Approved</span>}
                    {pr.reviewDecision === 'CHANGES_REQUESTED' && <span className="pr-tag bad">Changes requested</span>}
                </span>
                <span className="pr-sub">{pr.author} wants {pr.headRefName} in {pr.baseRefName}, updated {timeAgo(pr.updatedAt)}</span>
            </span>
            <SizeBars added={pr.additions} deleted={pr.deletions}/>
            <ReviewMeter done={reviewed} total={pr.changedFiles}/>
        </button>
    );
}

// SizeBars shows a pull request's size: one bar for added lines over one for deleted.
function SizeBars({added, deleted}: {added: number; deleted: number}) {
    return (
        <span className="size" role="img" aria-label={`${added} lines added, ${deleted} lines deleted`}>
            <span className="size-bars">
                <span className="bar-add" style={{width: `${inkShare(added)}%`}}/>
                <span className="bar-del" style={{width: `${inkShare(deleted)}%`}}/>
            </span>
            <span className="size-text"><span className="added">+{added}</span> <span className="deleted">−{deleted}</span></span>
        </span>
    );
}

// ReviewRuler is the whole pull request at a glance: one cell per file, in tree order.
// A cell is wider the more lines changed, and turns amber when reviewed.
export function ReviewRuler({files, current, reviewed, changed, onPick}: {
    files: {path: string; added: number; deleted: number}[];
    current?: string;
    reviewed: Record<string, string>;
    changed: Set<string>;
    onPick: (path: string) => void;
}) {
    return (
        <nav className="ruler" aria-label="Files in this pull request">
            {files.map(f => {
                const state = reviewed[f.path] ? 'reviewed' : changed.has(f.path) ? 'changed since review' : 'not reviewed';
                const classes = ['ruler-tick', reviewed[f.path] && 'done', changed.has(f.path) && 'changed', f.path === current && 'current']
                    .filter(Boolean).join(' ');
                return (
                    <button
                        key={f.path}
                        className={classes}
                        aria-label={`${f.path}, ${state}`}
                        aria-current={f.path === current ? 'true' : undefined}
                        title={f.path}
                        tabIndex={-1}
                        style={{flexGrow: tickWeight(f.added + f.deleted)}}
                        onClick={() => onPick(f.path)}
                    />
                );
            })}
        </nav>
    );
}

// ReviewMeter shows review progress with one tick per file, or a bar when there are too many to count.
export function ReviewMeter({done, total}: {done: number; total: number}) {
    const label = `${done} of ${total} files reviewed`;
    return (
        <span className="meter" role="img" aria-label={label} title={label}>
            {total <= 24
                ? Array.from({length: total}, (_, i) => <span key={i} className={i < done ? 'tick on' : 'tick'}/>)
                : <span className="meter-bar"><span style={{width: `${(done / total) * 100}%`}}/></span>}
            <span className="meter-text">{done}/{total}</span>
        </span>
    );
}
