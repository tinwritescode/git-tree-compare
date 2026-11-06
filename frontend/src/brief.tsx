// The "Claude · brief" card above the diff: what the change does, where to slow down, and what no
// test covers. Paths open their file.
import {type BriefState, type RiskLevel} from './claude';

const LEVEL_LABEL: Record<RiskLevel, string> = {low: 'low', med: 'medium', high: 'high'};

export function BriefCard({state, open, onToggle, onOpenFile}: {
    state: Exclude<BriefState, {kind: 'off'}>;
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
            {open && <BriefBody state={state} onOpenFile={onOpenFile}/>}
        </section>
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
