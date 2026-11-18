import {describe, expect, it} from 'vitest';
import {zoomAfter} from './zoom';

describe('zoomAfter', () => {
    it('steps in with = or +, out with -, and resets with 0', () => {
        expect(zoomAfter('=', 1)).toBe(1.2);
        expect(zoomAfter('+', 1.2)).toBe(1.4);
        expect(zoomAfter('-', 1)).toBe(0.8);
        expect(zoomAfter('0', 1.8)).toBe(1);
    });

    it('stays within its range', () => {
        expect(zoomAfter('=', 3)).toBe(3);
        expect(zoomAfter('-', 0.4)).toBe(0.4);
    });

    it('does not drift after many steps', () => {
        let zoom = 1;
        for (let i = 0; i < 3; i++) zoom = zoomAfter('-', zoom) ?? zoom;
        expect(zoom).toBe(0.4);
    });

    it('ignores other keys', () => {
        expect(zoomAfter('k', 1)).toBeNull();
    });
});
