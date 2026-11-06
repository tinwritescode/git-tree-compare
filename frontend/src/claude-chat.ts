// Explain and Ask: Claude's streamed answers, the Ask conversation and its session, and the
// plain text blocks the panel draws them as.
import {type ClaudeEvent} from './claude';
import {basename} from './util';

// What an answer shows as it streams: Claude's words, and the files it looks at in between.
export type ClaudePart = {kind: 'text'; text: string} | {kind: 'tool'; name: string; path: string | null};
export type TurnStatus = {kind: 'running'} | {kind: 'done'; costUsd: number | null} | {kind: 'error'; message: string};
// One question and its answer. ask is what the reviewer asked, or what Explain was asked about.
export type Turn = {taskId: string; ask: string; parts: ClaudePart[]; status: TurnStatus};

export function startTurn({taskId, ask}: {taskId: string; ask: string}): Turn {
    return {taskId, ask, parts: [], status: {kind: 'running'}};
}

export function turnStep(turn: Turn, event: ClaudeEvent): Turn {
    if (turn.status.kind !== 'running') return turn;
    switch (event.kind) {
        case 'text': {
            const last = turn.parts.at(-1);
            const before = last?.kind === 'text' ? turn.parts.slice(0, -1) : turn.parts;
            const joined: ClaudePart = {kind: 'text', text: (last?.kind === 'text' ? last.text : '') + event.delta};
            return {...turn, parts: [...before, joined]};
        }
        case 'tool':
            return {...turn, parts: [...turn.parts, {kind: 'tool', name: event.name, path: event.path}]};
        case 'result': {
            // A kept answer arrives as the result alone, with nothing streamed before it.
            const streamed = turn.parts.some(p => p.kind === 'text');
            const kept: ClaudePart[] = streamed || !event.text ? [] : [{kind: 'text', text: event.text}];
            return {...turn, parts: [...turn.parts, ...kept], status: {kind: 'done', costUsd: event.costUsd}};
        }
        case 'error':
            return {...turn, status: {kind: 'error', message: event.message}};
        default: {
            const _exhaustive: never = event;
            return _exhaustive;
        }
    }
}

// toolActivity is the line shown while Claude uses a tool.
export function toolActivity({name, path}: {name: string; path: string | null}): string {
    switch (name) {
        case 'Read':
            return `Reading ${path ? basename(path) : 'a file'}…`;
        case 'Grep':
            return path ? `Searching ${basename(path)}…` : 'Searching the code…';
        case 'Glob':
            return 'Looking for files…';
        default:
            return `Using ${name}…`;
    }
}

// The Ask session: Claude keeps the conversation under an id the app makes. A session is
// started once its first answer came back; until then a failed start is dropped, as Claude may
// not have kept it, and the next question starts a new one.
export type AskSession = {kind: 'new'} | {kind: 'starting'; id: string} | {kind: 'started'; id: string};
export type Conversation = {session: AskSession; turns: Turn[]};
export const emptyConversation: Conversation = {session: {kind: 'new'}, turns: []};

// askTurn adds the reviewer's question and says how to send it: resume a started session, or
// start one (and send the diff). Null for a blank question, or while an answer is coming.
export function askTurn({conversation, taskId, question, newSessionId}: {
    conversation: Conversation;
    taskId: string;
    question: string;
    newSessionId: () => string;
}): {conversation: Conversation; send: {session: string; resume: boolean}} | null {
    const ask = question.trim();
    if (!ask || conversation.turns.some(t => t.status.kind === 'running')) return null;
    const {session} = conversation;
    const next: AskSession = session.kind === 'started' ? session : {kind: 'starting', id: newSessionId()};
    return {
        conversation: {session: next, turns: [...conversation.turns, startTurn({taskId, ask})]},
        send: {session: next.id, resume: next.kind === 'started'},
    };
}

export function conversationStep({conversation, taskId, event}: {conversation: Conversation; taskId: string; event: ClaudeEvent}): Conversation {
    if (!conversation.turns.some(t => t.taskId === taskId)) return conversation;
    const turns = conversation.turns.map(t => (t.taskId === taskId ? turnStep(t, event) : t));
    const {session} = conversation;
    if (session.kind !== 'starting') return {...conversation, turns};
    switch (event.kind) {
        case 'result':
            return {session: {kind: 'started', id: session.id}, turns};
        case 'error':
            return {session: {kind: 'new'}, turns};
        default:
            return {...conversation, turns};
    }
}

// askKey names a conversation: one per repository, pull request (or local review) and head, so a
// push starts a new one.
export function askKey({repo, pr, base, head}: {repo: string; pr: number | null; base: string; head: string}): string {
    return pr !== null ? `${repo}#${pr}@${head}` : `${repo}@${base}..${head}`;
}

// What the panel draws Claude's text as: paragraphs with inline code, and fenced code blocks.
// Everything stays text; nothing Claude writes is read as markup.
export type Span = {kind: 'text' | 'code'; text: string};
export type TextBlock = {kind: 'para'; spans: Span[]} | {kind: 'code'; text: string};

const FENCE = /^\s*```/;
const INLINE_CODE = /`([^`\n]+)`/g;

export function textBlocks(text: string): TextBlock[] {
    const blocks: TextBlock[] = [];
    let para: string[] = [];
    let code: string[] | null = null; // inside a fence; a fence still streaming has no end yet
    const endPara = () => {
        if (para.length) blocks.push({kind: 'para', spans: spansOf(para.join('\n'))});
        para = [];
    };
    for (const line of text.split('\n')) {
        if (code) {
            if (FENCE.test(line)) {
                blocks.push({kind: 'code', text: code.join('\n')});
                code = null;
            } else {
                code.push(line);
            }
        } else if (FENCE.test(line)) {
            endPara();
            code = [];
        } else if (line.trim() === '') {
            endPara();
        } else {
            para.push(line);
        }
    }
    endPara();
    if (code) blocks.push({kind: 'code', text: code.join('\n')});
    return blocks;
}

function spansOf(text: string): Span[] {
    const spans: Span[] = [];
    let at = 0;
    for (const m of text.matchAll(INLINE_CODE)) {
        if (m.index > at) spans.push({kind: 'text', text: text.slice(at, m.index)});
        spans.push({kind: 'code', text: m[1]});
        at = m.index + m[0].length;
    }
    if (at < text.length) spans.push({kind: 'text', text: text.slice(at)});
    return spans;
}
