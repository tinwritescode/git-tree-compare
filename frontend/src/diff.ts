// Parsing of git's unified diff text into lines and split-view rows.

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
    const raw = text.split('\n');
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
