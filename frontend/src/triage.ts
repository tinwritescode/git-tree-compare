// Triage for the "By state" tree: which files are noise, the order a careful reviewer reads the
// rest in, and which section each file sits in. All pure, so later features can reorder or group
// the "To review" section without touching the tree.
import {isChangedSinceReview, isReviewed, type ReviewRecord} from './review';
import type {FileChange} from './tree';
import {basename, folderOf} from './util';

// Noise: changes a person rarely reads line by line. They fold away but still count and can be marked.
export type NoiseReason = 'lockfile' | 'generated' | 'rename' | 'whitespace';

export const NOISE_LABEL: Record<NoiseReason, string> = {
    lockfile: 'lock file',
    generated: 'generated',
    rename: 'renamed only',
    whitespace: 'whitespace only',
};

const LOCKFILES = new Set([
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'go.sum', 'Cargo.lock', 'Gemfile.lock', 'poetry.lock',
    'composer.lock', 'bun.lockb', 'uv.lock',
]);

export function isLockfile(path: string): boolean {
    return LOCKFILES.has(basename(path));
}

// noiseOf says why a file is noise, or null when it deserves a read. Generated and whitespace
// only come from git (see ChangedFiles); a rename is noise when no line changed.
export function noiseOf(file: FileChange): NoiseReason | null {
    if (isLockfile(file.path)) return 'lockfile';
    if (file.generated) return 'generated';
    if (file.status === 'R' && file.added === 0 && file.deleted === 0) return 'rename';
    if (file.whitespaceOnly) return 'whitespace';
    return null;
}

// Reading order: what the change rests on first, then the code, its tests, and the paperwork.
type Rank = 'schema' | 'types' | 'code' | 'test' | 'docs' | 'config';
const RANK_ORDER: Record<Rank, number> = {schema: 0, types: 1, code: 2, test: 3, docs: 4, config: 5};

// A test pattern and how to name the file it tests from the test's base name.
const TESTS: {test: RegExp; subjects: (name: string) => string[]}[] = [
    {test: /_test\.go$/, subjects: n => [n.replace(/_test\.go$/, '.go')]},
    {test: /\.(test|spec)\.[jt]sx?$/, subjects: n => {
        const [, stem, ext] = /^(.*)\.(?:test|spec)\.([jt]sx?)$/.exec(n) ?? [];
        const others = ['ts', 'tsx', 'js', 'jsx'].filter(e => e !== ext);
        return [ext, ...others].map(e => `${stem}.${e}`);
    }},
    {test: /^test_.*\.py$/, subjects: n => [n.replace(/^test_/, '')]},
    {test: /_test\.py$/, subjects: n => [n.replace(/_test\.py$/, '.py')]},
];

const testOf = (path: string) => TESTS.find(t => t.test.test(basename(path))) ?? null;

function rankOf(path: string): Rank {
    const name = basename(path);
    if (testOf(path)) return 'test';
    if (/\.sql$/.test(name) || /(^|\/)migrations?\//.test(path) || /schema/i.test(name)) return 'schema';
    if (/\.d\.ts$/.test(name) || /(^|\/)(types?|models?)(\/|\.[^/]+$)/.test(path)) return 'types';
    if (/\.mdx?$/.test(name)) return 'docs';
    if (/\.(json|ya?ml|toml|ini|cfg|conf|env)$/.test(name) || /\.config\.[cm]?[jt]s$/.test(name)
        || name.startsWith('.') || ['Dockerfile', 'Makefile', 'go.mod'].includes(name)) return 'config';
    return 'code';
}

const byPath = (a: {path: string}, b: {path: string}) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

// subjectOf finds the file a test tests: next to it first, else the only file with that name.
function subjectOf<T extends {path: string}>(test: T, others: T[]): T | null {
    const pattern = testOf(test.path);
    if (!pattern) return null;
    const names = pattern.subjects(basename(test.path));
    const dir = folderOf(test.path);
    for (const name of names) {
        const near = others.find(f => f.path === dir + name);
        if (near) return near;
    }
    for (const name of names) {
        const far = others.filter(f => basename(f.path) === name);
        if (far.length === 1) return far[0];
    }
    return null;
}

// readingOrder sorts files schema → types → code → tests → docs → config, by path within each,
// and moves a test directly after the file it tests when that file is in the list.
export function readingOrder<T extends {path: string}>(files: T[]): T[] {
    const ranked = [...files].sort((a, b) => RANK_ORDER[rankOf(a.path)] - RANK_ORDER[rankOf(b.path)] || byPath(a, b));
    const subjects = ranked.filter(f => !testOf(f.path));
    const testsOf = new Map<T, T[]>();
    const paired = new Set<T>();
    for (const f of ranked) {
        const subject = subjectOf(f, subjects);
        if (!subject) continue;
        testsOf.set(subject, [...(testsOf.get(subject) ?? []), f]);
        paired.add(f);
    }
    return ranked.flatMap(f => (paired.has(f) ? [] : [f, ...(testsOf.get(f) ?? [])]));
}

// The "By state" tree: what is left to read, what a push changed after you viewed it, what is
// done, and the noise.
export type SectionKind = 'to-review' | 'changed' | 'reviewed' | 'folded';
export type Section = {kind: SectionKind; files: FileChange[]};

export const SECTION_TITLE: Record<SectionKind, string> = {
    'to-review': 'To review',
    changed: 'Changed since you viewed',
    reviewed: 'Reviewed',
    folded: 'Folded',
};

const SECTION_ORDER: SectionKind[] = ['to-review', 'changed', 'reviewed', 'folded'];

function sectionOf(file: FileChange, record: ReviewRecord): SectionKind {
    if (noiseOf(file)) return 'folded';
    if (isReviewed(record, file.path)) return 'reviewed';
    if (isChangedSinceReview(record, file.path)) return 'changed';
    return 'to-review';
}

// groupByState puts each file in its section, each section in reading order. Empty sections are left out.
export function groupByState({files, record}: {files: FileChange[]; record: ReviewRecord}): Section[] {
    const ordered = readingOrder(files);
    return SECTION_ORDER
        .map(kind => ({kind, files: ordered.filter(f => sectionOf(f, record) === kind)}))
        .filter(s => s.files.length > 0);
}

// Which tree a review starts with, per kind of review. Saved, so it is read back as unknown.
export type TreeView = 'folders' | 'state';
export type TreeViews = {pr: TreeView; local: TreeView};

export const DEFAULT_TREE_VIEWS: TreeViews = {pr: 'state', local: 'folders'};

const isTreeView = (v: unknown): v is TreeView => v === 'folders' || v === 'state';

export function parseTreeViews(value: unknown): TreeViews {
    if (typeof value !== 'object' || value === null) return DEFAULT_TREE_VIEWS;
    const pr = 'pr' in value ? value.pr : undefined;
    const local = 'local' in value ? value.local : undefined;
    return {
        pr: isTreeView(pr) ? pr : DEFAULT_TREE_VIEWS.pr,
        local: isTreeView(local) ? local : DEFAULT_TREE_VIEWS.local,
    };
}
