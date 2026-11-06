import {describe, expect, it} from 'vitest';
import {emptyRecord} from './review';
import type {FileChange} from './tree';
import {groupByState, noiseOf, parseTreeViews, readingOrder} from './triage';

const file = (path: string, more: Partial<FileChange> = {}): FileChange => ({path, status: 'M', added: 1, deleted: 1, ...more});
const paths = (files: {path: string}[]) => files.map(f => f.path);

describe('noiseOf', () => {
    it('folds lock files by name, in any folder', () => {
        for (const path of ['package-lock.json', 'web/yarn.lock', 'pnpm-lock.yaml', 'go.sum', 'Cargo.lock', 'Gemfile.lock',
            'poetry.lock', 'composer.lock', 'bun.lockb', 'uv.lock']) {
            expect(noiseOf(file(path)), path).toBe('lockfile');
        }
        expect(noiseOf(file('docs/lockfile.md'))).toBeNull();
        expect(noiseOf(file('go.mod'))).toBeNull();
    });

    it('folds what git marks generated or whitespace only', () => {
        expect(noiseOf(file('api.pb.go', {generated: true}))).toBe('generated');
        expect(noiseOf(file('main.go', {whitespaceOnly: true}))).toBe('whitespace');
    });

    it('folds a rename only when no line changed', () => {
        expect(noiseOf(file('new.go', {status: 'R', oldPath: 'old.go', added: 0, deleted: 0}))).toBe('rename');
        expect(noiseOf(file('new.go', {status: 'R', oldPath: 'old.go', added: 2, deleted: 1}))).toBeNull();
        expect(noiseOf(file('new.go', {status: 'R', oldPath: 'old.go', added: 3, deleted: 0}))).toBeNull();
        expect(noiseOf(file('empty.go', {status: 'A', added: 0, deleted: 0}))).toBeNull();
    });

    it('leaves ordinary changes alone', () => {
        expect(noiseOf(file('src/app.ts'))).toBeNull();
    });
});

describe('readingOrder', () => {
    it('reads schema, then types, code, tests, docs and config', () => {
        const files = [
            file('vite.config.ts'),
            file('README.md'),
            file('e2e/flow.spec.ts'),
            file('src/app.ts'),
            file('src/types.ts'),
            file('db/migrations/002_add_limit.sql'),
            file('.github/workflows/ci.yml'),
            file('.gitignore'),
            file('models/user.go'),
            file('prisma/schema.prisma'),
        ];
        expect(paths(readingOrder(files))).toEqual([
            'db/migrations/002_add_limit.sql',
            'prisma/schema.prisma',
            'models/user.go',
            'src/types.ts',
            'src/app.ts',
            'e2e/flow.spec.ts',
            'README.md',
            '.github/workflows/ci.yml',
            '.gitignore',
            'vite.config.ts',
        ]);
    });

    it('puts each test right after the file it tests', () => {
        const files = [
            file('api/limit_test.go'),
            file('api/limit.go'),
            file('api/server.go'),
            file('web/form.test.tsx'),
            file('web/form.tsx'),
            file('web/form.spec.tsx'),
            file('py/test_parse.py'),
            file('py/parse.py'),
            file('py/clean_test.py'),
            file('py/clean.py'),
        ];
        expect(paths(readingOrder(files))).toEqual([
            'api/limit.go',
            'api/limit_test.go',
            'api/server.go',
            'py/clean.py',
            'py/clean_test.py',
            'py/parse.py',
            'py/test_parse.py',
            'web/form.tsx',
            'web/form.spec.tsx',
            'web/form.test.tsx',
        ]);
    });

    it('pairs a test in another folder when only one file has its name', () => {
        const files = [file('src/__tests__/sum.test.ts'), file('src/sum.ts'), file('src/zeta.ts')];
        expect(paths(readingOrder(files))).toEqual(['src/sum.ts', 'src/__tests__/sum.test.ts', 'src/zeta.ts']);
    });

    it('keeps a test with the tests when its file is not in the list', () => {
        const files = [file('api/limit_test.go'), file('api/server.go'), file('README.md')];
        expect(paths(readingOrder(files))).toEqual(['api/server.go', 'api/limit_test.go', 'README.md']);
    });

    it('leaves a test unpaired when several files elsewhere share its name', () => {
        const files = [file('tests/sum.test.ts'), file('a/sum.ts'), file('b/sum.ts')];
        expect(paths(readingOrder(files))).toEqual(['a/sum.ts', 'b/sum.ts', 'tests/sum.test.ts']);
    });

    it('prefers the file in the same folder over one elsewhere', () => {
        const files = [file('b/sum.ts'), file('a/sum.ts'), file('a/sum.test.ts')];
        expect(paths(readingOrder(files))).toEqual(['a/sum.ts', 'a/sum.test.ts', 'b/sum.ts']);
    });
});

describe('groupByState', () => {
    it('sorts files into sections, in reading order, leaving out empty ones', () => {
        const files = [file('b.go'), file('a_test.go'), file('a.go'), file('c.go'), file('d.go'), file('go.sum')];
        const record = {states: {'c.go': 'DISMISSED', 'd.go': 'VIEWED'}, pending: {}};
        const sections = groupByState({files, record});
        expect(sections.map(s => [s.kind, paths(s.files)])).toEqual([
            ['to-review', ['a.go', 'a_test.go', 'b.go']],
            ['changed', ['c.go']],
            ['reviewed', ['d.go']],
            ['folded', ['go.sum']],
        ]);
    });

    it('folds noise whatever its review state, so it still counts and can be marked', () => {
        const files = [file('go.sum'), file('yarn.lock')];
        const record = {states: {'go.sum': 'VIEWED'}, pending: {}};
        expect(groupByState({files, record}).map(s => [s.kind, paths(s.files)])).toEqual([
            ['folded', ['go.sum', 'yarn.lock']],
        ]);
    });

    it('has no sections without files', () => {
        expect(groupByState({files: [], record: emptyRecord})).toEqual([]);
    });
});

describe('parseTreeViews', () => {
    it('starts pull requests by state and local reviews as folders', () => {
        expect(parseTreeViews(null)).toEqual({pr: 'state', local: 'folders'});
    });

    it('keeps a saved choice and drops what it does not know', () => {
        expect(parseTreeViews({pr: 'folders', local: 'state'})).toEqual({pr: 'folders', local: 'state'});
        expect(parseTreeViews({pr: 'tiles', local: 3})).toEqual({pr: 'state', local: 'folders'});
        expect(parseTreeViews('state')).toEqual({pr: 'state', local: 'folders'});
    });
});
