// Claude in the review: the events a task streams, the brief it writes, and the settings that
// choose its model. Everything that arrives from the backend or from storage is parsed here once.
import {basename} from './util';

// What a running task reports, sent by the backend as claude:<taskId>. The last one is a result or an error.
export type ClaudeEvent =
    | {kind: 'tool'; name: string; path: string | null}
    | {kind: 'text'; delta: string}
    | {kind: 'result'; json: unknown; text: string; costUsd: number | null}
    | {kind: 'error'; message: string};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function parseClaudeEvent(value: unknown): ClaudeEvent | null {
    if (!isRecord(value)) return null;
    switch (value.kind) {
        case 'tool': {
            const name = str(value.name);
            return name ? {kind: 'tool', name, path: str(value.path) || null} : null;
        }
        case 'text': {
            const delta = str(value.delta);
            return delta === null ? null : {kind: 'text', delta};
        }
        case 'result':
            return {
                kind: 'result',
                json: value.json ?? null,
                text: str(value.text) ?? '',
                costUsd: typeof value.costUsd === 'number' ? value.costUsd : null,
            };
        case 'error': {
            const message = str(value.message);
            return message === null ? null : {kind: 'error', message};
        }
        default:
            return null;
    }
}

// The brief: what the change does, where to slow down, the order to read it in, and what no test covers.
export type RiskLevel = 'low' | 'med' | 'high';
export type Risk = {path: string; line: number; level: RiskLevel; why: string};
export type Chapter = {title: string; paths: string[]};
export type Untested = {path: string; line: number; what: string};
export type Brief = {summary: string; risks: Risk[]; chapters: Chapter[]; untested: Untested[]};

export const RISK_RANK: Record<RiskLevel, number> = {low: 0, med: 1, high: 2};
const isRiskLevel = (v: unknown): v is RiskLevel => v === 'low' || v === 'med' || v === 'high';
const isLine = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

// listOf parses each entry of a list Claude wrote, dropping what does not parse.
function listOf<T>(value: unknown, parse: (entry: Record<string, unknown>) => T | null): T[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap(entry => {
        const parsed = isRecord(entry) ? parse(entry) : null;
        return parsed === null ? [] : [parsed];
    });
}

// parseBrief checks Claude's answer against the change: an entry about a file the change does not
// touch is dropped, as Claude may name a file it read or made up. Null when there is no summary.
export function parseBrief({value, paths}: {value: unknown; paths: ReadonlySet<string>}): Brief | null {
    if (!isRecord(value)) return null;
    const summary = str(value.summary);
    if (!summary) return null;
    const changed = (p: unknown): p is string => typeof p === 'string' && paths.has(p);
    return {
        summary,
        risks: listOf(value.risks, ({path, line, level, why}) =>
            (changed(path) && isLine(line) && isRiskLevel(level) && typeof why === 'string' ? {path, line, level, why} : null)),
        chapters: listOf(value.chapters, ({title, paths: list}) => {
            const kept = Array.isArray(list) ? list.filter(changed) : [];
            return typeof title === 'string' && kept.length ? {title, paths: kept} : null;
        }),
        untested: listOf(value.untested, ({path, line, what}) =>
            (changed(path) && isLine(line) && typeof what === 'string' ? {path, line, what} : null)),
    };
}

// What the brief task has done so far. Its answer is kept as Claude wrote it, and checked against
// the change list when shown, since the answer can arrive before the change list does.
export type BriefRun =
    | {kind: 'off'} // no brief for this review: no claude, AI turned off, or a commit
    | {kind: 'running'; reading: string | null} // the file Claude last opened
    | {kind: 'answered'; json: unknown; costUsd: number | null}
    | {kind: 'error'; message: string};

export function briefRunStep(run: BriefRun, event: ClaudeEvent): BriefRun {
    if (run.kind !== 'running') return run;
    switch (event.kind) {
        case 'tool':
            return event.path ? {kind: 'running', reading: basename(event.path)} : run;
        case 'text':
            return run;
        case 'result':
            return {kind: 'answered', json: event.json, costUsd: event.costUsd};
        case 'error':
            return {kind: 'error', message: event.message};
        default: {
            const _exhaustive: never = event;
            return _exhaustive;
        }
    }
}

// What the review shows of the brief.
export type BriefState =
    | {kind: 'off'}
    | {kind: 'running'; reading: string | null}
    | {kind: 'ready'; brief: Brief; costUsd: number | null}
    | {kind: 'error'; message: string};

export function briefState({run, paths}: {run: BriefRun; paths: ReadonlySet<string>}): BriefState {
    if (run.kind !== 'answered') return run;
    const brief = parseBrief({value: run.json, paths});
    return brief ? {kind: 'ready', brief, costUsd: run.costUsd} : {kind: 'error', message: 'Claude answered, but not with a brief.'};
}

// briefChip is the header's word on the brief, or null when there is none.
export function briefChip(state: BriefState): string | null {
    switch (state.kind) {
        case 'off':
            return null;
        case 'running':
            return `Claude reading ${state.reading ?? 'the diff'}…`;
        case 'ready':
            return 'Brief ready';
        case 'error':
            return 'Brief failed';
        default: {
            const _exhaustive: never = state;
            return _exhaustive;
        }
    }
}

// A file's mark in the tree: its worst risk, with every reason for the tooltip.
export type RiskMark = {level: RiskLevel; why: string};

export function riskMarks(brief: Brief): Record<string, RiskMark> {
    const marks: Record<string, RiskMark> = {};
    for (const r of brief.risks) {
        const seen = marks[r.path];
        marks[r.path] = seen
            ? {level: RISK_RANK[r.level] > RISK_RANK[seen.level] ? r.level : seen.level, why: `${seen.why}\n${r.why}`}
            : {level: r.level, why: r.why};
    }
    return marks;
}

// Model per kind of task, chosen in ⌘K. The default comes from the backend.
export const CLAUDE_TASKS = ['brief'] as const;
export type ClaudeTaskKind = (typeof CLAUDE_TASKS)[number];
export const TASK_LABEL: Record<ClaudeTaskKind, string> = {brief: 'Brief'};
export type ClaudeModels = Partial<Record<ClaudeTaskKind, string>>;

// Same rule as the backend: a model name never starts with a dash, so it cannot pass as a flag.
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/;

export function parseClaudeModels(value: unknown): ClaudeModels {
    if (!isRecord(value)) return {};
    const models: ClaudeModels = {};
    for (const kind of CLAUDE_TASKS) {
        const model = value[kind];
        if (typeof model === 'string' && MODEL_NAME.test(model)) models[kind] = model;
    }
    return models;
}

export function modelFor({models, kind, fallback}: {models: ClaudeModels; kind: ClaudeTaskKind; fallback: string}): string {
    return models[kind] ?? fallback;
}

// The models the picker offers: the default, then the aliases claude resolves to the latest of each.
export function modelChoices(defaultModel: string): string[] {
    return [...new Set([defaultModel, 'opus', 'sonnet', 'haiku'])];
}

// parseRepoList reads a saved list of repository paths.
export function parseRepoList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
