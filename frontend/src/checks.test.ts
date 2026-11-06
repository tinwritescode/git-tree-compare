import {describe, expect, it} from 'vitest';
import {checkChip, checksSummary} from './checks';

const check = (name: string, bucket: string, state = 'X') => ({name, bucket, state, link: ''});

describe('checkChip', () => {
    it('labels each of gh buckets', () => {
        expect(['pass', 'fail', 'pending', 'skipping', 'cancel'].map(b => checkChip(check('c', b)))).toEqual([
            {kind: 'pass', label: 'Passed'},
            {kind: 'fail', label: 'Failed'},
            {kind: 'pending', label: 'Running'},
            {kind: 'neutral', label: 'Skipped'},
            {kind: 'neutral', label: 'Cancelled'},
        ]);
    });

    it('shows the state of a bucket it does not know', () => {
        expect(checkChip(check('c', 'mystery', 'STALE'))).toEqual({kind: 'neutral', label: 'stale'});
    });
});

describe('checksSummary', () => {
    it('counts failed, running and passed checks', () => {
        const checks = [check('a', 'pass'), check('b', 'fail'), check('c', 'pending'), check('d', 'pass'), check('e', 'skipping')];
        expect(checksSummary(checks)).toBe('1 failed · 1 running · 2 passed · 1 other');
    });

    it('says when there are no checks', () => {
        expect(checksSummary([])).toBe('No checks on this pull request');
    });
});
