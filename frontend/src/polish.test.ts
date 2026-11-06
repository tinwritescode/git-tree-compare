import {describe, expect, it} from 'vitest';
import {polishStep, wordDiff} from './polish';

const text = (parts: {kind: string; text: string}[], keep: string[]) => parts.filter(p => keep.includes(p.kind)).map(p => p.text).join('');

describe('the word diff of a polished draft', () => {
    it('marks the words Claude removed and added, and keeps the rest', () => {
        const parts = wordDiff('this is wrong fix it', 'This is wrong; please fix it');
        expect(parts).toEqual([
            {kind: 'del', text: 'this '},
            {kind: 'add', text: 'This '},
            {kind: 'same', text: 'is '},
            {kind: 'del', text: 'wrong '},
            {kind: 'add', text: 'wrong; please '},
            {kind: 'same', text: 'fix it'},
        ]);
    });

    it('rebuilds each side exactly from its parts', () => {
        const before = 'Use `limit` here.\n\nIt can overflow when n > 10.';
        const after = 'Please use `limit` here:\nit overflows when n > 10.';
        const parts = wordDiff(before, after);
        expect(text(parts, ['same', 'del'])).toBe(before);
        expect(text(parts, ['same', 'add'])).toBe(after);
    });

    it('keeps the rest unchanged when words are added or removed at either end', () => {
        expect(wordDiff('fix it', 'please fix it')).toEqual([{kind: 'add', text: 'please '}, {kind: 'same', text: 'fix it'}]);
        expect(wordDiff('please fix it', 'fix it')).toEqual([{kind: 'del', text: 'please '}, {kind: 'same', text: 'fix it'}]);
        expect(wordDiff('fix it now', 'fix it ')).toEqual([{kind: 'same', text: 'fix it '}, {kind: 'del', text: 'now'}]);
        expect(wordDiff('a b c d', 'a x c d')).toEqual([
            {kind: 'same', text: 'a '}, {kind: 'del', text: 'b '}, {kind: 'add', text: 'x '}, {kind: 'same', text: 'c d'},
        ]);
    });

    it('keeps the longest run of words unchanged, not the first word that matches', () => {
        expect(wordDiff('p q r ', 'r p q ')).toEqual([{kind: 'add', text: 'r '}, {kind: 'same', text: 'p q '}, {kind: 'del', text: 'r '}]);
        expect(wordDiff('fix it ', 'it fix it ')).toEqual([{kind: 'add', text: 'it '}, {kind: 'same', text: 'fix it '}]);
        expect(wordDiff('x x y x ', 'y x ')).toEqual([{kind: 'del', text: 'x x '}, {kind: 'same', text: 'y x '}]);
        expect(wordDiff('a c b a ', 'b a ')).toEqual([{kind: 'del', text: 'a c '}, {kind: 'same', text: 'b a '}]);
    });

    it('diffs up to 2000 words a side by word, and shows longer text as replaced whole', () => {
        const words = (n: number) => Array.from({length: n}, (_, i) => `w${i}`).join(' ');
        expect(wordDiff(words(2000), words(2000))).toEqual([{kind: 'same', text: words(2000)}]);
        expect(wordDiff(words(2001), words(2001))).toEqual([{kind: 'del', text: words(2001)}, {kind: 'add', text: words(2001)}]);
    });

    it('shows the same text as unchanged, and a rewrite of empty text as all added', () => {
        expect(wordDiff('same words', 'same words')).toEqual([{kind: 'same', text: 'same words'}]);
        expect(wordDiff('', 'new')).toEqual([{kind: 'add', text: 'new'}]);
    });
});

describe('the polish of a draft', () => {
    it('offers Claude’s rewrite against the words it was asked about, and an error as an error', () => {
        const asked = {kind: 'running', original: 'fix it'} as const;
        expect(polishStep(asked, {kind: 'result', json: null, text: '  Please fix it.\n', costUsd: 0.01})).toEqual({kind: 'ready', original: 'fix it', rewrite: 'Please fix it.'});
        expect(polishStep(asked, {kind: 'error', message: 'Stopped.'})).toEqual({kind: 'error', message: 'Stopped.'});
        expect(polishStep(asked, {kind: 'tool', name: 'Read', path: null})).toBe(asked);
        expect(polishStep(asked, {kind: 'result', json: null, text: '  ', costUsd: null})).toEqual({kind: 'error', message: 'Claude answered with nothing.'});
    });

    it('ignores events once the polish has ended', () => {
        const idle = {kind: 'idle'} as const;
        expect(polishStep(idle, {kind: 'result', json: null, text: 'late', costUsd: null})).toBe(idle);
    });
});
