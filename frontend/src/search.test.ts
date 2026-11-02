import {describe, expect, it} from 'vitest';
import {groupHits, markRanges} from './search';

const hit = (path: string, line: number) => ({path, line, text: '', ranges: []});

describe('groupHits', () => {
    it('groups hits by file, keeping the order they came in', () => {
        const groups = groupHits([hit('b.go', 3), hit('b.go', 9), hit('a.go', 1)]);
        expect(groups.map(g => [g.path, g.hits.map(h => h.line)])).toEqual([
            ['b.go', [3, 9]],
            ['a.go', [1]],
        ]);
    });
});

describe('markRanges', () => {
    it('cuts a line into plain text and matches', () => {
        expect(markRanges('\tkey := clientKey(r)', [[1, 4], [14, 17]])).toEqual([
            {text: '\t', match: false},
            {text: 'key', match: true},
            {text: ' := client', match: false},
            {text: 'Key', match: true},
            {text: '(r)', match: false},
        ]);
    });

    it('returns the line as one piece when nothing matched', () => {
        expect(markRanges('abc', [])).toEqual([{text: 'abc', match: false}]);
    });
});
