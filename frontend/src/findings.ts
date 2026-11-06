// Claude's findings: places in the diff Claude thinks deserve a comment. Each shows as a dashed
// card under its line until the reviewer accepts it as a draft or dismisses it. Both are kept per
// pull request (or local review) and head, by the finding's key.
import {isRecord, listOf} from './claude';
import type {Draft, Side} from './drafts';

export type FindingKind = 'bug' | 'risk' | 'test' | 'nit';
export type Finding = {key: string; path: string; line: number; side: Side; kind: FindingKind; confidence: number; title: string; body: string};

const isKind = (v: unknown): v is FindingKind => v === 'bug' || v === 'risk' || v === 'test' || v === 'nit';
const isSide = (v: unknown): v is Side => v === 'RIGHT' || v === 'LEFT';

// findingKey names a finding by its file, line and title, so the same finding asked for again
// (a re-run, the cache) is still the one the reviewer settled. FNV-1a, as hex.
export function findingKey({path, line, title}: {path: string; line: number; title: string}): string {
    let hash = 0x811c9dc5;
    for (const ch of `${path}\0${line}\0${title}`) {
        hash ^= ch.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

// parseFindings reads Claude's answer, keeping whole findings on changed files. Null when the
// answer is not a list of findings.
export function parseFindings({value, paths}: {value: unknown; paths: ReadonlySet<string>}): Finding[] | null {
    if (!isRecord(value) || !Array.isArray(value.findings)) return null;
    return listOf(value.findings, ({path, line, side, kind, confidence, title, body}) => {
        if (typeof path !== 'string' || !paths.has(path) || typeof line !== 'number' || !Number.isInteger(line) || line < 1) return null;
        if (!isSide(side) || !isKind(kind) || typeof confidence !== 'number' || confidence < 0 || confidence > 1) return null;
        if (typeof title !== 'string' || !title.trim() || typeof body !== 'string') return null;
        return {key: findingKey({path, line, title}), path, line, side, kind, confidence, title, body};
    });
}

// Lines that take a comment, per file and side, from commentableLines of each file's diff.
export type Commentable = Readonly<Record<string, Record<Side, ReadonlySet<number>>>>;

// shownFindings keeps the findings on a line GitHub takes a comment on, minus those the reviewer
// accepted or dismissed. A file whose diff is not read yet shows none until it is.
export function shownFindings({findings, commentable, settled}: {
    findings: Finding[];
    commentable: Commentable;
    settled: ReadonlySet<string>;
}): Finding[] {
    return findings.filter(f => !settled.has(f.key) && (commentable[f.path]?.[f.side].has(f.line) ?? false));
}

export function parseSettled(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// nextFinding is the finding after (step 1) or before (step -1) from, in the order on screen: by
// file as listed, then by line. It wraps around. With no from it starts at the top.
export function nextFinding({findings, order, from, step}: {
    findings: Finding[];
    order: string[];
    from: {path: string; line: number} | null;
    step: 1 | -1;
}): Finding | null {
    const rank = (path: string) => {
        const i = order.indexOf(path);
        return i < 0 ? order.length : i;
    };
    const compare = (a: {path: string; line: number}, b: {path: string; line: number}) => rank(a.path) - rank(b.path) || a.line - b.line;
    const sorted = [...findings].sort(compare);
    if (!sorted.length) return null;
    if (!from) return step === 1 ? sorted[0] : sorted[sorted.length - 1];
    if (step === 1) return sorted.find(f => compare(f, from) > 0) ?? sorted[0];
    return sorted.findLast(f => compare(f, from) < 0) ?? sorted[sorted.length - 1];
}

// acceptFinding turns a finding into a line draft at its place, in Claude's words, for the
// reviewer to edit before it posts.
export function acceptFinding(finding: Finding, {id, head}: {id: string; head: string | null}): Draft {
    return {kind: 'line', id, path: finding.path, line: finding.line, side: finding.side, body: finding.body.trim() || finding.title, head};
}

const KIND_LABEL: Record<FindingKind, string> = {bug: 'possible bug', risk: 'risk', test: 'missing test', nit: 'nit'};

export function findingLabel(kind: FindingKind): string {
    return KIND_LABEL[kind];
}

// whyQuestion is what Why? asks in the Ask panel about a finding.
export function whyQuestion(finding: Finding): string {
    return `You flagged ${finding.path}:${finding.line} as a ${findingLabel(finding.kind)}: "${finding.title}". ${finding.body}\n`
        + 'Why? Show me the code that makes it a problem, or tell me if it is not one.';
}
