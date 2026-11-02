import {describe, expect, it} from 'vitest';
import {
    applyServerStates, emptyRecord, isChangedSinceReview, isReviewed, nextBatch, nextUnreviewed, settleBatch, toggleReviewed,
} from './review';

describe('toggleReviewed', () => {
    it('marks at once and queues the change for GitHub', () => {
        const {record, viewed} = toggleReviewed(emptyRecord, ['a']);
        expect(viewed).toBe(true);
        expect(isReviewed(record, 'a')).toBe(true);
        expect(nextBatch(record)).toEqual({paths: ['a'], viewed: true});
    });

    it('unmarks a file GitHub already has as viewed', () => {
        const start = {states: {a: 'VIEWED'}, pending: {}};
        const {record, viewed} = toggleReviewed(start, ['a']);
        expect(viewed).toBe(false);
        expect(isReviewed(record, 'a')).toBe(false);
        expect(nextBatch(record)).toEqual({paths: ['a'], viewed: false});
    });

    it('toggling twice leaves nothing to send', () => {
        const once = toggleReviewed(emptyRecord, ['a']).record;
        expect(nextBatch(toggleReviewed(once, ['a']).record)).toBeNull();
    });

    it('a mixed selection marks only the unreviewed files', () => {
        const start = {states: {a: 'VIEWED'}, pending: {}};
        const {record} = toggleReviewed(start, ['a', 'b']);
        expect(nextBatch(record)).toEqual({paths: ['b'], viewed: true});
    });
});

describe('GitHub reads', () => {
    it('shows a file viewed on the web as reviewed', () => {
        expect(isReviewed(applyServerStates(emptyRecord, {a: 'VIEWED'}), 'a')).toBe(true);
    });

    it('keeps a pending wish over a stale read', () => {
        const pending = toggleReviewed(emptyRecord, ['a']).record;
        const read = applyServerStates(pending, {a: 'UNVIEWED'});
        expect(isReviewed(read, 'a')).toBe(true);
        expect(nextBatch(read)?.paths).toEqual(['a']);
    });

    it('clears a pending wish GitHub already agrees with', () => {
        const pending = toggleReviewed(emptyRecord, ['a']).record;
        expect(nextBatch(applyServerStates(pending, {a: 'VIEWED'}))).toBeNull();
    });

    it('flags a dismissed file as changed since review', () => {
        const read = applyServerStates(emptyRecord, {a: 'DISMISSED'});
        expect(isReviewed(read, 'a')).toBe(false);
        expect(isChangedSinceReview(read, 'a')).toBe(true);
        expect(isChangedSinceReview(toggleReviewed(read, ['a']).record, 'a')).toBe(false);
    });
});

describe('batches', () => {
    it('sends one direction at a time', () => {
        const start = {states: {b: 'VIEWED'}, pending: {a: true, b: false}};
        const first = nextBatch(start);
        expect(first).toEqual({paths: ['a'], viewed: true});
        expect(nextBatch(settleBatch(start, first!))).toEqual({paths: ['b'], viewed: false});
    });

    it('keeps a newer wish made while a request was in flight', () => {
        const queued = toggleReviewed(emptyRecord, ['a']).record;
        const batch = nextBatch(queued)!;
        const changedMind = {...queued, pending: {a: false}};
        const settled = settleBatch(changedMind, batch);
        expect(settled.states.a).toBe('VIEWED');
        expect(isReviewed(settled, 'a')).toBe(false);
        expect(nextBatch(settled)).toEqual({paths: ['a'], viewed: false});
    });
});

describe('nextUnreviewed', () => {
    const files = [{path: 'a'}, {path: 'b'}, {path: 'c'}];

    it('skips reviewed files and wraps around', () => {
        const record = {states: {c: 'VIEWED', a: 'VIEWED'}, pending: {}};
        expect(nextUnreviewed(files, record, 'b')).toBeNull();
        expect(nextUnreviewed(files, {states: {c: 'VIEWED'}, pending: {}}, 'b')?.path).toBe('a');
    });

    it('returns null when everything else is reviewed', () => {
        expect(nextUnreviewed(files, {states: {b: 'VIEWED', c: 'VIEWED'}, pending: {}}, 'a')).toBeNull();
    });
});
