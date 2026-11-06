import {describe, expect, it} from 'vitest';
import {buildMarkdown, dropOldest, folderOf, inkShare, tickWeight} from './util';

describe('inkShare', () => {
    it('is empty for no lines and full at the top of the scale', () => {
        expect(inkShare(0)).toBe(0);
        expect(inkShare(100000)).toBe(100);
    });

    it('grows with size but keeps small changes visible', () => {
        expect(inkShare(4)).toBeGreaterThan(10);
        expect(inkShare(800)).toBeGreaterThan(inkShare(40));
    });
});

describe('tickWeight', () => {
    it('gives an unchanged file some width, and big files more without drowning the rest', () => {
        expect(tickWeight(0)).toBe(1);
        expect(tickWeight(400)).toBeGreaterThan(tickWeight(4));
        expect(tickWeight(400)).toBeLessThan(25);
    });
});

describe('dropOldest', () => {
    it('keeps the newest entries up to the size', () => {
        const map = new Map([['a', 1], ['b', 2], ['c', 3]]);
        dropOldest(map, 2);
        expect([...map.keys()]).toEqual(['b', 'c']);
    });
});

describe('folderOf', () => {
    it('keeps the folders with their slash, and nothing for a file at the root', () => {
        expect(folderOf('api/v1/limit.go')).toBe('api/v1/');
        expect(folderOf('go.mod')).toBe('');
    });
});

describe('buildMarkdown', () => {
    it('lists each file with its note and draft comments under it', () => {
        const md = buildMarkdown({
            title: 'Fix the cache',
            files: [{path: 'a.go', status: 'M', added: 2, deleted: 1}, {path: 'b.go', status: 'A', added: 5, deleted: 0}],
            reviewed: {'a.go': 'reviewed'},
            notes: {'a.go': 'looks fine'},
            drafts: [
                {kind: 'line', id: '1', path: 'a.go', line: 12, side: 'RIGHT', body: 'rename this', head: null},
                {kind: 'line', id: '2', path: 'a.go', line: 3, side: 'LEFT', body: 'why remove?\nit was used', head: null},
                {kind: 'file', id: '3', path: 'b.go', body: 'split this file', head: null},
            ],
        });
        expect(md).toBe([
            '## Fix the cache',
            '',
            '2 files, 1 reviewed.',
            '',
            '- [x] `a.go` (M, +2 −1)',
            '  - looks fine',
            '  - Line 12: rename this',
            '  - Old line 3: why remove?',
            '    it was used',
            '- [ ] `b.go` (A, +5 −0)',
            '  - File: split this file',
            '',
        ].join('\n'));
    });
});
