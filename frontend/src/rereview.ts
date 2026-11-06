// The re-review, for a pull request pushed to after the reviewer's review: a short summary of what
// changed since, and Claude's read on whether each open thread was answered. Claude only suggests;
// a thread is resolved by the reviewer's click.
import {main} from '../wailsjs/go/models';
import {isRecord, listOf, str} from './claude';
import type {ReviewRecord} from './review';
import {type ReviewedHeads, sinceHead} from './since';

export type ThreadStatus = 'addressed' | 'not_addressed' | 'unclear';
export type ThreadCheck = {status: ThreadStatus; evidence: string};
export type Rereview = {summary: string; threads: Readonly<Record<string, ThreadCheck>>};

const SUMMARY_LINES = 3;
const isStatus = (v: unknown): v is ThreadStatus => v === 'addressed' || v === 'not_addressed' || v === 'unclear';

// parseRereview reads Claude's answer. A status for a thread it was not asked about is dropped, as
// Claude may make one up. Null when there is no summary.
export function parseRereview({value, threadIds}: {value: unknown; threadIds: ReadonlySet<string>}): Rereview | null {
    if (!isRecord(value)) return null;
    const summary = str(value.summary)?.trim();
    if (!summary) return null;
    const checks = listOf(value.threads, ({threadId, status, evidence}) =>
        (typeof threadId === 'string' && threadIds.has(threadId) && isStatus(status)
            ? {threadId, check: {status, evidence: str(evidence) ?? ''}}
            : null));
    const threads: Record<string, ThreadCheck> = {};
    for (const {threadId, check} of checks) threads[threadId] ??= check;
    return {summary: summary.split('\n').filter(l => l.trim()).slice(0, SUMMARY_LINES).join('\n'), threads};
}

const CHIP: Record<ThreadStatus, string> = {addressed: 'looks addressed', not_addressed: 'not addressed', unclear: 'unclear'};

export function threadChip(status: ThreadStatus): string {
    return `Claude · ${CHIP[status]}`;
}

// sinceRanges lists the files a push changed after the reviewer reviewed them, with the head each
// was reviewed at. The re-review runs only when there is one.
export function sinceRanges({paths, record, heads, head}: {
    paths: string[];
    record: ReviewRecord;
    heads: ReviewedHeads;
    head: string;
}): {path: string; from: string}[] {
    return paths.flatMap(path => {
        const from = sinceHead({record, heads, path, head});
        return from ? [{path, from}] : [];
    });
}

// threadTexts is the open threads the re-review asks about: those with an id to answer by.
export function threadTexts(threads: main.PRThread[]): main.ThreadText[] {
    return threads.filter(t => t.id && !t.resolved).map(t => main.ThreadText.createFrom({id: t.id, path: t.path, line: t.line, comments: t.comments}));
}
