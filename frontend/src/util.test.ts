import {describe, expect, it} from 'vitest';
import {inkShare, tickWeight} from './util';

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
