// Self-review: after reviewing their own branch, the reviewer can open its pull request from the
// Finish sheet. Claude may draft the title and body; the reviewer edits them, sees exactly what
// will be created, and confirms. The app never pushes: a branch origin lacks is only reported.
import {useState} from 'react';
import {Button} from './ui/button';

// Whether origin has the reviewed commits, as this clone last fetched it.
export type PushCheck = {kind: 'checking'} | {kind: 'pushed'} | {kind: 'not-pushed'; message: string};

export type SelfReview = {
    branch: string;
    base: string;
    push: PushCheck;
    title: string;
    body: string;
    drafted: boolean; // the title and body are Claude's draft, as yet unedited
    onTitle: (title: string) => void;
    onBody: (body: string) => void;
    onDraft: (() => Promise<void>) | null; // Claude drafts the title and body; null when Claude is off
    onCreate: () => Promise<string>; // opens the pull request and returns its URL
    onOpenURL: (url: string) => void;
};

type Step = {kind: 'edit'} | {kind: 'confirm'} | {kind: 'creating'} | {kind: 'created'; url: string};

export function PRCreateSection({self}: {self: SelfReview}) {
    const [step, setStep] = useState<Step>({kind: 'edit'});
    const [drafting, setDrafting] = useState(false);
    const [failure, setFailure] = useState('');
    const title = self.title.trim();
    const pushed = self.push.kind === 'pushed';

    async function draft() {
        if (!self.onDraft || drafting) return;
        setDrafting(true);
        setFailure('');
        try {
            await self.onDraft();
        } catch (e) {
            setFailure(`Claude could not draft it: ${e}`);
        } finally {
            setDrafting(false);
        }
    }

    async function create() {
        setStep({kind: 'creating'});
        setFailure('');
        try {
            setStep({kind: 'created', url: await self.onCreate()});
        } catch (e) {
            setFailure(`No pull request was created. ${e}`);
            setStep({kind: 'confirm'});
        }
    }

    return (
        <section className="self-review" aria-label="Open a pull request">
            <div className="self-review-head">Open a pull request: {self.branch} into {self.base}</div>
            {self.push.kind === 'checking' && <div className="finish-note">Checking that origin has {self.branch}…</div>}
            {self.push.kind === 'not-pushed' && <div className="finish-note" role="status">{self.push.message}</div>}
            {step.kind === 'created' ? (
                <div className="finish-actions">
                    <span>Opened {step.url}</span>
                    <span className="spacer"/>
                    <Button onClick={() => self.onOpenURL(step.url)}>Open on GitHub</Button>
                </div>
            ) : step.kind === 'edit' ? (
                <>
                    <input
                        className="self-review-title"
                        aria-label="Pull request title"
                        placeholder="Title"
                        value={self.title}
                        onChange={e => self.onTitle(e.target.value)}
                    />
                    <textarea
                        className="finish-body"
                        aria-label="Pull request description"
                        placeholder="Description (Markdown)"
                        value={self.body}
                        onChange={e => self.onBody(e.target.value)}
                    />
                    {self.drafted && <div className="draft-label">Claude · drafted from the commits and diff. Edit it before you create the pull request.</div>}
                    <div className="finish-actions">
                        {self.onDraft && (
                            <Button onClick={draft} disabled={drafting} title="Claude reads the commits and diff and drafts a title and description for you to edit">
                                {drafting ? 'Drafting…' : 'Draft PR description'}
                            </Button>
                        )}
                        <span className="spacer"/>
                        <Button onClick={() => setStep({kind: 'confirm'})} disabled={!pushed || !title}
                            title={pushed ? (title ? 'Check what will be created, then confirm' : 'Write a title first') : 'Push the branch first'}>
                            Create pull request…
                        </Button>
                    </div>
                </>
            ) : (
                <div className="self-review-confirm" role="group" aria-label="Confirm the pull request">
                    <div className="finish-note">This runs gh pr create and opens this pull request on GitHub:</div>
                    <dl>
                        <dt>Into</dt><dd><code>{self.base}</code> from <code>{self.branch}</code></dd>
                        <dt>Title</dt><dd>{title}</dd>
                        <dt>Description</dt><dd><pre>{self.body || '(empty)'}</pre></dd>
                    </dl>
                    <div className="finish-actions">
                        <span className="spacer"/>
                        <Button onClick={() => setStep({kind: 'edit'})} disabled={step.kind === 'creating'}>Back</Button>
                        <Button autoFocus onClick={create} disabled={step.kind === 'creating' || !pushed}>
                            {step.kind === 'creating' ? 'Creating…' : 'Create pull request'}
                        </Button>
                    </div>
                </div>
            )}
            {failure && <div className="finish-error" role="alert">{failure}</div>}
        </section>
    );
}
