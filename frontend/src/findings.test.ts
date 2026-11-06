import {describe, expect, it} from 'vitest';
import {parseDiff} from './diff';
import {commentableLines} from './drafts';
import {
    acceptFinding, type Finding, findingKey, findingLabel, nextFinding, parseFindings, parseSettled, shownFindings, whyQuestion,
} from './findings';

const PATHS = new Set(['a.go', 'b.go']);
const raw = (over: Record<string, unknown> = {}) => ({
    path: 'a.go', line: 2, side: 'RIGHT', kind: 'bug', confidence: 0.8, title: 'Off by one', body: 'The loop stops one early.', ...over,
});

// a.go: one hunk, line 1 kept, line 2 added; old line 2 removed.
const A_DIFF = '@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n';
const commentable = {'a.go': commentableLines(parseDiff(A_DIFF))};

describe('findings from Claude', () => {
    it('keeps whole findings on changed files, each with a key from its place and title', () => {
        const got = parseFindings({value: {findings: [raw(), raw({path: 'gone.go'}), raw({kind: 'style'}), raw({side: 'UP'}), raw({confidence: 2}), 'junk']}, paths: PATHS});
        expect(got).toEqual([{...raw(), side: 'RIGHT', kind: 'bug', key: findingKey({path: 'a.go', line: 2, title: 'Off by one'})}]);
        expect(parseFindings({value: {summary: 'no list'}, paths: PATHS})).toBeNull();
        expect(parseFindings({value: null, paths: PATHS})).toBeNull();
    });

    it('keys a finding by file, line and title, so the same finding stays dismissed', () => {
        const key = findingKey({path: 'a.go', line: 2, title: 'Off by one'});
        expect(findingKey({path: 'a.go', line: 2, title: 'Off by one'})).toBe(key);
        expect(new Set([
            key,
            findingKey({path: 'a.go', line: 3, title: 'Off by one'}),
            findingKey({path: 'b.go', line: 2, title: 'Off by one'}),
            findingKey({path: 'a.go', line: 2, title: 'Off by two'}),
            findingKey({path: 'a.go', line: 23, title: ' by one'}),
        ]).size).toBe(5);
    });

    it('shows only findings on a line GitHub takes a comment on, minus the settled ones', () => {
        const findings = parseFindings({value: {findings: [
            raw(), // added line 2
            raw({line: 2, side: 'LEFT', title: 'Removed check'}), // removed line 2
            raw({line: 40, title: 'Far away'}), // not in the diff
            raw({line: 1, side: 'LEFT', title: 'Kept line, old side'}), // context: on both sides
            raw({path: 'b.go', title: 'Diff not read yet'}),
            raw({line: 1, title: 'Settled'}),
        ]}, paths: PATHS}) ?? [];
        const settled = new Set([findingKey({path: 'a.go', line: 1, title: 'Settled'})]);
        expect(shownFindings({findings, commentable, settled}).map(f => f.title)).toEqual(['Off by one', 'Removed check', 'Kept line, old side']);
    });

    it('reads settled keys back, dropping what is not a key', () => {
        expect(parseSettled(['k1', 2, null, 'k2'])).toEqual(['k1', 'k2']);
        expect(parseSettled({k: 1})).toEqual([]);
    });
});

describe('moving between findings', () => {
    const at = (path: string, line: number, title = `${path}:${line}`): Finding => ({
        key: findingKey({path, line, title}), path, line, side: 'RIGHT', kind: 'risk', confidence: 0.5, title, body: '',
    });
    const findings = [at('b.go', 9), at('a.go', 30), at('a.go', 4)];
    const order = ['a.go', 'b.go'];

    it('goes in the order on screen: file, then line, and wraps around', () => {
        expect(nextFinding({findings, order, from: null, step: 1})?.title).toBe('a.go:4');
        expect(nextFinding({findings, order, from: {path: 'a.go', line: 4}, step: 1})?.title).toBe('a.go:30');
        expect(nextFinding({findings, order, from: {path: 'a.go', line: 30}, step: 1})?.title).toBe('b.go:9');
        expect(nextFinding({findings, order, from: {path: 'b.go', line: 9}, step: 1})?.title).toBe('a.go:4');
        expect(nextFinding({findings, order, from: {path: 'a.go', line: 4}, step: -1})?.title).toBe('b.go:9');
        expect(nextFinding({findings, order, from: {path: 'a.go', line: 10}, step: -1})?.title).toBe('a.go:4');
    });

    it('starts from a line between findings, and has nothing to go to with no findings', () => {
        expect(nextFinding({findings, order, from: {path: 'a.go', line: 10}, step: 1})?.title).toBe('a.go:30');
        expect(nextFinding({findings: [], order, from: null, step: 1})).toBeNull();
    });
});

describe('acting on a finding', () => {
    const finding = parseFindings({value: {findings: [raw({side: 'LEFT'})]}, paths: PATHS})![0];

    it('accepting it makes a line draft at its place, with its words, for the reviewer to edit', () => {
        expect(acceptFinding(finding, {id: 'd1', head: 'c0ffee'})).toEqual({
            kind: 'line', id: 'd1', path: 'a.go', line: 2, side: 'LEFT', body: 'The loop stops one early.', head: 'c0ffee',
        });
        expect(acceptFinding({...finding, body: '  '}, {id: 'd2', head: null}).body).toBe('Off by one');
    });

    it('labels it by kind and asks Claude why with its place and words', () => {
        expect(findingLabel('bug')).toBe('possible bug');
        expect(findingLabel('test')).toBe('missing test');
        const q = whyQuestion(finding);
        expect(q).toContain('a.go:2');
        expect(q).toContain('Off by one');
        expect(q).toContain('The loop stops one early.');
    });
});
