// Shaping search results for the search dialog. The search itself runs in Go (search.go).

import type {main} from '../wailsjs/go/models';

export type SearchHit = Pick<main.SearchHit, 'path' | 'line' | 'text' | 'ranges'>;

// groupHits puts hits under their file, files in the order their first hit came.
export function groupHits<H extends SearchHit>(hits: H[]): {path: string; hits: H[]}[] {
    const groups = new Map<string, H[]>();
    for (const h of hits) groups.set(h.path, [...(groups.get(h.path) ?? []), h]);
    return [...groups].map(([path, list]) => ({path, hits: list}));
}

// markRanges cuts a line into plain runs and matched runs. Ranges are sorted [start, end) offsets.
export function markRanges(text: string, ranges: number[][]): {text: string; match: boolean}[] {
    const out: {text: string; match: boolean}[] = [];
    let at = 0;
    for (const [start, end] of ranges) {
        if (start > at) out.push({text: text.slice(at, start), match: false});
        out.push({text: text.slice(start, end), match: true});
        at = end;
    }
    if (at < text.length || out.length === 0) out.push({text: text.slice(at), match: false});
    return out;
}
