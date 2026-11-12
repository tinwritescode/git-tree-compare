import {Kbd} from './ui/kbd';

// ReviewDock sits under the diff and names the keys a review runs on. Each button does what its key does.
export function ReviewDock({file, split, drafts, claude, finishTitle, onToggleReviewed, onComment, onExplain, onAsk, onHunk, onToggleSplit, onFinish}: {
    file: {reviewed: boolean} | null; // the open file; with none, only Finish is offered
    split: boolean;
    drafts: number; // draft comments waiting in the review
    claude: boolean; // whether Explain and Ask are offered
    finishTitle: string;
    onToggleReviewed: () => void;
    onComment: () => void;
    onExplain: () => void;
    onAsk: () => void;
    onHunk: (step: number) => void;
    onToggleSplit: () => void;
    onFinish: () => void;
}) {
    const off = file === null;
    return (
        <nav className="dock" aria-label="Review actions">
            <button type="button" className="dock-mark" aria-pressed={file?.reviewed ?? false} disabled={off} onClick={onToggleReviewed} title="Mark reviewed here and on GitHub (x)">
                <Kbd>x</Kbd>{file?.reviewed ? 'Reviewed' : 'Mark reviewed'}
            </button>
            <button type="button" disabled={off} onClick={onComment} title="Comment on the line you clicked, or on the file (c)"><Kbd>c</Kbd>Comment</button>
            {claude && <button type="button" disabled={off} onClick={onExplain} title="Claude explains the hunk around the line you clicked (e)"><Kbd>e</Kbd>Explain</button>}
            {claude && <button type="button" onClick={onAsk} title="Ask Claude about the change (a)"><Kbd>a</Kbd>Ask</button>}
            <button type="button" disabled={off} onClick={() => onHunk(-1)} aria-label="Previous hunk" title="Previous hunk ([)"><Kbd>[</Kbd></button>
            <button type="button" disabled={off} onClick={() => onHunk(1)} title="Next hunk (])"><Kbd>]</Kbd>Hunk</button>
            <button type="button" disabled={off} onClick={onToggleSplit} title="Toggle split view (v)"><Kbd>v</Kbd>{split ? 'Unified' : 'Split'}</button>
            <span className="dock-rule" aria-hidden="true"/>
            <button type="button" className="dock-finish" onClick={onFinish} title={finishTitle}>
                <Kbd>⌘↵</Kbd>Finish review{drafts > 0 && <span className="dock-count">{drafts}</span>}
            </button>
        </nav>
    );
}
