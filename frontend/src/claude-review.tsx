// Claude in the diff: a finding's card under its line, and Claude's read on a review thread. Both
// carry the dashed accent and a Claude label, and act only on the reviewer's click.
import {type Finding, findingLabel} from './findings';
import {type ThreadCheck, threadChip} from './rereview';
import {Button} from './ui/button';
import {Kbd} from './ui/kbd';

// FindingControls act on a finding by its key. They are stable, so the memoised diff does not redraw for them.
export type FindingControls = {
    focus: (key: string) => void;
    accept: (key: string) => void; // becomes a draft comment
    dismiss: (key: string) => void; // hidden for this head
    why: (key: string) => void; // asks Claude in the Ask panel
};

export function FindingCard({finding, focused, controls}: {finding: Finding; focused: boolean; controls: FindingControls}) {
    const {key} = finding;
    return (
        <div className={focused ? 'claude-answer finding focused' : 'claude-answer finding'} onClick={() => controls.focus(key)}>
            <div className="claude-label">
                <span>Claude · {findingLabel(finding.kind)}</span>
                <span className="brief-cost" title="How sure Claude is, after checking">{Math.round(finding.confidence * 100)}% sure</span>
            </div>
            <div className="finding-title">{finding.title}</div>
            {finding.body && <div className="cmt-body">{finding.body}</div>}
            <div className="draft-actions" onClick={e => e.stopPropagation()}>
                <Button variant="link" onClick={() => controls.why(key)} title="Ask Claude why, in the Ask panel">Why?</Button>
                <span className="spacer"/>
                <Button onClick={() => controls.dismiss(key)} title="Hide this finding for this head (d)">Dismiss <Kbd>d</Kbd></Button>
                <Button onClick={() => controls.accept(key)} title="Turn it into a draft comment you can edit (y)">Accept <Kbd>y</Kbd></Button>
            </div>
        </div>
    );
}

// ThreadCheckView is Claude's read on whether a push answered a thread. Resolving stays the reviewer's click.
export function ThreadCheckView({check}: {check: ThreadCheck}) {
    return (
        <div className={`thread-check ${check.status}`}>
            <span className="thread-check-chip">{threadChip(check.status)}</span>
            {check.evidence && <span className="thread-check-evidence">{check.evidence}</span>}
            {check.status === 'addressed' && <span className="thread-check-hint">Resolve it below if you agree.</span>}
        </div>
    );
}
