// Polish: Claude rewrites a draft comment, and the editor shows the rewrite as a word diff against
// the reviewer's words. The draft changes only when the reviewer accepts.
import type {ClaudeEvent} from './claude';

export type PolishState =
    | {kind: 'idle'}
    | {kind: 'running'; taskId: string; original: string}
    | {kind: 'ready'; original: string; rewrite: string}
    | {kind: 'error'; message: string};

export function polishStep(state: PolishState, event: ClaudeEvent): PolishState {
    if (state.kind !== 'running') return state;
    switch (event.kind) {
        case 'tool':
        case 'text':
            return state;
        case 'result': {
            const rewrite = event.text.trim();
            return rewrite ? {kind: 'ready', original: state.original, rewrite} : {kind: 'error', message: 'Claude answered with nothing.'};
        }
        case 'error':
            return {kind: 'error', message: event.message};
        default: {
            const _exhaustive: never = event;
            return _exhaustive;
        }
    }
}

export type WordPart = {kind: 'same' | 'del' | 'add'; text: string};

// A word with the space after it, or space at the start.
const WORD = /\S+\s*|\s+/g;
// Beyond this many word pairs the diff is shown as all removed, then all added.
const MAX_CELLS = 4_000_000;

// wordDiff lines before and after up by words, longest common run first. Within a change the
// removed words come before the added ones.
export function wordDiff(before: string, after: string): WordPart[] {
    const a = before.match(WORD) ?? [];
    const b = after.match(WORD) ?? [];
    if (a.length * b.length > MAX_CELLS) return merge([{kind: 'del', text: before}, {kind: 'add', text: after}]);
    // common[i][j] is the length of the longest common run of a[i..] and b[j..].
    const common = Array.from({length: a.length + 1}, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
        }
    }
    const parts: WordPart[] = [];
    let dels: string[] = [];
    let adds: string[] = [];
    const flush = () => {
        parts.push({kind: 'del', text: dels.join('')}, {kind: 'add', text: adds.join('')});
        dels = [];
        adds = [];
    };
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) {
            flush();
            parts.push({kind: 'same', text: a[i]});
            i++;
            j++;
        } else if (j >= b.length || (i < a.length && common[i + 1][j] >= common[i][j + 1])) {
            dels.push(a[i++]);
        } else {
            adds.push(b[j++]);
        }
    }
    flush();
    return merge(parts);
}

// merge drops empty parts and joins neighbours of the same kind.
function merge(parts: WordPart[]): WordPart[] {
    const out: WordPart[] = [];
    for (const p of parts) {
        if (!p.text) continue;
        const last = out.at(-1);
        if (last?.kind === p.kind) out[out.length - 1] = {kind: p.kind, text: last.text + p.text};
        else out.push(p);
    }
    return out;
}
