// The "Claude · brief" card above the diff: what the change does, where to slow down, and what no
// test covers. Paths open their file.
import {type Brief, type BriefState, fileBrief, type RiskLevel} from './claude';
import {OwlPerch} from './mascots';
import {Kbd} from './ui/kbd';

const LEVEL_LABEL: Record<RiskLevel, string> = {low: 'low', med: 'medium', high: 'high'};

// SinceNote is the re-review's summary of what a push changed since the reviewer's review.
export type SinceNote = {kind: 'running'} | {kind: 'ready'; summary: string} | {kind: 'error'; message: string};

export function BriefCard({state, since, open, onToggle, onOpenFile}: {
    state: Exclude<BriefState, {kind: 'off'}>;
    since: SinceNote | null; // shown first, when a push landed after the reviewer's review
    open: boolean;
    onToggle: () => void;
    onOpenFile: (path: string) => void;
}) {
    return (
        <section className="brief" aria-label="Claude brief">
            <button type="button" className="brief-head" onClick={onToggle} aria-expanded={open} title="Show or hide the brief (⇧B)">
                <span className={open ? 'caret open' : 'caret'}>▸</span>
                <span className="brief-title">Claude · brief</span>
                {state.kind === 'ready' && state.costUsd !== null && <span className="brief-cost">${state.costUsd.toFixed(2)}</span>}
            </button>
            {open && since && <SinceBody since={since}/>}
            {open && <BriefBody state={state} onOpenFile={onOpenFile}/>}
        </section>
    );
}

// FileBrief sits beside the diff: what the brief says about the open file, so the warning is in
// view while the code is. The whole brief stays one key away.
export function FileBrief({brief, path, onShowBrief}: {brief: Brief; path: string; onShowBrief: () => void}) {
    const {risks, untested} = fileBrief({brief, path});
    const line = (n: number) => (n > 0 ? `Line ${n}: ` : '');
    return (
        <aside className="file-brief" aria-label="Claude on this file">
            <OwlPerch/>
            <div className="file-brief-card">
                {risks.length + untested.length === 0 && <p>Claude flagged nothing in this file.</p>}
                {risks.length > 0 && (
                    <>
                        <h2>Slow down here</h2>
                        <ul className="brief-list">
                            {risks.map((r, i) => (
                                <li key={i}><span className={`risk-dot risk-${r.level}`} title={`${LEVEL_LABEL[r.level]} risk`}>●</span>{line(r.line)}{r.why}</li>
                            ))}
                        </ul>
                    </>
                )}
                {untested.length > 0 && (
                    <>
                        <h2>No test covers</h2>
                        <ul className="brief-list">{untested.map((u, i) => <li key={i}>{line(u.line)}{u.what}</li>)}</ul>
                    </>
                )}
                <button type="button" className="file-brief-more" onClick={onShowBrief}><Kbd>⇧B</Kbd> The whole brief</button>
            </div>
        </aside>
    );
}

function SinceBody({since}: {since: SinceNote}) {
    return (
        <div className="brief-body brief-since">
            <div className="brief-label">Since your review</div>
            {since.kind === 'running' && <p className="brief-note-inline">Claude is reading what changed since your review…</p>}
            {since.kind === 'ready' && <p className="brief-summary">{since.summary}</p>}
            {since.kind === 'error' && <p className="brief-error">Claude could not read what changed: {since.message}</p>}
        </div>
    );
}

function BriefBody({state, onOpenFile}: {state: Exclude<BriefState, {kind: 'off'}>; onOpenFile: (path: string) => void}) {
    switch (state.kind) {
        case 'running':
            return <p className="brief-note">Claude is reading {state.reading ?? 'the diff'}. The brief shows here when it is done.</p>;
        case 'error':
            return <p className="brief-note brief-error">Claude could not write the brief: {state.message}</p>;
        case 'ready': {
            const {summary, risks, untested} = state.brief;
            const at = (path: string, line: number) => (
                <button type="button" className="brief-path" onClick={() => onOpenFile(path)} title={`Open ${path}`}>
                    {path}{line > 0 ? `:${line}` : ''}
                </button>
            );
            return (
                <div className="brief-body">
                    <p className="brief-summary">{summary}</p>
                    {risks.length > 0 && (
                        <>
                            <div className="brief-label">Slow down at</div>
                            <ul className="brief-list">
                                {risks.map((r, i) => (
                                    <li key={i}>
                                        <span className={`risk-dot risk-${r.level}`} title={`${LEVEL_LABEL[r.level]} risk`}>●</span>
                                        {at(r.path, r.line)} {r.why}
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                    {untested.length > 0 && (
                        <>
                            <div className="brief-label">No test covers</div>
                            <ul className="brief-list">
                                {untested.map((u, i) => <li key={i}>{at(u.path, u.line)} {u.what}</li>)}
                            </ul>
                        </>
                    )}
                </div>
            );
        }
        default: {
            const _exhaustive: never = state;
            return _exhaustive;
        }
    }
}
