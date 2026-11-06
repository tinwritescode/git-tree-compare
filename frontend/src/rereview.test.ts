import {describe, expect, it} from 'vitest';
import {main} from '../wailsjs/go/models';
import {emptyRecord} from './review';
import {parseRereview, sinceRanges, threadChip, threadTexts} from './rereview';

const thread = (id: string, over: Partial<main.PRThread> = {}) => main.PRThread.createFrom({
    id, path: 'a.go', line: 3, resolved: false, outdated: false, url: '', comments: [{author: 'ann', body: 'Handle nil', url: '', createdAt: ''}], ...over,
});

describe('the re-review answer', () => {
    it('maps each known thread to its status and evidence, and drops unknown ids and statuses', () => {
        const got = parseRereview({
            value: {
                summary: 'Adds the nil check.\nRenames limit.\nNew test.\nA fourth line.',
                threads: [
                    {threadId: 'T1', status: 'addressed', evidence: 'a.go:4 checks nil.'},
                    {threadId: 'T2', status: 'not_addressed', evidence: 'Still unchecked.'},
                    {threadId: 'T3', status: 'unclear', evidence: ''},
                    {threadId: 'made-up', status: 'addressed', evidence: 'x'},
                    {threadId: 'T1', status: 'done', evidence: 'x'},
                ],
            },
            threadIds: new Set(['T1', 'T2', 'T3']),
        });
        expect(got).toEqual({
            summary: 'Adds the nil check.\nRenames limit.\nNew test.',
            threads: {
                T1: {status: 'addressed', evidence: 'a.go:4 checks nil.'},
                T2: {status: 'not_addressed', evidence: 'Still unchecked.'},
                T3: {status: 'unclear', evidence: ''},
            },
        });
        expect(parseRereview({value: {threads: []}, threadIds: new Set()})).toBeNull();
    });

    it('names each status on its chip; resolving stays the reviewer’s click', () => {
        expect(threadChip('addressed')).toBe('Claude · looks addressed');
        expect(threadChip('not_addressed')).toBe('Claude · not addressed');
        expect(threadChip('unclear')).toBe('Claude · unclear');
    });
});

describe('what the re-review reads', () => {
    it('lists the files changed since their review, with the head each was reviewed at', () => {
        const record = {...emptyRecord, states: {'a.go': 'DISMISSED', 'b.go': 'VIEWED', 'c.go': 'DISMISSED', 'd.go': 'DISMISSED'}};
        const heads = {'a.go': 'old1', 'b.go': 'old2', 'd.go': 'new'};
        expect(sinceRanges({paths: ['a.go', 'b.go', 'c.go', 'd.go'], record, heads, head: 'new'})).toEqual([{path: 'a.go', from: 'old1'}]);
    });

    it('sends the open threads it can name', () => {
        const got = threadTexts([thread('T1'), thread('T2', {resolved: true}), thread('')]);
        expect(got).toEqual([{id: 'T1', path: 'a.go', line: 3, comments: [{author: 'ann', body: 'Handle nil', url: '', createdAt: ''}]}]);
    });
});
