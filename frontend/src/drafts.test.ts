import {describe, expect, it} from 'vitest';
import {diffRows, parseDiff} from './diff';
import {
    addDraft, checkLineTarget, type Composer, focusFor, commentableLines, countText, deleteDraft, type Draft, draftCounts, editDraft, parseDrafts, removeDrafts,
    rowTargets, staleNote, toReviewDrafts, typedFor, verdictBlock, withoutTyped, withTyped,
} from './drafts';

const HEAD = 'c0ffee';
const line = (id: string, path = 'a.go', n = 3): Draft => ({kind: 'line', id, path, line: n, side: 'RIGHT', body: `note ${id}`, head: HEAD});
const file = (id: string, path = 'a.go'): Draft => ({kind: 'file', id, path, body: `file ${id}`, head: HEAD});

describe('draft store', () => {
    it('adds, edits and deletes drafts by id', () => {
        let drafts = addDraft([], line('1'));
        drafts = addDraft(drafts, file('2'));
        drafts = editDraft(drafts, {id: '1', body: 'better words'});
        expect(drafts).toEqual([{...line('1'), body: 'better words'}, file('2')]);
        expect(deleteDraft(drafts, '1')).toEqual([file('2')]);
    });

    it('does not add a blank draft, and saving one blank deletes it', () => {
        expect(addDraft([], {...line('1'), body: '  \n'})).toEqual([]);
        expect(editDraft([line('1'), file('2')], {id: '1', body: ' '})).toEqual([file('2')]);
    });

    it('after a submit removes only the drafts that were posted', () => {
        const drafts = [line('1'), file('2'), line('3')];
        expect(removeDrafts(drafts, ['1', '2'])).toEqual([line('3')]);
    });

    it('counts drafts per file for the tree', () => {
        expect(draftCounts([line('1', 'a.go'), file('2', 'a.go'), line('3', 'b.go')])).toEqual({'a.go': 2, 'b.go': 1});
    });

    it('reads saved drafts back and drops anything malformed', () => {
        const saved: unknown = [
            line('1'),
            file('2'),
            {kind: 'line', id: '3', path: 'a.go', line: 0, side: 'RIGHT', body: 'x'},
            {kind: 'line', id: '4', path: 'a.go', line: 2, side: 'NEW', body: 'x'},
            {kind: 'file', id: '5', path: 'a.go'},
            {kind: 'hunk', id: '6', path: 'a.go', line: 2, side: 'RIGHT', body: 'x'},
            {kind: 'file', id: 7, path: 'a.go', body: 'x'},
            {kind: 'file', id: '8', path: '', body: 'x'},
            {kind: 'file', id: '9', path: 'a.go', body: ' '},
            {kind: 'line', id: '10', path: 'a.go', line: '2', side: 'RIGHT', body: 'x'},
            {kind: 'line', id: '11', path: 'a.go', line: 2.5, side: 'RIGHT', body: 'x'},
            {kind: 'line', id: '12', path: 'a.go', line: 2, side: 'LEFT', body: 'x', head: HEAD},
            line('13', 'a.go', 1),
            'junk',
            null,
        ];
        expect(parseDrafts(saved)).toEqual([line('1'), file('2'), {kind: 'line', id: '12', path: 'a.go', line: 2, side: 'LEFT', body: 'x', head: HEAD}, line('13', 'a.go', 1)]);
        expect(parseDrafts({not: 'a list'})).toEqual([]);
    });

    it('reads a draft saved before drafts kept their head as written at an unknown head', () => {
        const {head: _head, ...old} = line('1');
        expect(parseDrafts([old])).toEqual([{...line('1'), head: null}]);
        expect(parseDrafts([{...line('2'), head: ''}, {...file('3'), head: 42}])).toEqual([{...line('2'), head: null}, {...file('3'), head: null}]);
    });

    it('sends line and file drafts in the shape the backend takes', () => {
        expect(toReviewDrafts([line('1'), file('2', 'b.go')])).toEqual([
            {kind: 'line', path: 'a.go', line: 3, side: 'RIGHT', body: 'note 1'},
            {kind: 'file', path: 'b.go', line: 0, side: '', body: 'file 2'},
        ]);
    });
});

// Lines 1-9 of a file; line 5 replaced. With three lines of context GitHub shows 2-8.
const FULL = '@@ -1,9 +1,9 @@\n l1\n l2\n l3\n l4\n-old5\n+new5\n l6\n l7\n l8\n l9\n';

describe('commentableLines', () => {
    it('takes changed lines and the context GitHub shows around them', () => {
        const {RIGHT, LEFT} = commentableLines(parseDiff(FULL));
        expect([...RIGHT].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8]);
        expect([...LEFT].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    });

    it('does not reach across hunks', () => {
        const text = '@@ -1,2 +1,2 @@\n-a\n+b\n c\n@@ -20,2 +20,1 @@\n x\n-y\n';
        const {RIGHT, LEFT} = commentableLines(parseDiff(text));
        expect([...RIGHT].sort((a, b) => a - b)).toEqual([1, 2, 20]);
        expect([...LEFT].sort((a, b) => a - b)).toEqual([1, 2, 20, 21]);
    });

    it('gives the removed side only to removed lines and the added side only to added lines', () => {
        const {RIGHT, LEFT} = commentableLines(parseDiff('@@ -7 +7,2 @@\n-x\n+y\n+z\n'));
        expect([...RIGHT]).toEqual([7, 8]);
        expect([...LEFT]).toEqual([7]);
    });
});

describe('checkLineTarget', () => {
    const lines = parseDiff(FULL);

    it('accepts a line in the diff on its side', () => {
        expect(checkLineTarget({lines, range: 'whole', side: 'RIGHT', line: 5})).toEqual({kind: 'ok'});
        expect(checkLineTarget({lines, range: 'whole', side: 'LEFT', line: 5})).toEqual({kind: 'ok'});
    });

    it('refuses a line GitHub does not show', () => {
        expect(checkLineTarget({lines, range: 'whole', side: 'RIGHT', line: 1}).kind).toBe('invalid');
        expect(checkLineTarget({lines, range: 'whole', side: 'RIGHT', line: 10}).kind).toBe('invalid');
    });

    it('refuses any line while the diff shows only the changes since your review', () => {
        const result = checkLineTarget({lines, range: 'since', side: 'RIGHT', line: 5});
        expect(result.kind).toBe('invalid');
        expect(result.kind === 'invalid' && result.reason).toMatch(/Whole PR/);
    });
});

describe('rowTargets', () => {
    const text = '@@ -1,2 +1,2 @@\n a\n-b\n+c\n';

    it('places a unified line on its own side, and a context line on both', () => {
        const rows = diffRows(parseDiff(text), false);
        expect(rows.map(rowTargets)).toEqual([
            [],
            [{side: 'RIGHT', line: 1}, {side: 'LEFT', line: 1}],
            [{side: 'LEFT', line: 2}],
            [{side: 'RIGHT', line: 2}],
        ]);
    });

    it('places a split pair on the side of each half', () => {
        const rows = diffRows(parseDiff(text), true);
        expect(rows.map(rowTargets)).toEqual([
            [],
            [{side: 'RIGHT', line: 1}, {side: 'LEFT', line: 1}],
            [{side: 'RIGHT', line: 2}, {side: 'LEFT', line: 2}],
        ]);
    });
});

describe('focusFor', () => {
    const text = '@@ -1,2 +1,2 @@\n a\n-b\n+c\n+d\n';

    it('focuses the new side of a context line and the old side of a removed line', () => {
        const rows = diffRows(parseDiff(text), false);
        expect(focusFor(rows[1], 'right')).toEqual({side: 'RIGHT', line: 1});
        expect(focusFor(rows[2], 'right')).toEqual({side: 'LEFT', line: 2});
        expect(focusFor(rows[0], 'right')).toBeNull();
    });

    it('focuses the half that was clicked in split view, or the other half when that one is empty', () => {
        const rows = diffRows(parseDiff(text), true);
        expect(focusFor(rows[1], 'left')).toEqual({side: 'LEFT', line: 1});
        expect(focusFor(rows[2], 'left')).toEqual({side: 'LEFT', line: 2});
        expect(focusFor(rows[2], 'right')).toEqual({side: 'RIGHT', line: 2});
        expect(focusFor(rows[3], 'left')).toEqual({side: 'RIGHT', line: 3});
    });

    it('focuses the removed half when a split row has no added line', () => {
        const rows = diffRows(parseDiff('@@ -1,3 +1,2 @@\n a\n-b\n-x\n+c\n'), true);
        expect(focusFor(rows[3], 'right')).toEqual({side: 'LEFT', line: 3});
    });
});

describe('verdictBlock', () => {
    const base = {body: '', drafts: 0, isMine: false};

    it('lets an approval go without a summary', () => {
        expect(verdictBlock({...base, verdict: 'APPROVE'})).toBeNull();
    });

    it('asks for a summary or a comment before requesting changes or commenting', () => {
        expect(verdictBlock({...base, verdict: 'REQUEST_CHANGES'})).toMatch(/summary or a draft comment/);
        expect(verdictBlock({...base, verdict: 'COMMENT'})).toMatch(/summary or a draft comment/);
        expect(verdictBlock({...base, verdict: 'REQUEST_CHANGES', body: 'Fix the race'})).toBeNull();
        expect(verdictBlock({...base, verdict: 'REQUEST_CHANGES', drafts: 1})).toBeNull();
        expect(verdictBlock({...base, verdict: 'COMMENT', body: '  '})).not.toBeNull();
        expect(verdictBlock({...base, verdict: 'REQUEST_CHANGES', body: ' \n'})).not.toBeNull();
    });

    it('refuses approve and request changes on your own pull request, but lets you comment', () => {
        expect(verdictBlock({...base, verdict: 'APPROVE', isMine: true})).toMatch(/your own pull request/);
        expect(verdictBlock({...base, verdict: 'REQUEST_CHANGES', body: 'x', isMine: true})).toMatch(/your own pull request/);
        expect(verdictBlock({...base, verdict: 'COMMENT', body: 'x', isMine: true})).toBeNull();
    });
});

describe('countText', () => {
    it('says how many drafts will post', () => {
        expect(countText(0)).toBe('No draft comments');
        expect(countText(1)).toBe('1 draft comment will post');
        expect(countText(2)).toBe('2 draft comments will post');
    });
});

describe('typed text of an open editor', () => {
    const onLine: Composer = {kind: 'line', path: 'a.go', side: 'RIGHT', line: 3};
    const editing: Composer = {kind: 'edit', id: '1'};

    it('comes back for the same place after the editor was drawn again', () => {
        const typing = withTyped({}, {composer: onLine, body: 'half a thought'});
        expect(typedFor(typing, {composer: {...onLine}, saved: ''})).toBe('half a thought');
        expect(typedFor(typing, {composer: {...onLine, line: 4}, saved: ''})).toBe('');
        expect(typedFor(typing, {composer: {...onLine, side: 'LEFT'}, saved: ''})).toBe('');
        expect(typedFor(typing, {composer: {kind: 'file', path: 'a.go'}, saved: ''})).toBe('');
    });

    it('keeps an editor empty once its text was cleared, rather than bringing the saved draft back', () => {
        const typing = withTyped({}, {composer: editing, body: ''});
        expect(typedFor(typing, {composer: editing, saved: 'saved words'})).toBe('');
    });

    it('starts an edit from the saved draft until something is typed', () => {
        expect(typedFor({}, {composer: editing, saved: 'saved words'})).toBe('saved words');
        const typing = withTyped({}, {composer: editing, body: 'new words'});
        expect(typedFor(typing, {composer: editing, saved: 'saved words'})).toBe('new words');
        expect(typedFor(typing, {composer: {kind: 'edit', id: '2'}, saved: 'other'})).toBe('other');
    });

    it('is forgotten once the editor is saved or cancelled', () => {
        const typing = withTyped(withTyped({}, {composer: onLine, body: 'a'}), {composer: editing, body: 'b'});
        const left = withoutTyped(typing, onLine);
        expect(typedFor(left, {composer: onLine, saved: ''})).toBe('');
        expect(typedFor(left, {composer: editing, saved: ''})).toBe('b');
    });
});

describe('staleNote', () => {
    it('names the line drafts written before the latest push', () => {
        const drafts = [line('1', 'a.go', 12), {...line('2', 'b.go', 3), head: 'old'}, {...file('3', 'c.go'), head: 'old'}, {...line('4', 'd.go', 9), head: 'older'}];
        expect(staleNote(drafts, HEAD)).toBe(
            '2 draft comments were written before the latest push, and their lines may have moved: b.go line 3, d.go line 9. Edit or delete them, then submit again.',
        );
    });

    it('says nothing when every line draft was written at this head, or its head is unknown', () => {
        expect(staleNote([line('1'), {...line('2'), head: null}, {...file('3'), head: 'old'}], HEAD)).toBeNull();
    });

    it('reads in the singular for one draft', () => {
        expect(staleNote([{...line('1', 'a.go', 7), head: 'old'}], HEAD)).toBe(
            '1 draft comment was written before the latest push, and its line may have moved: a.go line 7. Edit or delete it, then submit again.',
        );
    });
});
