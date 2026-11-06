// "Since my review": the head commit each file of a pull request was marked reviewed at, and
// which diff to show for a file a push changed afterwards. Saved per pull request on this machine.
import type {main} from '../wailsjs/go/models';
import {isChangedSinceReview, type ReviewRecord} from './review';

// ReviewedHeads maps a path to the head commit it was last marked reviewed at.
export type ReviewedHeads = Record<string, string>;

// recordReviewedHeads notes `head` for each path just marked reviewed. Unmarking keeps the old
// head: the file is then to review, so nothing reads it until the next mark replaces it.
export function recordReviewedHeads({heads, paths, viewed, head}: {
    heads: ReviewedHeads;
    paths: string[];
    viewed: boolean;
    head: string;
}): ReviewedHeads {
    if (!viewed) return heads;
    return {...heads, ...Object.fromEntries(paths.map(p => [p, head]))};
}

// parseReviewedHeads reads saved heads back, dropping anything that is not a path to a string.
export function parseReviewedHeads(value: unknown): ReviewedHeads {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

// sinceHead is the commit to diff from when the reviewer can see only what changed since their
// review of path, or null when the file has no such range.
export function sinceHead({record, heads, path, head}: {
    record: ReviewRecord;
    heads: ReviewedHeads;
    path: string;
    head: string;
}): string | null {
    const from = heads[path];
    return from && from !== head && isChangedSinceReview(record, path) ? from : null;
}

// The diff view's choice: the whole pull request, or only the changes since the reviewer's review.
export type DiffMode = 'whole' | 'since';
export type DiffRange = {kind: 'whole'} | {kind: 'since'; from: string};

export function diffRange({mode, from}: {mode: DiffMode; from: string | null}): DiffRange {
    return mode === 'since' && from ? {kind: 'since', from} : {kind: 'whole'};
}

// Why the whole pull request is shown although the reviewer asked for the changes since their review.
export type Fallback = {kind: 'gone'; from: string} | {kind: 'error'; message: string};
export type ShownDiff = {text: string; fallback: Fallback | null};

// loadDiff reads the diff for range. When the reviewed commit is gone or git fails, it reads the
// whole pull request instead and says why.
export async function loadDiff({range, whole, since}: {
    range: DiffRange;
    whole: () => Promise<string>;
    since: (from: string) => Promise<main.SinceDiff>;
}): Promise<ShownDiff> {
    if (range.kind === 'whole') return {text: await whole(), fallback: null};
    let fallback: Fallback;
    try {
        const found = await since(range.from);
        if (found.found) return {text: found.text, fallback: null};
        fallback = {kind: 'gone', from: range.from};
    } catch (e) {
        fallback = {kind: 'error', message: String(e)};
    }
    return {text: await whole(), fallback};
}

export function fallbackNote(fallback: Fallback): string {
    switch (fallback.kind) {
        case 'gone':
            return `Showing the whole pull request: ${fallback.from.slice(0, 7)}, the commit you reviewed, is not here and could not be fetched, likely after a force push.`;
        case 'error':
            return `Showing the whole pull request: could not read the changes since your review (${fallback.message}).`;
        default: {
            const _exhaustive: never = fallback;
            return _exhaustive;
        }
    }
}
