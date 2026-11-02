// Review state for one pull request. GitHub owns the viewed state; `states` is the last copy read
// from it, and `pending` holds what the reviewer asked for that GitHub has not confirmed yet.
// Pending entries survive a restart, so a mark made offline reaches GitHub later.

export type ReviewRecord = {
    states: Record<string, string>; // path -> VIEWED, UNVIEWED or DISMISSED
    pending: Record<string, boolean>; // path -> wanted viewed state
};

export const emptyRecord: ReviewRecord = {states: {}, pending: {}};

export function isReviewed(record: ReviewRecord, path: string): boolean {
    return record.pending[path] ?? record.states[path] === 'VIEWED';
}

// isChangedSinceReview: the file was viewed, then a push changed it.
export function isChangedSinceReview(record: ReviewRecord, path: string): boolean {
    return record.states[path] === 'DISMISSED' && !isReviewed(record, path);
}

// toggleReviewed marks every path reviewed, or unmarks them all when they already are.
export function toggleReviewed(record: ReviewRecord, paths: string[]): {record: ReviewRecord; viewed: boolean} {
    const viewed = !paths.every(p => isReviewed(record, p));
    const pending = {...record.pending};
    for (const p of paths) {
        if ((record.states[p] === 'VIEWED') === viewed) delete pending[p];
        else pending[p] = viewed;
    }
    return {record: {...record, pending}, viewed};
}

// applyServerStates takes a fresh read from GitHub. A pending entry it already agrees with is done.
export function applyServerStates(record: ReviewRecord, states: Record<string, string>): ReviewRecord {
    const pending = Object.fromEntries(
        Object.entries(record.pending).filter(([p, viewed]) => (states[p] === 'VIEWED') !== viewed),
    );
    return {states, pending};
}

// nextBatch picks what to send next: all pending paths that want the same state.
export function nextBatch(record: ReviewRecord): {paths: string[]; viewed: boolean} | null {
    const entries = Object.entries(record.pending);
    if (!entries.length) return null;
    const viewed = entries[0][1];
    return {paths: entries.filter(([, v]) => v === viewed).map(([p]) => p), viewed};
}

// settleBatch records that GitHub accepted a batch. A path toggled again while the request
// was in flight stays pending, with its newer wish.
export function settleBatch(record: ReviewRecord, batch: {paths: string[]; viewed: boolean}): ReviewRecord {
    const states = {...record.states};
    const pending = {...record.pending};
    for (const p of batch.paths) {
        states[p] = batch.viewed ? 'VIEWED' : 'UNVIEWED';
        if (pending[p] === batch.viewed) delete pending[p];
    }
    return {states, pending};
}

// nextUnreviewed finds the first unreviewed file after `current`, wrapping around.
export function nextUnreviewed<T extends {path: string}>(files: T[], record: ReviewRecord, current: string): T | null {
    const at = files.findIndex(f => f.path === current);
    const order = [...files.slice(at + 1), ...files.slice(0, Math.max(at, 0))];
    return order.find(f => !isReviewed(record, f.path)) ?? null;
}
