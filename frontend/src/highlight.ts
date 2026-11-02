// highlight colours a parsed diff with Shiki. Colours come out as CSS variables
// (--shiki-token-*), which App.css points at the theme, so light and dark both follow it.
// The tokenizer runs in a worker; only the newest request is tokenized, and recent results are kept.

import type {Line} from './diff';
import type {HighlightReply, HighlightRequest} from './highlight-worker';
import {langFor, sides, type Token} from './syntax';
import {dropOldest} from './util';

const CACHE_SIZE = 24;
const cache = new Map<string, Token[][][]>(); // oldest first, so the first key is evicted

let worker: Worker | undefined;
let nextId = 0;
let running: {id: number; resolve: (texts: Token[][][]) => void; reject: (e: Error) => void} | undefined;
let waiting: {request: HighlightRequest; resolve: (texts: Token[][][]) => void; reject: (e: Error) => void} | undefined;

function start(job: NonNullable<typeof waiting>) {
    worker ??= createWorker();
    running = {id: job.request.id, resolve: job.resolve, reject: job.reject};
    worker.postMessage(job.request);
}

function createWorker(): Worker {
    const w = new Worker(new URL('./highlight-worker.ts', import.meta.url), {type: 'module'});
    w.onmessage = (e: MessageEvent<HighlightReply>) => {
        const job = running;
        if (!job || job.id !== e.data.id) return;
        running = undefined;
        if ('error' in e.data) job.reject(new Error(e.data.error));
        else job.resolve(e.data.texts);
        const next = waiting;
        waiting = undefined;
        if (next) start(next);
    };
    return w;
}

// tokenize sends texts to the worker. A request still waiting when a newer one arrives is dropped,
// so moving quickly through files only tokenizes the file the reviewer stops on.
function tokenize(lang: string, texts: string[]): Promise<Token[][][]> {
    const key = `${lang}\0${texts.join('\0')}`;
    const hit = cache.get(key);
    if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        return Promise.resolve(hit);
    }
    return new Promise<Token[][][]>((resolve, reject) => {
        waiting?.reject(new Error('superseded'));
        waiting = {request: {id: ++nextId, lang, texts}, resolve, reject};
        if (!running) {
            const job = waiting;
            waiting = undefined;
            start(job);
        }
    }).then(result => {
        cache.set(key, result);
        dropOldest(cache, CACHE_SIZE);
        return result;
    });
}

// highlight returns the coloured tokens of each code line, keyed by the line.
// Each hunk is read as two files, old and new, so a token that spans lines keeps its colour.
// A file in a language Shiki does not know comes back empty and draws as plain text.
export async function highlight(lines: Line[], path: string): Promise<Map<Line, Token[]>> {
    const out = new Map<Line, Token[]>();
    const lang = langFor(path);
    if (!lang) return out;

    // Each hunk sends its new side, then its old side, of which only the removed lines are kept.
    const parts = sides(lines).flatMap(side => [{lines: side.new}, {lines: side.old, only: 'del' as const}]);
    const texts = await tokenize(lang, parts.map(p => p.lines.map(l => l.text).join('\n')));
    parts.forEach((part, i) => {
        part.lines.forEach((line, j) => {
            if (part.only && line.kind !== part.only) return;
            out.set(line, texts[i][j] ?? []);
        });
    });
    return out;
}
