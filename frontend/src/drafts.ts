// The pending review: comments drafted on lines and files, kept on this machine until the
// reviewer finishes the review, then posted in one request. Also which lines GitHub accepts a
// comment on, and which verdicts the Finish sheet lets through.
import type {main} from '../wailsjs/go/models';
import type {DiffRow, Line} from './diff';

export type Side = 'RIGHT' | 'LEFT'; // RIGHT is the head, LEFT the base
// head is the commit the draft was written against; null for drafts saved before it was kept.
export type Draft =
    | {kind: 'line'; id: string; path: string; line: number; side: Side; body: string; head: string | null}
    | {kind: 'file'; id: string; path: string; body: string; head: string | null};

export function addDraft(drafts: Draft[], draft: Draft): Draft[] {
    return draft.body.trim() ? [...drafts, draft] : drafts;
}

// editDraft replaces a draft's text. Saving it blank deletes it.
export function editDraft(drafts: Draft[], {id, body}: {id: string; body: string}): Draft[] {
    if (!body.trim()) return deleteDraft(drafts, id);
    return drafts.map(d => (d.id === id ? {...d, body} : d));
}

export function deleteDraft(drafts: Draft[], id: string): Draft[] {
    return drafts.filter(d => d.id !== id);
}

// removeDrafts drops the drafts a submitted review posted. Drafts written meanwhile stay.
export function removeDrafts(drafts: Draft[], ids: string[]): Draft[] {
    const posted = new Set(ids);
    return drafts.filter(d => !posted.has(d.id));
}

export function draftCounts(drafts: Draft[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const d of drafts) counts[d.path] = (counts[d.path] ?? 0) + 1;
    return counts;
}

// parseDrafts reads saved drafts back, dropping any entry that is not a whole draft.
export function parseDrafts(value: unknown): Draft[] {
    return Array.isArray(value) ? value.flatMap(v => {
        const d = parseDraft(v);
        return d ? [d] : [];
    }) : [];
}

function parseDraft(v: unknown): Draft | null {
    if (typeof v !== 'object' || v === null) return null;
    const kind = field(v, 'kind');
    const id = field(v, 'id');
    const path = field(v, 'path');
    const body = field(v, 'body');
    if (typeof id !== 'string' || typeof path !== 'string' || !path || typeof body !== 'string' || !body.trim()) return null;
    const saved = field(v, 'head');
    const head = typeof saved === 'string' && saved ? saved : null;
    if (kind === 'file') return {kind, id, path, body, head};
    const line = field(v, 'line');
    const side = field(v, 'side');
    if (kind !== 'line' || typeof line !== 'number' || !Number.isInteger(line) || line < 1 || (side !== 'RIGHT' && side !== 'LEFT')) return null;
    return {kind, id, path, line, side, body, head};
}

function field(v: object, key: string): unknown {
    return Object.getOwnPropertyDescriptor(v, key)?.value;
}

// toReviewDrafts is what SubmitReview takes. A file draft has no line or side.
export function toReviewDrafts(drafts: Draft[]): main.ReviewDraft[] {
    return drafts.map(d => {
        switch (d.kind) {
            case 'line':
                return {kind: d.kind, path: d.path, line: d.line, side: d.side, body: d.body};
            case 'file':
                return {kind: d.kind, path: d.path, line: 0, side: '', body: d.body};
            default: {
                const _exhaustive: never = d;
                return _exhaustive;
            }
        }
    });
}

// staleNote names the line drafts written against an older head, for when GitHub refuses a
// review: a push since may have moved their lines. A draft whose head is unknown is not named.
export function staleNote(drafts: Draft[], head: string): string | null {
    const stale = drafts.flatMap(d => (d.kind === 'line' && d.head !== null && d.head !== head ? [`${d.path} line ${d.line}`] : []));
    if (!stale.length) return null;
    const one = stale.length === 1;
    return `${stale.length} draft comment${one ? ' was' : 's were'} written before the latest push, and ${one ? 'its line' : 'their lines'} may have moved: `
        + `${stale.join(', ')}. Edit or delete ${one ? 'it' : 'them'}, then submit again.`;
}

// What the draft editor is writing: a new comment on a line or a file, or a saved draft.
export type Composer = {kind: 'line'; path: string; side: Side; line: number} | {kind: 'file'; path: string} | {kind: 'edit'; id: string};

// Typing is the text typed into draft editors that are not saved yet, by what each is writing. It
// outlives the editor, which goes away when its diff row scrolls out of view.
export type Typing = Readonly<Record<string, string>>;

function composerKey(c: Composer): string {
    switch (c.kind) {
        case 'line':
            return JSON.stringify([c.kind, c.path, c.side, c.line]);
        case 'file':
            return JSON.stringify([c.kind, c.path]);
        case 'edit':
            return JSON.stringify([c.kind, c.id]);
        default: {
            const _exhaustive: never = c;
            return _exhaustive;
        }
    }
}

// typedFor is what an editor for composer starts with: what was typed into it, else the saved text.
export function typedFor(typing: Typing, {composer, saved}: {composer: Composer; saved: string}): string {
    return typing[composerKey(composer)] ?? saved;
}

export function withTyped(typing: Typing, {composer, body}: {composer: Composer; body: string}): Typing {
    return {...typing, [composerKey(composer)]: body};
}

export function withoutTyped(typing: Typing, composer: Composer): Typing {
    const {[composerKey(composer)]: _gone, ...rest} = typing;
    return rest;
}

// GitHub's diff shows three lines of context around each change; only those lines take a comment.
const GITHUB_CONTEXT = 3;

// commentableLines lists the lines of each side a comment can go on: every changed line, and the
// context lines GitHub's own diff shows. It works on a full-file diff too, where git shows more
// context than GitHub. With whitespace ignored it can only be stricter than GitHub, never looser.
export function commentableLines(lines: Line[]): Record<Side, Set<number>> {
    const out: Record<Side, Set<number>> = {RIGHT: new Set(), LEFT: new Set()};
    const hunks: Line[][] = [];
    for (const l of lines) {
        if (l.kind === 'hunk') hunks.push([]);
        else hunks[hunks.length - 1]?.push(l);
    }
    for (const hunk of hunks) {
        const changes = hunk.flatMap((l, i) => (l.kind === 'add' || l.kind === 'del' ? [i] : []));
        hunk.forEach((l, i) => {
            if (l.kind === 'ctx' && !changes.some(c => Math.abs(c - i) <= GITHUB_CONTEXT)) return;
            // A removed line has only an old number, an added line only a new one.
            if (l.newNo !== undefined) out.RIGHT.add(l.newNo);
            if (l.oldNo !== undefined) out.LEFT.add(l.oldNo);
        });
    }
    return out;
}

export type TargetCheck = {kind: 'ok'} | {kind: 'invalid'; reason: string};

// checkLineTarget says whether a line comment can go on line of side in the diff on screen. A diff
// of only the changes since your review is not the pull request's diff, so it takes none.
export function checkLineTarget({lines, range, side, line}: {
    lines: Line[];
    range: 'whole' | 'since';
    side: Side;
    line: number;
}): TargetCheck {
    if (range === 'since') return {kind: 'invalid', reason: 'Switch to Whole PR (s) to comment on a line.'};
    if (commentableLines(lines)[side].has(line)) return {kind: 'ok'};
    return {kind: 'invalid', reason: `GitHub takes comments only on changed lines and the 3 lines around them. Line ${line} is not one.`};
}

// rowTargets lists the line positions a drawn row stands for, where its drafts show and a click
// focuses. A context line is on both sides; in split view each half is its own side.
export function rowTargets(row: DiffRow): {side: Side; line: number}[] {
    switch (row.kind) {
        case 'hunk':
            return [];
        case 'line':
            return lineTargets(row.line, row.line);
        case 'pair':
            return lineTargets(row.row.right, row.row.left);
        default: {
            const _exhaustive: never = row;
            return _exhaustive;
        }
    }
}

// focusFor is the line a click on a row focuses for a comment. half is the split-view half that
// was clicked; unified rows have one line, so it only matters there.
export function focusFor(row: DiffRow, half: 'left' | 'right'): {side: Side; line: number} | null {
    const targets = rowTargets(row);
    const wanted: Side = half === 'left' ? 'LEFT' : 'RIGHT';
    if (row.kind === 'pair') return targets.find(t => t.side === wanted) ?? targets[0] ?? null;
    return targets[0] ?? null;
}

function lineTargets(right: Line | null, left: Line | null): {side: Side; line: number}[] {
    const out: {side: Side; line: number}[] = [];
    // A removed line has only an old number, an added line only a new one, a meta line neither.
    if (right?.newNo !== undefined) out.push({side: 'RIGHT', line: right.newNo});
    if (left?.oldNo !== undefined) out.push({side: 'LEFT', line: left.oldNo});
    return out;
}

export type Verdict = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

// verdictBlock says why the review cannot be submitted with this verdict, or null when it can.
export function verdictBlock({verdict, body, drafts, isMine}: {verdict: Verdict; body: string; drafts: number; isMine: boolean}): string | null {
    switch (verdict) {
        case 'APPROVE':
            return isMine ? 'GitHub does not let you approve your own pull request.' : null;
        case 'REQUEST_CHANGES':
            if (isMine) return 'GitHub does not let you request changes on your own pull request.';
            return body.trim() || drafts ? null : 'Requesting changes needs a summary or a draft comment.';
        case 'COMMENT':
            return body.trim() || drafts ? null : 'A comment review needs a summary or a draft comment.';
        default: {
            const _exhaustive: never = verdict;
            return _exhaustive;
        }
    }
}

export function countText(drafts: number): string {
    if (!drafts) return 'No draft comments';
    return `${drafts} draft comment${drafts === 1 ? '' : 's'} will post`;
}
