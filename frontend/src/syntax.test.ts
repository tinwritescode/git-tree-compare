import {describe, expect, it} from 'vitest';
import {parseDiff} from './diff';
import {compact, langFor, paint, sides} from './syntax';

describe('langFor', () => {
    it('picks the language from the extension or the file name', () => {
        expect(langFor('api/limit.go')).toBe('go');
        expect(langFor('src/App.tsx')).toBe('tsx');
        expect(langFor('Dockerfile')).toBe('docker');
        expect(langFor('config/limits.YAML')).toBe('yaml');
    });

    it('returns undefined for a file it cannot colour', () => {
        expect(langFor('LICENSE')).toBeUndefined();
        expect(langFor('image.png')).toBeUndefined();
    });
});

describe('sides', () => {
    it('splits a hunk into the old and new file, each line once', () => {
        const lines = parseDiff('@@ -1,2 +1,2 @@\n a\n-b\n+c');
        const [ctx, del, add] = lines.slice(1);
        expect(sides(lines)).toEqual([
            {old: [ctx, del], new: [ctx, add]},
        ]);
    });

    it('starts a new pair at every hunk', () => {
        const lines = parseDiff('@@ -1 +1 @@\n a\n@@ -9 +9 @@\n-b\n');
        expect(sides(lines)).toHaveLength(2);
    });
});

describe('paint', () => {
    it('keeps token colours and marks the changed words inside them', () => {
        const pieces = paint(
            [{text: 'let ', color: 'k'}, {text: 'abc', color: 'v'}],
            [{text: 'let a', changed: false}, {text: 'bc', changed: true}],
        );
        expect(pieces).toEqual([
            {text: 'let ', color: 'k', changed: false},
            {text: 'a', color: 'v', changed: false},
            {text: 'bc', color: 'v', changed: true},
        ]);
    });

    it('returns the tokens as they are when no words changed', () => {
        expect(paint([{text: 'x', color: 'k'}])).toEqual([{text: 'x', color: 'k', changed: false}]);
    });
});

describe('compact', () => {
    it('joins neighbours of one colour and drops the default text colour', () => {
        expect(compact([
            {text: 'if', color: 'var(--shiki-token-keyword)'},
            {text: ' ', color: 'var(--shiki-foreground)'},
            {text: 'err', color: 'var(--shiki-foreground)'},
            {text: ' :=', color: 'var(--shiki-token-keyword)'},
            {text: ' x', color: 'var(--shiki-token-keyword)'},
        ])).toEqual([
            {text: 'if', color: 'var(--shiki-token-keyword)'},
            {text: ' err'},
            {text: ' := x', color: 'var(--shiki-token-keyword)'},
        ]);
    });
});
