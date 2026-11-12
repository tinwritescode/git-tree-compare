import {useEffect, useMemo, useRef, useState} from 'react';
import type {main} from '../wailsjs/go/models';
import {inboxGroups, type InboxRow, type LocalWork, nextUp, rowKey} from './inbox';
import {basename, inkShare, tickWeight, timeAgo} from './util';
import {Button} from './ui/button';
import {Kbd} from './ui/kbd';
import {ClaudeSwitch} from './claude-panel';
import {OwlPerch, OwlTray, Snail} from './mascots';

export type PR = main.PRInfo;

// PRList is the home of a repository: every open pull request, the ones asking for this reviewer
// first, and local work (the checked-out branch, recent commits) to review without one.
export function PRList({repo, prs, local, loading, error, reviewedCount, active, onOpen, onRefresh, onChangeRepo, onCommands, claude}: {
    repo: string;
    prs: PR[];
    local: LocalWork | null;
    loading: boolean;
    error: string;
    reviewedCount: (pr: PR) => number;
    active: boolean; // false while a dialog is on top, so the keys go there
    onOpen: (row: InboxRow) => void;
    onRefresh: () => void;
    onChangeRepo: () => void;
    onCommands: () => void; // opens the palette, which also reviews a commit or branch
    claude: {on: boolean; onFlip: () => void} | null; // the Claude switch; null when claude is not installed
}) {
    const [query, setQuery] = useState('');
    const [index, setIndex] = useState(0);
    const filterInput = useRef<HTMLInputElement>(null);

    const groups = useMemo(() => inboxGroups({prs, local, query}), [prs, local, query]);
    const ordered = useMemo(() => groups.flatMap(g => g.rows), [groups]);
    const current = ordered[Math.min(index, ordered.length - 1)];
    // The inbox leads with the first pull request waiting for you; a filter shows plain matches.
    const lead = query.trim() ? null : nextUp(groups);
    const waiting = groups.find(g => g.id === 'requested')?.rows.length ?? 0;
    const rowView = (row: InboxRow, isLead = false) => (
        <InboxRowView
            row={row}
            lead={isLead}
            selected={row === current}
            reviewedCount={reviewedCount}
            onOpen={() => onOpen(row)}
            onHover={() => setIndex(ordered.indexOf(row))}
        />
    );

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
                {claude && <ClaudeSwitch on={claude.on} onFlip={claude.onFlip}/>}
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
            {query.trim() !== '' && ordered.length === 0 && (
                <div className="prs-note"><span>Nothing matches “{query}”.</span></div>
            )}

            <div className="prs-scroll">
                {lead && (
                    <section className="prs-lead">
                        <h1>
                            <OwlPerch/>
                            <span>{waiting === 1 ? '1 pull request is waiting for you.' : `${waiting} pull requests are waiting for you. Start with this one.`}</span>
                        </h1>
                        {rowView(lead, true)}
                    </section>
                )}
                {groups.map(group => {
                    const rows = group.rows.filter(row => row !== lead);
                    return rows.length > 0 && (
                        <section className="prs-group" key={group.id}>
                            <h2>{lead && group.id === 'requested' ? 'Also waiting' : group.title}</h2>
                            <ul>{rows.map(row => <li key={rowKey(row)}>{rowView(row)}</li>)}</ul>
                        </section>
                    );
                })}
            </div>
        </main>
    );
}

function InboxRowView({row, lead, selected, reviewedCount, onOpen, onHover}: {
    row: InboxRow;
    lead: boolean; // the pull request the inbox leads with, drawn as a card
    selected: boolean;
    reviewedCount: (pr: PR) => number;
    onOpen: () => void;
    onHover: () => void;
}) {
    switch (row.kind) {
        case 'pr':
            return <PRRow pr={row.pr} lead={lead} selected={selected} reviewed={reviewedCount(row.pr)} onOpen={onOpen} onHover={onHover}/>;
        case 'branch':
            return (
                <LocalRow
                    mark="Branch"
                    name={`${row.branch.name} into ${row.branch.base}`}
                    sub={`${row.branch.ahead === 1 ? '1 commit' : `${row.branch.ahead} commits`} not in ${row.branch.base}, checked out`}
                    selected={selected}
                    onOpen={onOpen}
                    onHover={onHover}
                />
            );
        case 'commit':
            return (
                <LocalRow
                    mark={row.commit.short}
                    name={row.commit.subject}
                    sub={`${row.commit.author}, ${row.commit.when}`}
                    selected={selected}
                    onOpen={onOpen}
                    onHover={onHover}
                />
            );
        default: {
            const _exhaustive: never = row;
            return _exhaustive;
        }
    }
}

// LocalRow is a branch or commit to review without a pull request. Its marks stay on this machine.
function LocalRow({mark, name, sub, selected, onOpen, onHover}: {
    mark: string;
    name: string;
    sub: string;
    selected: boolean;
    onOpen: () => void;
    onHover: () => void;
}) {
    return (
        <button className={`pr-row local-row${selected ? ' selected' : ''}`} onClick={onOpen} onMouseMove={onHover}>
            <span className="pr-num">{mark}</span>
            <span className="pr-main">
                <span className="pr-name">{name}</span>
                <span className="pr-sub">{sub}</span>
            </span>
        </button>
    );
}

function PRRow({pr, lead, selected, reviewed, onOpen, onHover}: {
    pr: PR;
    lead: boolean;
    selected: boolean;
    reviewed: number;
    onOpen: () => void;
    onHover: () => void;
}) {
    return (
        <button className={`pr-row${lead ? ' lead' : ''}${selected ? ' selected' : ''}`} onClick={onOpen} onMouseMove={onHover}>
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
            {lead && <span className="pr-go">{reviewed > 0 ? 'Continue review' : 'Start review'} <Kbd>↵</Kbd></span>}
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
