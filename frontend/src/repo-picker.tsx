import {type KeyboardEvent, useEffect, useRef, useState} from 'react';
import {HomeDir, ListDir} from '../wailsjs/go/main/App';
import type {main} from '../wailsjs/go/models';
import {basename} from './util';
import {Button} from './ui/button';

export interface RepoPickerProps {
    start: string; // folder to open first, usually the current repo's parent
    recent: string[]; // repositories opened before, newest first
    openError?: string; // why the last open failed, shown until the next attempt
    onOpen: (path: string) => void; // the app resolves the path to its repository root
    onClose: () => void;
}

// RepoPicker browses folders inside the app, so opening a repo needs no native dialog.
export function RepoPicker({start, recent, openError, onOpen, onClose}: RepoPickerProps) {
    const [listing, setListing] = useState<main.DirListing | null>(null);
    const [typed, setTyped] = useState('');
    const [error, setError] = useState('');
    const [active, setActive] = useState(0);
    const activeRow = useRef<HTMLLIElement>(null);

    async function go(path: string) {
        try {
            const next = await ListDir(path);
            setListing(next);
            setTyped(next.path);
            setActive(0);
            setError('');
        } catch (e) {
            setError(String(e));
        }
    }

    useEffect(() => {
        HomeDir()
            .catch(() => '')
            .then(home => go(start || home || '/'));
    }, []);

    useEffect(() => {
        activeRow.current?.scrollIntoView({block: 'nearest'});
    }, [active]);

    const rows = listing?.entries ?? [];

    function onKey(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
            return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!rows.length) return;
            setActive(i => (e.key === 'ArrowDown' ? Math.min(i + 1, rows.length - 1) : Math.max(i - 1, 0)));
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            const target = e.target as HTMLElement;
            const path = typed.trim();
            // A typed path that differs from the open folder goes there first.
            if (target.tagName === 'INPUT' && path && path !== listing?.path) {
                go(path);
                return;
            }
            const row = rows[active];
            if (!row) return;
            // A repository opens; any other folder is entered.
            if (row.isRepo) onOpen(row.path);
            else go(row.path);
            return;
        }
        if (e.key === 'Backspace' && (e.target as HTMLElement).tagName !== 'INPUT' && listing?.parent) {
            e.preventDefault();
            go(listing.parent);
        }
    }

    return (
        <div className="overlay" onClick={onClose}>
            <div className="picker" role="dialog" aria-label="Open repository" onClick={e => e.stopPropagation()} onKeyDown={onKey}>
                <div className="picker-head">
                    <span>Open repository</span>
                    <Button size="icon"  onClick={onClose} aria-label="Close">×</Button>
                </div>

                <input
                    className="picker-input"
                    autoFocus
                    spellCheck={false}
                    placeholder="Type a folder path, then Enter"
                    value={typed}
                    onChange={e => setTyped(e.target.value)}
                />

                {recent.length > 0 && (
                    <div className="picker-section">
                        <div className="picker-label">Recent</div>
                        <ul>
                            {recent.map(path => (
                                <li key={path}>
                                    <button className="picker-recent" onClick={() => onOpen(path)} title={path}>
                                        <span className="name">{basename(path)}</span>
                                        <span className="picker-sub">{path}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                <div className="picker-toolbar">
                    <Button onClick={() => listing?.parent && go(listing.parent)} disabled={!listing?.parent}>
                        ↑ Up
                    </Button>
                    <span className="picker-here" title={listing?.path}>{listing?.path ?? ''}</span>
                    <Button onClick={() => listing && onOpen(listing.path)} disabled={!listing?.isRepo}>
                        {listing?.isRepo ? 'Open this repo' : 'Not a repo'}
                    </Button>
                </div>

                {(error || openError) && <div className="error" role="alert">{error || openError}</div>}

                <ul className="picker-list" role="listbox">
                    {rows.map((row, i) => (
                        <li
                            key={row.path}
                            ref={i === active ? activeRow : undefined}
                            role="option"
                            aria-selected={i === active}
                            className={i === active ? 'picker-item active' : 'picker-item'}
                            onMouseEnter={() => setActive(i)}
                            onDoubleClick={() => (row.isRepo ? onOpen(row.path) : go(row.path))}
                            onClick={() => setActive(i)}
                        >
                            <span className="picker-folder">{row.isRepo ? '⎇' : '▸'}</span>
                            <span className="name">{row.name}</span>
                            {row.isRepo && <span className="picker-badge">git</span>}
                        </li>
                    ))}
                    {listing && rows.length === 0 && <li className="none">No folders here</li>}
                </ul>

                <div className="picker-hint">↑↓ move · Enter open repo or enter folder · Backspace up · Esc close</div>
            </div>
        </div>
    );
}
