import {describe, expect, it} from 'vitest';
import {diffRows, hunkFor, hunkOfRow, parseDiff} from './diff';

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

describe('hunkFor', () => {
    const text = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n' + DIFF + '\n';

    it('finds the hunk that holds the focused line, on its side', () => {
        expect(hunkFor({text, focus: {side: 'RIGHT', line: 9}, index: 0})).toEqual({header: '@@ -9 +9 @@', text: '@@ -9 +9 @@\n d'});
        expect(hunkFor({text, focus: {side: 'LEFT', line: 2}, index: 1})).toEqual({header: '@@ -1,2 +1,2 @@', text: '@@ -1,2 +1,2 @@\n a\n-b\n+c'});
        expect(hunkFor({text, focus: {side: 'RIGHT', line: 2}, index: 1})?.header).toBe('@@ -1,2 +1,2 @@');
    });

    it('takes the hunk in view when no line of it is focused', () => {
        expect(hunkFor({text, focus: null, index: 1})?.header).toBe('@@ -9 +9 @@');
        expect(hunkFor({text, focus: {side: 'RIGHT', line: 5}, index: 1})?.header).toBe('@@ -9 +9 @@');
        expect(hunkFor({text, focus: null, index: 7})?.header).toBe('@@ -9 +9 @@');
        expect(hunkFor({text, focus: null, index: -1})?.header).toBe('@@ -1,2 +1,2 @@');
    });

    it('is null for a diff without hunks', () => {
        expect(hunkFor({text: '', focus: null, index: 0})).toBeNull();
        expect(hunkFor({text: 'Binary files a/x and b/x differ\n', focus: null, index: 0})).toBeNull();
    });
});

describe('hunkOfRow', () => {
    const rows = diffRows(parseDiff(DIFF), false);

    it('is the hunk a row sits in', () => {
        expect(hunkOfRow(rows, 0)).toBe(0);
        expect(hunkOfRow(rows, 3)).toBe(0);
        expect(hunkOfRow(rows, 4)).toBe(1);
        expect(hunkOfRow(rows, 5)).toBe(1);
        expect(hunkOfRow(rows, 99)).toBe(1);
        expect(hunkOfRow([], 0)).toBe(0);
    });
});
