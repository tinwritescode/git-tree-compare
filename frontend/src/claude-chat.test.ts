import {describe, expect, it} from 'vitest';
import {askKey, askTurn, type Conversation, conversationStep, emptyConversation, startTurn, textBlocks, toolActivity, type Turn, turnStep} from './claude-chat';
import {type ClaudeEvent} from './claude';

const run = (turn: Turn, events: ClaudeEvent[]) => events.reduce(turnStep, turn);

describe('turnStep', () => {
    const turn = startTurn({taskId: 'explain-1', ask: 'limit.go @@ -1 +1 @@'});

    it('joins streamed text, and puts tool use between the paragraphs around it', () => {
        const got = run(turn, [
            {kind: 'text', delta: 'Let me check '},
            {kind: 'text', delta: 'the callers.'},
            {kind: 'tool', name: 'Read', path: 'pkg/limit.go'},
            {kind: 'tool', name: 'Grep', path: null},
            {kind: 'text', delta: '`limit` '},
            {kind: 'text', delta: 'returns 42.'},
            {kind: 'result', json: null, text: '`limit` returns 42.', costUsd: 0.02},
        ]);
        expect(got.parts).toEqual([
            {kind: 'text', text: 'Let me check the callers.'},
            {kind: 'tool', name: 'Read', path: 'pkg/limit.go'},
            {kind: 'tool', name: 'Grep', path: null},
            {kind: 'text', text: '`limit` returns 42.'},
        ]);
        expect(got.status).toEqual({kind: 'done', costUsd: 0.02});
    });

    it('does not repeat a streamed answer when its result arrives', () => {
        const got = run(turn, [{kind: 'text', delta: 'Streamed.'}, {kind: 'result', json: null, text: 'Streamed.', costUsd: null}]);
        expect(got.parts).toEqual([{kind: 'text', text: 'Streamed.'}]);
    });

    it('shows a kept answer, which arrives as a result alone', () => {
        const got = run(turn, [{kind: 'result', json: null, text: 'Kept answer.', costUsd: null}]);
        expect(got.parts).toEqual([{kind: 'text', text: 'Kept answer.'}]);
        expect(got.status).toEqual({kind: 'done', costUsd: null});
    });

    it('keeps what streamed before an error, and ignores events once ended', () => {
        const failed = run(turn, [{kind: 'text', delta: 'Half'}, {kind: 'error', message: 'Stopped.'}]);
        expect(failed.parts).toEqual([{kind: 'text', text: 'Half'}]);
        expect(failed.status).toEqual({kind: 'error', message: 'Stopped.'});
        expect(turnStep(failed, {kind: 'text', delta: 'late'})).toBe(failed);
    });
});

describe('a conversation', () => {
    let ids = 0;
    const newSessionId = () => `session-${++ids}`;
    const ask = (conversation: Conversation, taskId: string, question = 'Why?') => askTurn({conversation, taskId, question, newSessionId});
    const answer = (conversation: Conversation, taskId: string) =>
        conversationStep({conversation, taskId, event: {kind: 'result', json: null, text: 'Because.', costUsd: 0.1}});
    const fail = (conversation: Conversation, taskId: string) =>
        conversationStep({conversation, taskId, event: {kind: 'error', message: 'Stopped.'}});

    it('starts a session with the first question and resumes it after an answer', () => {
        const first = ask(emptyConversation, 'ask-1');
        expect(first).not.toBeNull();
        if (!first) return;
        expect(first.send).toEqual({session: expect.stringMatching(/^session-/), resume: false});
        expect(first.conversation.session).toEqual({kind: 'starting', id: first.send.session});
        expect(first.conversation.turns.map(t => [t.ask, t.status.kind])).toEqual([['Why?', 'running']]);
        // A second question waits for the first answer.
        expect(ask(first.conversation, 'ask-2')).toBeNull();

        const answered = answer(first.conversation, 'ask-1');
        expect(answered.session).toEqual({kind: 'started', id: first.send.session});
        const second = ask(answered, 'ask-2', 'And then?');
        expect(second?.send).toEqual({session: first.send.session, resume: true});
        expect(second?.conversation.turns.map(t => t.ask)).toEqual(['Why?', 'And then?']);
    });

    it('starts afresh when the first question fails, as Claude may not have kept the session', () => {
        const first = ask(emptyConversation, 'ask-1');
        if (!first) throw new Error('no first turn');
        const failed = fail(first.conversation, 'ask-1');
        expect(failed.session).toEqual({kind: 'new'});
        const retry = ask(failed, 'ask-2');
        expect(retry?.send.resume).toBe(false);
        expect(retry?.send.session).not.toBe(first.send.session);
    });

    it('keeps a started session when a later question fails', () => {
        const first = ask(emptyConversation, 'ask-1');
        if (!first) throw new Error('no first turn');
        const second = ask(answer(first.conversation, 'ask-1'), 'ask-2');
        if (!second) throw new Error('no second turn');
        const failed = fail(second.conversation, 'ask-2');
        expect(failed.session).toEqual({kind: 'started', id: first.send.session});
        expect(ask(failed, 'ask-3')?.send).toEqual({session: first.send.session, resume: true});
    });

    it('ignores a blank question, and events of a task it does not hold', () => {
        expect(ask(emptyConversation, 'ask-1', '  \n')).toBeNull();
        const first = ask(emptyConversation, 'ask-1');
        if (!first) throw new Error('no first turn');
        expect(answer(first.conversation, 'other')).toBe(first.conversation);
    });
});

describe('askKey', () => {
    const head = 'a'.repeat(40);

    it('is one conversation per repository, pull request or local review, and head', () => {
        const pr = askKey({repo: '/r', pr: 7, base: 'b', head});
        expect(askKey({repo: '/r', pr: 7, base: 'other base', head})).toBe(pr);
        expect(askKey({repo: '/r', pr: 7, base: 'b', head: 'c'.repeat(40)})).not.toBe(pr);
        expect(askKey({repo: '/r', pr: 8, base: 'b', head})).not.toBe(pr);
        expect(askKey({repo: '/s', pr: 7, base: 'b', head})).not.toBe(pr);
        expect(askKey({repo: '/r', pr: null, base: 'b', head})).not.toBe(askKey({repo: '/r', pr: null, base: 'd', head}));
    });
});

describe('textBlocks', () => {
    it('splits paragraphs on blank lines and marks inline code', () => {
        expect(textBlocks('One `limit` here.\nSame paragraph.\n\nTwo.')).toEqual([
            {kind: 'para', spans: [{kind: 'text', text: 'One '}, {kind: 'code', text: 'limit'}, {kind: 'text', text: ' here.\nSame paragraph.'}]},
            {kind: 'para', spans: [{kind: 'text', text: 'Two.'}]},
        ]);
    });

    it('keeps fenced code whole, blank lines included, even while it is still streaming', () => {
        expect(textBlocks('See:\n```go\nfunc a() {}\n\nfunc b() {}\n```\nDone.')).toEqual([
            {kind: 'para', spans: [{kind: 'text', text: 'See:'}]},
            {kind: 'code', text: 'func a() {}\n\nfunc b() {}'},
            {kind: 'para', spans: [{kind: 'text', text: 'Done.'}]},
        ]);
        expect(textBlocks('```\nhalf')).toEqual([{kind: 'code', text: 'half'}]);
    });

    it('marks inline code at the start and end of a paragraph, with no empty text around it', () => {
        expect(textBlocks('`a` and `b`')).toEqual([
            {kind: 'para', spans: [{kind: 'code', text: 'a'}, {kind: 'text', text: ' and '}, {kind: 'code', text: 'b'}]},
        ]);
    });

    it('leaves a lone backtick as text, and markup as text', () => {
        expect(textBlocks('a ` b <img src=x onerror=alert(1)>')).toEqual([
            {kind: 'para', spans: [{kind: 'text', text: 'a ` b <img src=x onerror=alert(1)>'}]},
        ]);
        expect(textBlocks('')).toEqual([]);
    });
});

describe('toolActivity', () => {
    it('says what Claude is looking at', () => {
        expect(toolActivity({name: 'Read', path: 'pkg/limit.go'})).toBe('Reading limit.go…');
        expect(toolActivity({name: 'Grep', path: 'cmd'})).toBe('Searching cmd…');
        expect(toolActivity({name: 'Grep', path: null})).toBe('Searching the code…');
        expect(toolActivity({name: 'Glob', path: null})).toBe('Looking for files…');
        expect(toolActivity({name: 'WebFetch', path: null})).toBe('Using WebFetch…');
    });
});
