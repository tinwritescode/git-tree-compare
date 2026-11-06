import {describe, expect, it} from 'vitest';
import {applyServerStates, emptyRecord} from './review';
import {diffRange, fallbackNote, loadDiff, parseReviewedHeads, recordReviewedHeads, sinceHead} from './since';

const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);

describe('recordReviewedHeads', () => {
    it('notes the head each marked file was reviewed at, keeping the others', () => {
        const heads = recordReviewedHeads({heads: {a: H1, b: H1}, paths: ['a', 'c'], viewed: true, head: H2});
        expect(heads).toEqual({a: H2, b: H1, c: H2});
    });

    it('leaves the heads alone when files are unmarked', () => {
        expect(recordReviewedHeads({heads: {a: H1}, paths: ['a'], viewed: false, head: H2})).toEqual({a: H1});
    });
});

describe('parseReviewedHeads', () => {
    it('keeps string entries and drops anything else', () => {
        expect(parseReviewedHeads({a: H1, b: 3, c: null})).toEqual({a: H1});
        expect(parseReviewedHeads(null)).toEqual({});
        expect(parseReviewedHeads('x')).toEqual({});
        expect(parseReviewedHeads([H1])).toEqual({});
    });
});

describe('sinceHead', () => {
    const changed = applyServerStates(emptyRecord, {a: 'DISMISSED', b: 'VIEWED', c: 'DISMISSED'});

    it('offers the recorded head for a file a push changed after the review', () => {
        expect(sinceHead({record: changed, heads: {a: H1}, path: 'a', head: H2})).toBe(H1);
    });

    it('offers nothing without a recorded head, for a file not changed, or at the same head', () => {
        expect(sinceHead({record: changed, heads: {}, path: 'c', head: H2})).toBeNull();
        expect(sinceHead({record: changed, heads: {b: H1}, path: 'b', head: H2})).toBeNull();
        expect(sinceHead({record: changed, heads: {a: H2}, path: 'a', head: H2})).toBeNull();
    });
});

describe('diffRange', () => {
    it('shows the range since the review only when asked and available', () => {
        expect(diffRange({mode: 'since', from: H1})).toEqual({kind: 'since', from: H1});
        expect(diffRange({mode: 'since', from: null})).toEqual({kind: 'whole'});
        expect(diffRange({mode: 'whole', from: H1})).toEqual({kind: 'whole'});
    });
});

describe('loadDiff', () => {
    const whole = async () => 'whole diff';

    it('loads the whole pull request diff', async () => {
        const since = async () => ({text: 'since diff', found: true});
        expect(await loadDiff({range: {kind: 'whole'}, whole, since})).toEqual({text: 'whole diff', fallback: null});
    });

    it('loads the diff since the review', async () => {
        const since = async (from: string) => ({text: `since ${from}`, found: true});
        expect(await loadDiff({range: {kind: 'since', from: H1}, whole, since})).toEqual({text: `since ${H1}`, fallback: null});
    });

    it('falls back to the whole diff when the reviewed commit is gone', async () => {
        const since = async () => ({text: '', found: false});
        expect(await loadDiff({range: {kind: 'since', from: H1}, whole, since}))
            .toEqual({text: 'whole diff', fallback: {kind: 'gone', from: H1}});
    });

    it('falls back to the whole diff, with the reason, when git fails', async () => {
        const since = async () => {
            throw new Error('git diff: bad object');
        };
        expect(await loadDiff({range: {kind: 'since', from: H1}, whole, since}))
            .toEqual({text: 'whole diff', fallback: {kind: 'error', message: 'Error: git diff: bad object'}});
    });
});

describe('fallbackNote', () => {
    it('says why the whole pull request is shown', () => {
        expect(fallbackNote({kind: 'gone', from: H1}))
            .toBe('Showing the whole pull request: 1111111, the commit you reviewed, is not here and could not be fetched, likely after a force push.');
        expect(fallbackNote({kind: 'error', message: 'Error: boom'}))
            .toBe('Showing the whole pull request: could not read the changes since your review (Error: boom).');
    });
});
