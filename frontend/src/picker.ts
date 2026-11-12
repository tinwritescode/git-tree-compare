// What the repository picker offers for what was typed. Pure, so the dialog only draws it.
import {basename, fuzzyMatch} from './util';

// PickerRow is one choice in the repository picker.
export interface PickerRow {
    kind: 'here' | 'recent' | 'folder'; // the open folder itself, a repository opened before, a folder inside the open one
    path: string;
    name: string;
    isRepo: boolean; // a repository opens; any other folder is entered
    marks: number[]; // the letters of name the filter matched
}

// splitQuery reads what was typed. A path (it starts with / or ~) names the folder to list and
// leaves its last part as the filter; anything else is words that filter the open folder.
export function splitQuery({typed, home}: {typed: string; home: string}): {dir: string | null; filter: string} {
    const text = typed.trimStart();
    if (!/^(\/|~(\/|$))/.test(text)) return {dir: null, filter: text.trim()};
    const path = text.replace(/^~\/?/, `${home}/`);
    const cut = path.lastIndexOf('/');
    return {dir: path.slice(0, cut) || '/', filter: path.slice(cut + 1).trim()};
}

// wholeWord finds word in text in one piece, at the start of a part of the name when it can.
function wholeWord(word: string, text: string): {score: number; marks: number[]} | null {
    const starts: number[] = [];
    for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) starts.push(at);
    if (!starts.length) return null;
    const edge = starts.find(at => at === 0 || '/._- '.includes(text[at - 1]));
    const at = edge ?? starts[0];
    return {score: (edge === undefined ? 1 : 0) + at * 0.01, marks: Array.from({length: word.length}, (_, i) => at + i)};
}

// matchWords scores a name against the words of a filter. Every word must be in it, in any order, and a
// word the name holds whole beats one whose letters are scattered through it. Lower is better; null is no match.
function matchWords(words: string[], name: string): {score: number; marks: number[]} | null {
    const text = name.toLowerCase();
    const marks = new Set<number>();
    let score = name.length * 0.01;
    for (const word of words) {
        const whole = wholeWord(word.toLowerCase(), text);
        const match = whole ?? fuzzyMatch(word, name);
        if (!match) return null;
        score += whole ? match.score : 100 + match.score;
        for (const at of match.marks) marks.add(at);
    }
    return {score, marks: [...marks].sort((a, b) => a - b)};
}

// pickerRows lists the choices. With no filter: the open folder when it is a repository, the
// recent repositories, then the folders inside. With a filter: whatever matches, the best first.
export function pickerRows({filter, here, entries, recent}: {
    filter: string;
    here: {path: string; isRepo: boolean} | null; // the open folder
    entries: {name: string; path: string; isRepo: boolean}[]; // the folders inside it
    recent: string[]; // repositories opened before, newest first
}): PickerRow[] {
    const known = new Set(recent);
    const rows: PickerRow[] = [
        ...(here?.isRepo && !filter ? [{kind: 'here' as const, path: here.path, name: basename(here.path), isRepo: true, marks: []}] : []),
        ...recent.map(path => ({kind: 'recent' as const, path, name: basename(path), isRepo: true, marks: []})),
        ...entries.filter(e => !known.has(e.path)).map(e => ({kind: 'folder' as const, path: e.path, name: e.name, isRepo: e.isRepo, marks: []})),
    ];
    const words = filter.split(/\s+/).filter(Boolean);
    if (!words.length) return rows;
    return rows
        .flatMap(row => {
            const match = matchWords(words, row.name);
            return match ? [{row: {...row, marks: match.marks}, score: match.score}] : [];
        })
        .sort((a, b) => a.score - b.score)
        .map(m => m.row);
}

// crumbs splits a folder path into the folders that lead to it, each with its own path. Home is shortened to ~.
export function crumbs({path, home}: {path: string; home: string}): {name: string; path: string}[] {
    const inHome = home !== '' && (path === home || path.startsWith(`${home}/`));
    const root = inHome ? {name: '~', path: home} : {name: '/', path: '/'};
    const rest = path.slice(root.path.length).split('/').filter(Boolean);
    return rest.reduce((trail, name) => [...trail, {name, path: `${trail[trail.length - 1].path.replace(/\/$/, '')}/${name}`}], [root]);
}
