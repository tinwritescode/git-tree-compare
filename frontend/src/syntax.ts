// Syntax colouring for diff lines: which language a file is, how a diff splits
// into the two files it compares, and how token colours meet the changed-word marks.
// The tokenizer itself is in highlight.ts, so this stays pure and fast to test.

import type {Line, Seg} from './diff';

// Token is a run of text in one colour, as the tokenizer returns it.
export interface Token {
    text: string;
    color?: string;
}

// Piece is what a line draws: a run in one colour, inside or outside a changed word.
export interface Piece extends Token {
    changed: boolean;
}

// Extensions and file names mapped to the tokenizer's language ids.
const BY_EXT: Record<string, string> = {
    go: 'go', ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', md: 'markdown',
    css: 'css', scss: 'scss', html: 'html', vue: 'vue', svelte: 'svelte', xml: 'xml',
    sql: 'sql', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
    py: 'python', rb: 'ruby', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
    php: 'php', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
    graphql: 'graphql', gql: 'graphql', proto: 'proto', prisma: 'prisma', tf: 'terraform',
};
const BY_NAME: Record<string, string> = {
    dockerfile: 'docker', makefile: 'makefile', 'go.mod': 'go',
};

// langFor returns the language of a file, or undefined when it has none worth colouring.
export function langFor(path: string): string | undefined {
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    if (name in BY_NAME) return BY_NAME[name];
    const dot = name.lastIndexOf('.');
    return dot > 0 ? BY_EXT[name.slice(dot + 1)] : undefined;
}

// Side is one hunk seen as the two files it compares: the old file's lines and the new file's.
// A context line belongs to both, so each side reads as real code to the tokenizer.
export interface Side {
    old: Line[];
    new: Line[];
}

// sides splits a parsed diff into one Side per hunk.
export function sides(lines: Line[]): Side[] {
    const out: Side[] = [];
    for (const line of lines) {
        if (line.kind === 'hunk') {
            out.push({old: [], new: []});
            continue;
        }
        const hunk = out[out.length - 1];
        if (!hunk || line.kind === 'meta') continue;
        if (line.kind !== 'add') hunk.old.push(line);
        if (line.kind !== 'del') hunk.new.push(line);
    }
    return out;
}

// The colour Shiki gives plain text. It is the page's text colour already, so it is left off.
const FOREGROUND = 'var(--shiki-foreground)';

// compact joins neighbouring tokens of one colour and drops the default colour,
// so a line draws as a few coloured runs instead of one element per token.
export function compact(tokens: Token[]): Token[] {
    const out: Token[] = [];
    for (const {text, color: raw} of tokens) {
        const color = raw === FOREGROUND ? undefined : raw;
        const last = out[out.length - 1];
        if (last && last.color === color) last.text += text;
        else out.push(color ? {text, color} : {text});
    }
    return out;
}

// paint cuts the tokens at the edges of the changed words, so a line keeps its
// syntax colours and its changed-word marks at once.
export function paint(tokens: Token[], segs?: Seg[]): Piece[] {
    if (!segs) return tokens.map(t => ({...t, changed: false}));
    const pieces: Piece[] = [];
    let seg = 0;
    let segLeft = segs[0]?.text.length ?? 0;
    for (const token of tokens) {
        let rest = token.text;
        while (rest) {
            while (segLeft === 0 && seg < segs.length - 1) segLeft = segs[++seg].text.length;
            const take = segLeft > 0 ? Math.min(segLeft, rest.length) : rest.length;
            pieces.push({text: rest.slice(0, take), color: token.color, changed: segs[seg]?.changed ?? false});
            rest = rest.slice(take);
            segLeft -= Math.min(segLeft, take);
        }
    }
    return pieces;
}
