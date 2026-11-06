// Small helpers: fuzzy matching, shell quoting, and the Markdown summary.
import type {Draft} from './drafts';

// fuzzyScore returns -1 when query is not a subsequence of text. Lower is better.
export function fuzzyScore(query: string, text: string): number {
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    if (!q) return 0;

    let score = 0;
    let from = 0;
    let last = -2;
    for (const ch of q) {
        const at = t.indexOf(ch, from);
        if (at === -1) return -1;
        // Consecutive matches and matches after a separator cost less.
        score += at === last + 1 ? 0 : at;
        if (at === 0 || '/._-'.includes(t[at - 1])) score -= 1;
        last = at;
        from = at + 1;
    }
    return score + t.length * 0.01;
}

// shellQuote wraps a value so it is one argument to sh.
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

// basename returns the last part of a path, with either separator.
export function basename(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

// folderOf returns the folders of a path with a trailing slash, or '' for a file at the root.
export function folderOf(path: string): string {
    return path.slice(0, path.lastIndexOf('/') + 1);
}

// timeAgo says how long ago an ISO time was, in the largest unit that fits.
export function timeAgo(iso: string, now = Date.now()): string {
    const seconds = (now - new Date(iso).getTime()) / 1000;
    if (Number.isNaN(seconds)) return 'recently';
    if (seconds < 60) return 'just now';
    const units: [number, string][] = [[86400 * 365, 'year'], [86400 * 30, 'month'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
    for (const [size, name] of units) {
        const n = Math.floor(seconds / size);
        if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
    return 'just now';
}

// inkShare turns a line count into a percentage of a size bar. The scale is logarithmic
// so a 10-line fix stays visible beside a 10,000-line migration.
export function inkShare(lines: number): number {
    return Math.min(100, (Math.log10(1 + lines) / 4) * 100);
}

// tickWeight sizes a file on the ruler. The square root shows where the work is
// without letting one large file squeeze the others away.
export function tickWeight(lines: number): number {
    return Math.sqrt(1 + lines);
}

export interface SummaryInput {
    title: string;
    files: {path: string; status: string; added: number; deleted: number; oldPath?: string}[];
    reviewed: Record<string, string>;
    notes: Record<string, string>;
    drafts: Draft[];
}

// buildMarkdown writes the changed files, review state, notes and draft comments as Markdown,
// ready to paste into a pull request description.
export function buildMarkdown(input: SummaryInput): string {
    const done = input.files.filter(f => input.reviewed[f.path]).length;
    const lines = [
        `## ${input.title}`,
        '',
        `${input.files.length} files, ${done} reviewed.`,
        '',
    ];
    for (const f of input.files) {
        const mark = input.reviewed[f.path] ? 'x' : ' ';
        const rename = f.oldPath ? ` (from ${f.oldPath})` : '';
        lines.push(`- [${mark}] \`${f.path}\`${rename} (${f.status}, +${f.added} −${f.deleted})`);
        const note = input.notes[f.path]?.trim();
        const drafts = input.drafts.filter(d => d.path === f.path).map(d => `${draftPlace(d)}: ${d.body.trim()}`);
        for (const item of note ? [note, ...drafts] : drafts) {
            lines.push(`  - ${item.replace(/\n/g, '\n    ')}`);
        }
    }
    return lines.join('\n') + '\n';
}

function draftPlace(d: Draft): string {
    switch (d.kind) {
        case 'line':
            return d.side === 'LEFT' ? `Old line ${d.line}` : `Line ${d.line}`;
        case 'file':
            return 'File';
        default: {
            const _exhaustive: never = d;
            return _exhaustive;
        }
    }
}

// dropOldest removes the earliest-added keys until map holds at most size entries.
export function dropOldest<K, V>(map: Map<K, V>, size: number) {
    for (const key of map.keys()) {
        if (map.size <= size) return;
        map.delete(key);
    }
}
