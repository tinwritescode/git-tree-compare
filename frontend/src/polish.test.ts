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
