import {describe, expect, it} from 'vitest';
import {
    briefChip, type BriefRun, briefRunStep, briefState, modelChoices, modelFor, parseBrief, parseClaudeEvent, parseClaudeModels, parsePRDescription, parseRepoList,
    fileBrief, riskMarks,
} from './claude';

const paths = new Set(['limit.go', 'limit_test.go', 'server.go']);

describe('parseClaudeEvent', () => {
    it('reads each kind the backend sends', () => {
        expect(parseClaudeEvent({kind: 'tool', name: 'Read', path: 'limit.go'})).toEqual({kind: 'tool', name: 'Read', path: 'limit.go'});
        expect(parseClaudeEvent({kind: 'tool', name: 'Glob'})).toEqual({kind: 'tool', name: 'Glob', path: null});
        expect(parseClaudeEvent({kind: 'text', delta: 'Hel'})).toEqual({kind: 'text', delta: 'Hel'});
        expect(parseClaudeEvent({kind: 'result', json: {a: 1}, text: '{"a":1}', costUsd: 0.4})).toEqual({kind: 'result', json: {a: 1}, text: '{"a":1}', costUsd: 0.4});
        expect(parseClaudeEvent({kind: 'result'})).toEqual({kind: 'result', json: null, text: '', costUsd: null});
        expect(parseClaudeEvent({kind: 'error', message: 'Stopped.'})).toEqual({kind: 'error', message: 'Stopped.'});
    });

    it('drops what it does not recognise', () => {
        for (const bad of [null, 'tool', {kind: 'tool'}, {kind: 'text', delta: 3}, {kind: 'error'}, {kind: 'thinking', text: 'x'}]) {
            expect(parseClaudeEvent(bad), JSON.stringify(bad)).toBeNull();
        }
    });
});

describe('parseBrief', () => {
    const value = {
        summary: 'Caps requests per user.',
        risks: [
            {path: 'limit.go', line: 12, level: 'high', why: 'The lock is taken twice.'},
            {path: 'nowhere.go', line: 1, level: 'high', why: 'Made up.'},
            {path: 'server.go', line: 3, level: 'severe', why: 'Unknown level.'},
            {path: 'server.go', line: '3', level: 'low', why: 'Line is a string.'},
        ],
        chapters: [
            {title: 'Limit', paths: ['limit.go', 'ghost.go', 'limit_test.go']},
            {title: 'Only ghosts', paths: ['ghost.go']},
        ],
        untested: [{path: 'server.go', line: 40, what: 'The 429 reply.'}, {path: 'ghost.go', line: 1, what: 'x'}],
    };

    it('keeps entries about changed files and drops the rest', () => {
        expect(parseBrief({value, paths})).toEqual({
            summary: 'Caps requests per user.',
            risks: [{path: 'limit.go', line: 12, level: 'high', why: 'The lock is taken twice.'}],
            chapters: [{title: 'Limit', paths: ['limit.go', 'limit_test.go']}],
            untested: [{path: 'server.go', line: 40, what: 'The 429 reply.'}],
        });
    });

    it('keeps a risk on line 0, the whole file, and drops one on a line that cannot be', () => {
        const risk = (line: unknown) => ({path: 'limit.go', line, level: 'low', why: `line ${String(line)}`});
        const got = parseBrief({value: {summary: 's', risks: [risk(0), risk(-1), risk(2.5)], untested: [{path: 'limit.go', line: -3, what: 'x'}]}, paths});
        expect(got?.risks.map(r => r.why)).toEqual(['line 0']);
        expect(got?.untested).toEqual([]);
    });

    it('is null without a summary or when it is not an object', () => {
        expect(parseBrief({value: {risks: []}, paths})).toBeNull();
        expect(parseBrief({value: 'brief', paths})).toBeNull();
    });

    it('treats missing lists as empty', () => {
        expect(parseBrief({value: {summary: 's'}, paths})).toEqual({summary: 's', risks: [], chapters: [], untested: []});
    });
});

describe('briefRunStep, briefState and briefChip', () => {
    const running: BriefRun = {kind: 'running', reading: null};
    const show = (run: BriefRun) => briefState({run, paths});

    it('names the file Claude reads, and keeps it while it searches', () => {
        const reading = briefRunStep(running, {kind: 'tool', name: 'Read', path: 'pkg/exchange.go'});
        expect(briefChip(show(reading))).toBe('Claude reading exchange.go…');
        const searching = briefRunStep(reading, {kind: 'tool', name: 'Grep', path: null});
        expect(briefChip(show(searching))).toBe('Claude reading exchange.go…');
        expect(briefChip(show(running))).toBe('Claude reading the diff…');
    });

    it('shows a valid answer as ready, checked against the change list on screen', () => {
        const answered = briefRunStep(running, {kind: 'result', json: {summary: 's', risks: [{path: 'limit.go', line: 1, level: 'low', why: 'w'}]}, text: '', costUsd: 0.5});
        expect(briefState({run: answered, paths})).toEqual({
            kind: 'ready', brief: {summary: 's', risks: [{path: 'limit.go', line: 1, level: 'low', why: 'w'}], chapters: [], untested: []}, costUsd: 0.5,
        });
        // The change list came later and no longer has the file: the risk goes, the brief stays.
        expect(briefState({run: answered, paths: new Set()})).toEqual({kind: 'ready', brief: {summary: 's', risks: [], chapters: [], untested: []}, costUsd: 0.5});
        expect(briefChip(show(answered))).toBe('Brief ready');
    });

    it('fails on an answer that is not a brief, and on an error', () => {
        const bad = briefRunStep(running, {kind: 'result', json: null, text: 'hi', costUsd: null});
        expect(show(bad).kind).toBe('error');
        const failed = briefRunStep(running, {kind: 'error', message: 'Invalid API key'});
        expect(show(failed)).toEqual({kind: 'error', message: 'Invalid API key'});
        expect(briefChip(show(failed))).toBe('Brief failed');
        expect(briefChip({kind: 'off'})).toBeNull();
    });

    it('ignores events once the task has ended', () => {
        const answered: BriefRun = {kind: 'answered', json: {summary: 's'}, costUsd: null};
        expect(briefRunStep(answered, {kind: 'error', message: 'Stopped.'})).toBe(answered);
    });
});

describe('riskMarks', () => {
    it('marks each file with its worst risk and every reason', () => {
        const marks = riskMarks({
            summary: 's', chapters: [], untested: [],
            risks: [
                {path: 'a.go', line: 1, level: 'low', why: 'Small.'},
                {path: 'a.go', line: 9, level: 'high', why: 'Big.'},
                {path: 'b.go', line: 0, level: 'med', why: 'Middle.'},
            ],
        });
        expect(marks).toEqual({'a.go': {level: 'high', why: 'Small.\nBig.'}, 'b.go': {level: 'med', why: 'Middle.'}});
    });
});

describe('fileBrief', () => {
    const brief = {
        summary: 's', chapters: [],
        risks: [
            {path: 'a.go', line: 9, level: 'low' as const, why: 'Small.'},
            {path: 'b.go', line: 0, level: 'med' as const, why: 'Middle.'},
            {path: 'a.go', line: 1, level: 'high' as const, why: 'Big.'},
        ],
        untested: [{path: 'a.go', line: 4, what: 'The retry.'}, {path: 'c.go', line: 2, what: 'The parser.'}],
    };

    it('keeps what the brief says about one file, the worst risk first', () => {
        expect(fileBrief({brief, path: 'a.go'})).toEqual({
            risks: [{path: 'a.go', line: 1, level: 'high', why: 'Big.'}, {path: 'a.go', line: 9, level: 'low', why: 'Small.'}],
            untested: [{path: 'a.go', line: 4, what: 'The retry.'}],
        });
    });

    it('is empty for a file the brief does not mention', () => {
        expect(fileBrief({brief, path: 'z.go'})).toEqual({risks: [], untested: []});
    });
});

describe('model settings', () => {
    it('keeps a chosen model per task and falls back to the default', () => {
        const models = parseClaudeModels({brief: 'sonnet', ask: 'haiku', findings: 'haiku', later: 'opus', other: 3});
        expect(models).toEqual({brief: 'sonnet', ask: 'haiku', findings: 'haiku'});
        expect(modelFor({models, kind: 'brief', fallback: 'claude-opus-5-5'})).toBe('sonnet');
        expect(modelFor({models: {}, kind: 'brief', fallback: 'claude-opus-5-5'})).toBe('claude-opus-5-5');
    });

    it('drops a saved model that could be read as a flag', () => {
        expect(parseClaudeModels({brief: '--dangerously-skip-permissions'})).toEqual({});
        expect(parseClaudeModels('opus')).toEqual({});
    });

    it('offers the default first, without repeating it', () => {
        expect(modelChoices('opus')).toEqual(['opus', 'sonnet', 'haiku']);
        expect(modelChoices('claude-opus-5-5')).toEqual(['claude-opus-5-5', 'opus', 'sonnet', 'haiku']);
    });
});

describe('parseRepoList', () => {
    it('keeps strings only', () => {
        expect(parseRepoList(['/a', 3, '/b'])).toEqual(['/a', '/b']);
        expect(parseRepoList({})).toEqual([]);
    });
});

describe('parsePRDescription', () => {
    it('keeps a one-line title and the body', () => {
        expect(parsePRDescription({title: '  Add limits\n', body: 'Adds a limit.'})).toEqual({title: 'Add limits', body: 'Adds a limit.'});
    });

    it('takes the first line of a title written on several, and refuses an answer without one', () => {
        expect(parsePRDescription({title: 'Add limits\nand more', body: ''})).toEqual({title: 'Add limits', body: ''});
        expect(parsePRDescription({title: ' ', body: 'x'})).toBeNull();
        expect(parsePRDescription({body: 'x'})).toBeNull();
        expect(parsePRDescription('Add limits')).toBeNull();
    });
});
