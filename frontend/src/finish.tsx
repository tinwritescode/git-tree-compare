// The pending review on screen: draft comments in the diff, their editor, and the Finish sheet
// that submits them with a verdict (pull requests) or hands the review off (commits and branches).
import {type KeyboardEvent, useEffect, useRef, useState} from 'react';
import type {ClaudeEvent} from './claude';
import {countText, type Draft, type Verdict, verdictBlock} from './drafts';
import {type PolishState, polishStep, wordDiff} from './polish';
import {PRCreateSection, type SelfReview} from './selfreview';
import {Button} from './ui/button';
import {Kbd} from './ui/kbd';

// Polisher asks Claude to rewrite a draft, reporting its events, and returns a function that stops it.
export type Polisher = (req: {body: string; onEvent: (event: ClaudeEvent) => void}) => () => void;

// DraftEditor writes or edits one draft comment. ⌘↵ saves, Esc cancels, ⌘⇧P asks Claude to polish
// it. It starts from typed, the text it held before its row scrolled away, and reports each change
// with onType. A polish shows as a word diff and changes the text only when the reviewer accepts it.
export function DraftEditor({initial, typed, label, placeholder, polisher, onType, onSave, onCancel}: {
    initial: string; // the saved draft's text, or empty for a new one
    typed: string;
    label: string;
    placeholder: string;
    polisher: Polisher | null; // null when Claude is off
    onType: (body: string) => void;
    onSave: (body: string) => void;
    onCancel: () => void;
}) {
    const [body, setBody] = useState(typed);
    const [polish, setPolish] = useState<PolishState>({kind: 'idle'});
    const stopPolish = useRef<(() => void) | null>(null);
    // A polish still running when the editor goes away is stopped.
    useEffect(() => () => stopPolish.current?.(), []);

    function change(next: string) {
        setBody(next);
        onType(next);
    }
    function startPolish() {
        if (!polisher || !body.trim() || polish.kind === 'running') return;
        const original = body;
        setPolish({kind: 'running', original});
        stopPolish.current = polisher({body: original, onEvent: event => setPolish(s => polishStep(s, event))});
    }
    function endPolish(accept: boolean) {
        if (accept && polish.kind === 'ready') change(polish.rewrite);
        stopPolish.current?.();
        stopPolish.current = null;
        setPolish({kind: 'idle'});
    }
    function onKey(e: KeyboardEvent) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            onSave(body);
        }
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
            // ⌘P outside the editor is Go to file; here it is Claude's.
            e.preventDefault();
            e.stopPropagation();
            startPolish();
        }
        if (e.key === 'Escape') onCancel();
    }
    return (
        <div className="draft draft-editor">
            <textarea autoFocus value={body} placeholder={placeholder} onChange={e => change(e.target.value)} onKeyDown={onKey}/>
            {polish.kind !== 'idle' && <PolishView polish={polish} onEnd={endPolish}/>}
            <div className="draft-actions">
                <span className="draft-label">{label}</span>
                <span className="spacer"/>
                {polisher && (
                    <Button onClick={startPolish} disabled={!body.trim() || polish.kind === 'running'} title="Claude rewrites it; you choose whether to keep the rewrite (⌘⇧P)">
                        Polish <Kbd>⌘⇧P</Kbd>
                    </Button>
                )}
                <Button onClick={onCancel}>Cancel</Button>
                <Button onClick={() => onSave(body)} disabled={!body.trim() && !initial}>Save draft <Kbd>⌘↵</Kbd></Button>
            </div>
        </div>
    );
}

// PolishView shows Claude's rewrite as a word diff against the reviewer's words.
function PolishView({polish, onEnd}: {polish: Exclude<PolishState, {kind: 'idle'}>; onEnd: (accept: boolean) => void}) {
    switch (polish.kind) {
        case 'running':
            return <div className="claude-answer polish"><div className="claude-label">Claude · polish</div><p className="claude-tool">Rewriting your draft…</p></div>;
        case 'error':
            return (
                <div className="claude-answer polish">
                    <div className="claude-label">Claude · polish</div>
                    <p className="claude-error">Claude could not polish it: {polish.message}</p>
                    <div className="draft-actions"><span className="spacer"/><Button onClick={() => onEnd(false)}>Close</Button></div>
                </div>
            );
        case 'ready':
            return (
                <div className="claude-answer polish">
                    <div className="claude-label">Claude · polish</div>
                    <p className="polish-diff">
                        {wordDiff(polish.original, polish.rewrite).map((part, i) => (
                            part.kind === 'same' ? <span key={i}>{part.text}</span> : <span key={i} className={`polish-${part.kind}`}>{part.text}</span>
                        ))}
                    </p>
                    <div className="draft-actions">
                        <span className="spacer"/>
                        <Button onClick={() => onEnd(false)}>Keep mine</Button>
                        <Button onClick={() => onEnd(true)}>Accept</Button>
                    </div>
                </div>
            );
        default: {
            const _exhaustive: never = polish;
            return _exhaustive;
        }
    }
}

// DraftCard is a saved draft, outlined so it does not read as something already on GitHub.
export function DraftCard({draft, label, onEdit, onDelete}: {
    draft: Draft;
    label: string;
    onEdit: () => void;
    onDelete: () => void;
}) {
    return (
        <div className="draft">
            <div className="cmt-meta">
                <span className="draft-label">{label}</span>
                <span className="spacer"/>
                <Button variant="link" onClick={onEdit}>Edit</Button>
                <Button variant="link" onClick={onDelete}>Delete</Button>
            </div>
            <div className="cmt-body">{draft.body}</div>
        </div>
    );
}

export type FinishMode =
    | {kind: 'pr'; isMine: boolean; verdict: Verdict; body: string; onVerdict: (v: Verdict) => void; onBody: (body: string) => void;
        onSubmit: () => Promise<void>; staleNote: string | null; // staleNote names drafts written before the latest push
        onDraftSummary: (() => Promise<string>) | null} // Claude's summary from the drafts and verdict; null when Claude is off
    | {kind: 'local'; onCopySummary: () => void; onExportPatch: () => void; selfReview: SelfReview | null}; // selfReview: a branch

const VERDICTS: {verdict: Verdict; label: string; hint: string}[] = [
    {verdict: 'COMMENT', label: 'Comment', hint: 'Feedback without a verdict'},
    {verdict: 'APPROVE', label: 'Approve', hint: 'Ready to merge'},
    {verdict: 'REQUEST_CHANGES', label: 'Request changes', hint: 'Needs work before it merges'},
];

// FinishSheet ends a review. For a pull request it posts the verdict, summary and drafts in one
// request; a failure keeps everything as it was and shows what GitHub said.
export function FinishSheet({mode, drafts, onClose}: {mode: FinishMode; drafts: number; onClose: () => void}) {
    const [submitting, setSubmitting] = useState(false);
    const [failure, setFailure] = useState('');
    const [drafting, setDrafting] = useState<{kind: 'idle'} | {kind: 'running'} | {kind: 'drafted'} | {kind: 'error'; message: string}>({kind: 'idle'});
    const blocked = mode.kind === 'pr' ? verdictBlock({verdict: mode.verdict, body: mode.body, drafts, isMine: mode.isMine}) : null;

    async function submit() {
        if (mode.kind !== 'pr' || blocked || submitting) return;
        setSubmitting(true);
        setFailure('');
        try {
            await mode.onSubmit();
        } catch (e) {
            setFailure(String(e));
            setSubmitting(false);
        }
    }

    // Fills the summary box with Claude's draft, for the reviewer to edit. It never submits.
    async function draftSummary() {
        if (mode.kind !== 'pr' || !mode.onDraftSummary || drafting.kind === 'running') return;
        setDrafting({kind: 'running'});
        try {
            mode.onBody(await mode.onDraftSummary());
            setDrafting({kind: 'drafted'});
        } catch (e) {
            setDrafting({kind: 'error', message: String(e)});
        }
    }

    function onKey(e: KeyboardEvent) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            submit();
        }
        if (e.key === 'Escape' && !submitting) onClose();
    }

    return (
        <div className="overlay" onClick={submitting ? undefined : onClose}>
            <div className="finish" role="dialog" aria-label="Finish review" onClick={e => e.stopPropagation()} onKeyDown={onKey}>
                <div className="shortcuts-head">
                    <span>Finish review</span>
                    <Button size="icon" onClick={onClose} disabled={submitting} aria-label="Close">×</Button>
                </div>
                {mode.kind === 'pr' ? (
                    <>
                        <div className="finish-verdicts" role="radiogroup" aria-label="Verdict">
                            {VERDICTS.map(v => {
                                const refused = mode.isMine && v.verdict !== 'COMMENT';
                                return (
                                    <label key={v.verdict} className={refused ? 'finish-verdict refused' : 'finish-verdict'}
                                        title={refused ? 'GitHub does not let you do this on your own pull request' : v.hint}>
                                        <input
                                            type="radio"
                                            name="verdict"
                                            checked={mode.verdict === v.verdict}
                                            disabled={refused || submitting}
                                            onChange={() => mode.onVerdict(v.verdict)}
                                        />
                                        <span>{v.label}</span>
                                    </label>
                                );
                            })}
                        </div>
                        {mode.isMine && <div className="finish-note">This is your pull request, so GitHub only lets you comment.</div>}
                        <textarea
                            autoFocus
                            className="finish-body"
                            placeholder="Summary for the author (optional for Approve)"
                            value={mode.body}
                            disabled={submitting}
                            onChange={e => mode.onBody(e.target.value)}
                        />
                        {mode.onDraftSummary && (
                            <div className="finish-claude">
                                <Button onClick={draftSummary} disabled={submitting || drafting.kind === 'running'}
                                    title="Claude writes a summary from your draft comments and verdict. You edit it; nothing posts until you submit.">
                                    {drafting.kind === 'running' ? 'Drafting…' : mode.body.trim() ? 'Redraft summary with Claude' : 'Draft summary with Claude'}
                                </Button>
                                {drafting.kind === 'drafted' && <span className="draft-label">Claude · drafted from your comments. Edit it before you submit.</span>}
                                {drafting.kind === 'error' && <span className="claude-error">Claude could not draft it: {drafting.message}</span>}
                            </div>
                        )}
                        <div className="finish-count">{countText(drafts)}</div>
                        {blocked && <div className="finish-note" role="status">{blocked}</div>}
                        {failure && <div className="finish-error" role="alert">Nothing was posted. {failure}</div>}
                        {failure && mode.staleNote && <div className="finish-note" role="status">{mode.staleNote}</div>}
                        <div className="finish-actions">
                            <span className="spacer"/>
                            <Button onClick={onClose} disabled={submitting}>Keep reviewing</Button>
                            <Button onClick={submit} disabled={!!blocked || submitting}>
                                {submitting ? 'Submitting…' : 'Submit review'} <Kbd>⌘↵</Kbd>
                            </Button>
                        </div>
                    </>
                ) : (
                    <>
                        <div className="finish-count">
                            {drafts ? `${drafts} draft comment${drafts === 1 ? '' : 's'} in the summary.` : 'No draft comments.'}
                        </div>
                        <div className="finish-actions">
                            <span className="spacer"/>
                            <Button onClick={mode.onExportPatch}>Export patch</Button>
                            <Button autoFocus onClick={mode.onCopySummary}>Copy summary</Button>
                        </div>
                        {mode.selfReview && <PRCreateSection self={mode.selfReview}/>}
                    </>
                )}
            </div>
        </div>
    );
}

// DraftControls change the pending review from inside the diff. They are stable across renders,
// so the memoised diff view does not redraw for them.
export type DraftControls = {
    save: (body: string) => void; // what the open editor holds
    cancel: () => void;
    typed: (saved: string) => string; // what the open editor held, else saved
    type: (body: string) => void; // the open editor's text changed
    edit: (id: string) => void;
    remove: (id: string) => void;
    polish: Polisher | null; // null when Claude is off
};

// DraftStack is the drafts at one place, a line or the file, each as a card or, while it is
// being edited, an editor. adding opens an editor for a new draft below them.
export function DraftStack({drafts, editing, adding, label, placeholder, controls}: {
    drafts: Draft[];
    editing: string | null; // id of the draft being edited
    adding: boolean;
    label: string;
    placeholder: string;
    controls: DraftControls;
}) {
    return (
        <div className="draft-stack">
            {drafts.map(d => (d.id === editing
                ? <DraftEditor key={d.id} initial={d.body} typed={controls.typed(d.body)} label={label} placeholder={placeholder}
                    polisher={controls.polish} onType={controls.type} onSave={controls.save} onCancel={controls.cancel}/>
                : <DraftCard key={d.id} draft={d} label={label} onEdit={() => controls.edit(d.id)} onDelete={() => controls.remove(d.id)}/>))}
            {adding && <DraftEditor initial="" typed={controls.typed('')} label={label} placeholder={placeholder}
                polisher={controls.polish} onType={controls.type} onSave={controls.save} onCancel={controls.cancel}/>}
        </div>
    );
}
