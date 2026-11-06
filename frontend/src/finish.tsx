// The pending review on screen: draft comments in the diff, their editor, and the Finish sheet
// that submits them with a verdict (pull requests) or hands the review off (commits and branches).
import {type KeyboardEvent, useState} from 'react';
import {countText, type Draft, type Verdict, verdictBlock} from './drafts';
import {Button} from './ui/button';
import {Kbd} from './ui/kbd';

// DraftEditor writes or edits one draft comment. ⌘↵ saves, Esc cancels. It starts from typed, the
// text it held before its row scrolled away, and reports each change with onType.
export function DraftEditor({initial, typed, label, placeholder, onType, onSave, onCancel}: {
    initial: string; // the saved draft's text, or empty for a new one
    typed: string;
    label: string;
    placeholder: string;
    onType: (body: string) => void;
    onSave: (body: string) => void;
    onCancel: () => void;
}) {
    const [body, setBody] = useState(typed);
    function change(next: string) {
        setBody(next);
        onType(next);
    }
    function onKey(e: KeyboardEvent) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            onSave(body);
        }
        if (e.key === 'Escape') onCancel();
    }
    return (
        <div className="draft draft-editor">
            <textarea autoFocus value={body} placeholder={placeholder} onChange={e => change(e.target.value)} onKeyDown={onKey}/>
            <div className="draft-actions">
                <span className="draft-label">{label}</span>
                <span className="spacer"/>
                <Button onClick={onCancel}>Cancel</Button>
                <Button onClick={() => onSave(body)} disabled={!body.trim() && !initial}>Save draft <Kbd>⌘↵</Kbd></Button>
            </div>
        </div>
    );
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
        onSubmit: () => Promise<void>; staleNote: string | null} // staleNote names drafts written before the latest push
    | {kind: 'local'; onCopySummary: () => void; onExportPatch: () => void};

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
                    onType={controls.type} onSave={controls.save} onCancel={controls.cancel}/>
                : <DraftCard key={d.id} draft={d} label={label} onEdit={() => controls.edit(d.id)} onDelete={() => controls.remove(d.id)}/>))}
            {adding && <DraftEditor initial="" typed={controls.typed('')} label={label} placeholder={placeholder}
                onType={controls.type} onSave={controls.save} onCancel={controls.cancel}/>}
        </div>
    );
}
