// Small helpers: fuzzy matching, shell quoting, and the Markdown summary.

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

export interface SummaryInput {
    repo: string;
    base: string;
    scopeLabel: string;
    files: {path: string; status: string; added: number; deleted: number; oldPath?: string}[];
    reviewed: Record<string, string>;
    notes: Record<string, string>;
}

// buildMarkdown writes the changed files, review state and notes as Markdown,
// ready to paste into a pull request description.
export function buildMarkdown(input: SummaryInput): string {
    const done = input.files.filter(f => input.reviewed[f.path]).length;
    const lines = [
        `## Changes: ${input.scopeLabel} vs ${input.base}`,
        '',
        `${input.files.length} files, ${done} reviewed.`,
        '',
    ];
    for (const f of input.files) {
        const mark = input.reviewed[f.path] ? 'x' : ' ';
        const rename = f.oldPath ? ` (from ${f.oldPath})` : '';
        lines.push(`- [${mark}] \`${f.path}\`${rename} (${f.status}, +${f.added} −${f.deleted})`);
        const note = input.notes[f.path]?.trim();
        if (note) {
            lines.push(`  - ${note.replace(/\n/g, '\n    ')}`);
        }
    }
    return lines.join('\n') + '\n';
}
