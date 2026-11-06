import {describe, expect, it} from 'vitest';
import {diffRows, parseDiff} from './diff';

const DIFF = '@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -9 +9 @@\n d';

describe('diffRows', () => {
    it('lists unified lines with hunks numbered and each row on its new-side line', () => {
        const rows = diffRows(parseDiff(DIFF), false);
        expect(rows.map(r => [r.kind, r.kind === 'hunk' ? r.hunk : r.newNo])).toEqual([
            ['hunk', 0], ['line', 1], ['line', undefined], ['line', 2], ['hunk', 1], ['line', 9],
        ]);
    });

    it('pairs removed and added lines side by side in split view', () => {
        const rows = diffRows(parseDiff(DIFF), true);
        expect(rows.map(r => [r.kind, r.kind === 'hunk' ? r.hunk : r.newNo])).toEqual([
            ['hunk', 0], ['pair', 1], ['pair', 2], ['hunk', 1], ['pair', 9],
        ]);
    });
});

describe('parseDiff', () => {
    it('adds no line for the newline that ends git output', () => {
        expect(parseDiff('@@ -1 +1 @@\n-a\n+b\n').map(l => l.kind)).toEqual(['hunk', 'del', 'add']);
    });
});
