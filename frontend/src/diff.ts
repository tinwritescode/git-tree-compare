// Parsing of git's unified diff text into lines and split-view rows.
import type {Side} from './drafts';

export type LineKind = 'ctx' | 'add' | 'del' | 'hunk' | 'meta';

export interface Seg {
    text: string;
    changed: boolean;
}

export interface Line {
    kind: LineKind;
    text: string;
    oldNo?: number;
    newNo?: number;
    // Word-level pieces for a changed line that has a counterpart on the other side.
    segs?: Seg[];
}

export interface SplitRow {
    left: Line | null;
    right: Line | null;
    hunk?: Line;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)/;

// parseDiff drops git's file header and returns the hunks as lines, with
// line numbers and word-level highlights on paired removed/added lines.
export function parseDiff(text: string): Line[] {
    // git ends its output with a newline, which is not a line of the file.
    const raw = text.replace(/\n$/, '').split('\n');
    const start = raw.findIndex(l => l.startsWith('@@'));
    if (start === -1) return [];

    const out: Line[] = [];
    let dels: Line[] = [];
    let adds: Line[] = [];
    let oldNo = 0;
    let newNo = 0;

    const flush = () => {
        pairWords(dels, adds);
        out.push(...dels, ...adds);
        dels = [];
        adds = [];
    };

    for (const line of raw.slice(start)) {
        if (line.startsWith('@@')) {
            flush();
            const m = HUNK_HEADER.exec(line);
            oldNo = m ? Number(m[1]) : 0;
            newNo = m ? Number(m[2]) : 0;
            out.push({kind: 'hunk', text: line});
        } else if (line.startsWith('-')) {
            if (adds.length) flush();
            dels.push({kind: 'del', text: line.slice(1), oldNo: oldNo++});
        } else if (line.startsWith('+')) {
            adds.push({kind: 'add', text: line.slice(1), newNo: newNo++});
        } else if (line.startsWith('\\')) {
            flush();
            out.push({kind: 'meta', text: line});
        } else {
            flush();
            const text = line.startsWith(' ') ? line.slice(1) : line;
            out.push({kind: 'ctx', text, oldNo: oldNo++, newNo: newNo++});
        }
    }
    flush();
    return out;
}

// pairWords pairs the i-th removed line with the i-th added line and marks the
// part that differs. The common prefix and suffix stay unmarked.
function pairWords(dels: Line[], adds: Line[]) {
    const pairs = Math.min(dels.length, adds.length);
    for (let i = 0; i < pairs; i++) {
        const [a, b] = wordSegs(dels[i].text, adds[i].text);
        dels[i].segs = a;
        adds[i].segs = b;
    }
}

function wordSegs(a: string, b: string): [Seg[], Seg[]] {
    let prefix = 0;
    while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;

    let suffix = 0;
    while (
        suffix < a.length - prefix &&
        suffix < b.length - prefix &&
        a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
    ) suffix++;

    const split = (s: string): Seg[] => {
        const head = s.slice(0, prefix);
        const middle = s.slice(prefix, s.length - suffix);
        const tail = s.slice(s.length - suffix);
        return [
            {text: head, changed: false},
            {text: middle, changed: true},
            {text: tail, changed: false},
        ].filter(seg => seg.text !== '');
    };
    return [split(a), split(b)];
}

// toSplitRows lines up removed and added lines side by side. A block of removed
// lines followed by added lines is zipped row by row; the shorter side stays empty.
export function toSplitRows(lines: Line[]): SplitRow[] {
    const rows: SplitRow[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (line.kind === 'hunk') {
            rows.push({left: null, right: null, hunk: line});
            i++;
        } else if (line.kind === 'ctx' || line.kind === 'meta') {
            rows.push({left: line, right: line});
            i++;
        } else {
            const dels: Line[] = [];
            const adds: Line[] = [];
            while (i < lines.length && lines[i].kind === 'del') dels.push(lines[i++]);
            while (i < lines.length && lines[i].kind === 'add') adds.push(lines[i++]);
            const n = Math.max(dels.length, adds.length);
            for (let k = 0; k < n; k++) {
                rows.push({left: dels[k] ?? null, right: adds[k] ?? null});
            }
        }
    }
    return rows;
}

// DiffRow is one row of the drawn diff: a hunk header, a line (unified view) or a pair (split view).
// newNo is the new-side line the row stands for, where review threads and search jumps land.
export type DiffRow =
    | {kind: 'hunk'; text: string; hunk: number}
    | {kind: 'line'; line: Line; newNo?: number}
    | {kind: 'pair'; row: SplitRow; newNo?: number};

// diffRows turns parsed lines into the rows the diff view draws, numbering the hunks in order.
export function diffRows(lines: Line[], split: boolean): DiffRow[] {
    let hunk = -1;
    if (split) {
        return toSplitRows(lines).map(row => (row.hunk
            ? {kind: 'hunk', text: row.hunk.text, hunk: ++hunk}
            : {kind: 'pair', row, newNo: row.right?.newNo}));
    }
    return lines.map(line => (line.kind === 'hunk'
        ? {kind: 'hunk', text: line.text, hunk: ++hunk}
        : {kind: 'line', line, newNo: line.newNo}));
}

// hunkOfRow is the number of the hunk a drawn row sits in: the last hunk header at or above it.
export function hunkOfRow(rows: DiffRow[], index: number): number {
    for (let i = Math.min(index, rows.length - 1); i >= 0; i--) {
        const row = rows[i];
        if (row.kind === 'hunk') return row.hunk;
    }
    return 0;
}

// A hunk as git wrote it, from its @@ header on.
export type Hunk = {header: string; text: string};

// hunkFor finds the hunk that holds the focused line on its side, or else the hunk numbered index
// (kept in range). Null when the diff has no hunks.
export function hunkFor({text, focus, index}: {text: string; focus: {side: Side; line: number} | null; index: number}): Hunk | null {
    const hunks: {header: string; lines: Line[]}[] = [];
    for (const line of parseDiff(text)) {
        if (line.kind === 'hunk') hunks.push({header: line.text, lines: []});
        else hunks[hunks.length - 1]?.lines.push(line);
    }
    if (!hunks.length) return null;
    const holds = (lines: Line[], at: {side: Side; line: number}) => lines.some(l => (at.side === 'LEFT' ? l.oldNo : l.newNo) === at.line);
    const hunk = (focus && hunks.find(h => holds(h.lines, focus))) || hunks[Math.min(Math.max(index, 0), hunks.length - 1)];
    return {header: hunk.header, text: [hunk.header, ...hunk.lines.map(l => SIGN[l.kind] + l.text)].join('\n')};
}

// SIGN puts back the mark parseDiff takes off each line; a meta line keeps its own.
const SIGN: Record<LineKind, string> = {ctx: ' ', add: '+', del: '-', hunk: '', meta: ''};
