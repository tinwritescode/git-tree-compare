import {type KeyboardEvent, useEffect, useMemo, useRef, useState} from 'react';
import type {main} from '../wailsjs/go/models';
import {SearchFiles} from '../wailsjs/go/main/App';
import {groupHits, markRanges} from './search';
import {OwlSearch} from './mascots';

export type SearchQuery = main.SearchQuery;
export type SearchHit = main.SearchHit;

export const emptyQuery: SearchQuery = {text: '', caseSensitive: false, word: false, regex: false};

// The toggles beside the input, with the ⌥ key that flips each one.
const TOGGLES = [
    {key: 'caseSensitive', label: 'Aa', title: 'Match case (⌥C)', code: 'KeyC'},
    {key: 'word', label: 'ab', title: 'Match whole word (⌥W)', code: 'KeyW'},
    {key: 'regex', label: '.*', title: 'Use regular expression (⌥R)', code: 'KeyR'},
] as const;

// SearchDialog searches the content of the pull request's files at its head commit.
// It searches as the reviewer types; Enter opens the chosen line.
export function SearchDialog({repo, head, paths, query, onQuery, onPick, onClose}: {
    repo: string;
    head: string;
    paths: string[];
    query: SearchQuery; // kept by the caller, so reopening shows the last search
    onQuery: (q: SearchQuery) => void;
    onPick: (hit: SearchHit) => void;
    onClose: () => void;
}) {
    const [result, setResult] = useState<main.SearchResult | null>(null);
    const [error, setError] = useState('');
    const [index, setIndex] = useState(0);
    const input = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLUListElement>(null);

    useEffect(() => input.current?.select(), []);

    // Search 150ms after the last keystroke, from two characters on. A slower, older search never wins.
    useEffect(() => {
        if (query.text.length < 2) {
            setResult(null);
            setError('');
            return;
        }
        let stale = false;
        const timer = setTimeout(() => {
            SearchFiles(repo, head, paths, query)
                .then(r => {
                    if (stale) return;
                    setResult(r);
                    setError('');
                    setIndex(0);
                })
                .catch(e => !stale && setError(String(e)));
        }, 150);
        return () => {
            stale = true;
            clearTimeout(timer);
        };
    }, [repo, head, paths, query]);

    const hits = result?.hits ?? [];
    const groups = useMemo(() => groupHits(hits), [hits]);

    useEffect(() => {
        list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block: 'nearest'});
    }, [index]);

    function onKey(e: KeyboardEvent) {
        const toggle = e.altKey && TOGGLES.find(t => t.code === e.code);
        if (toggle) {
            e.preventDefault();
            onQuery({...query, [toggle.key]: !query[toggle.key]});
        } else if (e.key === 'Escape') {
            onClose();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setIndex(i => Math.min(i + 1, hits.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setIndex(i => Math.max(i - 1, 0));
        } else if (e.key === 'Enter' && hits[index]) {
            onPick(hits[index]);
        }
    }

    let at = -1; // the running hit number across groups, to match index
    return (
        <div className="overlay" onClick={onClose}>
            <div className="quick search" role="dialog" aria-label="Search in files" onClick={e => e.stopPropagation()}>
                <div className="search-bar">
                    <input
                        ref={input}
                        autoFocus
                        placeholder="Search in this pull request's files…"
                        value={query.text}
                        onChange={e => onQuery({...query, text: e.target.value})}
                        onKeyDown={onKey}
                    />
                    {TOGGLES.map(t => (
                        <button
                            key={t.key}
                            className="search-toggle"
                            aria-pressed={query[t.key]}
                            title={t.title}
                            onClick={() => {
                                onQuery({...query, [t.key]: !query[t.key]});
                                input.current?.focus();
                            }}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>
                {error && <div className="search-error" role="alert">{error}</div>}
                <ul ref={list} role="listbox" aria-label="Matches">
                    {groups.map(g => (
                        <li key={g.path} className="search-group" role="presentation">
                            <span className="search-path">{g.path}</span>
                            <span className="search-count">{g.hits.length}</span>
                            <ul role="presentation">
                                {g.hits.map(h => {
                                    const i = ++at;
                                    return (
                                        <li
                                            key={h.line}
                                            role="option"
                                            aria-selected={i === index}
                                            className={i === index ? 'active' : ''}
                                            onMouseEnter={() => setIndex(i)}
                                            onClick={() => onPick(h)}
                                        >
                                            <span className="search-line">{h.line}</span>
                                            <span className="search-text">
                                                {markRanges(h.text, h.ranges).map((p, j) => p.match ? <mark key={j}>{p.text}</mark> : p.text)}
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                        </li>
                    ))}
                    {result && !hits.length && <li className="none mascot-state"><OwlSearch/>No matches in the {paths.length} changed files.</li>}
                    {!result && !error && <li className="none">Type at least two characters.</li>}
                </ul>
                {result?.truncated && <div className="search-foot">Showing the first {hits.length} matches. Narrow the search.</div>}
            </div>
        </div>
    );
}
