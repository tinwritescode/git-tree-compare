import {Fragment, type KeyboardEvent, useEffect, useMemo, useRef, useState} from 'react';
import {HomeDir, ListDir} from '../wailsjs/go/main/App';
import type {main} from '../wailsjs/go/models';
import {OwlSearch} from './mascots';
import {crumbs, pickerRows, type PickerRow, splitQuery} from './picker';
import {basename, folderOf} from './util';
import {Button} from './ui/button';
import {Kbd} from './ui/kbd';

export interface RepoPickerProps {
    start: string; // folder to open first, usually the current repo's parent
    recent: string[]; // repositories opened before, newest first
    openError?: string; // why the last open failed, shown until the next attempt
    onOpen: (path: string) => void; // the app resolves the path to its repository root
    onClose: () => void;
}

// Marked draws a name with the letters the filter matched picked out.
function Marked({text, marks}: {text: string; marks: number[]}) {
    if (!marks.length) return <>{text}</>;
    const hit = new Set(marks);
    return <>{text.split('').map((ch, i) => (hit.has(i) ? <mark key={i}>{ch}</mark> : ch))}</>;
}

// RepoPicker finds a repository from one box: words filter the open folder and the recent
// repositories, a path walks the disk. It runs inside the app, so opening needs no native dialog.
export function RepoPicker({start, recent, openError, onOpen, onClose}: RepoPickerProps) {
    const [listing, setListing] = useState<main.DirListing | null>(null);
    const [home, setHome] = useState('');
    const [typed, setTyped] = useState('');
    const [failure, setFailure] = useState(''); // why the folder asked for last could not be listed
    const [active, setActive] = useState(0);
    const activeRow = useRef<HTMLLIElement>(null);
    const wanted = useRef(''); // the folder asked for last; a slower answer for another one is dropped

    async function load(path: string) {
        wanted.current = path;
        try {
            const next = await ListDir(path);
            if (wanted.current !== path) return;
            setListing(next);
            setFailure('');
        } catch (e) {
            if (wanted.current === path) setFailure(String(e));
        }
        setActive(0);
    }

    // enter opens a folder to browse and clears the box, so the next letters filter that folder.
    function enter(path: string) {
        setTyped('');
        load(path);
    }

    useEffect(() => {
        HomeDir()
            .catch(() => '')
            .then(dir => {
                setHome(dir);
                load(start || dir || '/');
            });
    }, []);

    const {dir, filter} = splitQuery({typed, home});

    // A typed path lists its folder as soon as the folder part changes.
    useEffect(() => {
        if (dir !== null) load(dir);
    }, [dir]);

    useEffect(() => {
        activeRow.current?.scrollIntoView({block: 'nearest'});
    }, [active]);

    // A folder that failed to list hides the rows only while its path is still in the box.
    const broken = failure !== '' && (dir !== null || !listing);
    const rows = useMemo(
        () => (broken ? [] : pickerRows({filter, here: listing, entries: listing?.entries ?? [], recent: dir === null ? recent : []})),
        [broken, filter, listing, dir, recent],
    );
    const here = listing ? basename(listing.path) || '/' : '';
    const trail = listing ? crumbs({path: listing.path, home}) : [];

    function pick(row: PickerRow) {
        if (row.isRepo) onOpen(row.path);
        else enter(row.path);
    }

    function onKey(e: KeyboardEvent) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!rows.length) return;
            setActive(i => (e.key === 'ArrowDown' ? Math.min(i + 1, rows.length - 1) : Math.max(i - 1, 0)));
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            const row = rows[active];
            if (row) pick(row);
            return;
        }
        if (e.key === 'Backspace' && typed === '' && listing?.parent) {
            e.preventDefault();
            enter(listing.parent);
        }
    }

    function title(kind: PickerRow['kind']): string {
        switch (kind) {
            case 'here':
                return 'This folder';
            case 'recent':
                return 'Recent';
            case 'folder':
                return `In ${here}`;
        }
    }

    return (
        <div className="overlay" onClick={onClose}>
            <div
                className="picker"
                role="dialog"
                aria-label="Open repository"
                onClick={e => e.stopPropagation()}
                onKeyDown={e => e.key === 'Escape' && onClose()}
            >
                <div className="picker-head">
                    <h2>Open repository</h2>
                    <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">×</Button>
                </div>

                <input
                    className="picker-input"
                    role="combobox"
                    aria-label="Search folders, or type a path"
                    aria-expanded="true"
                    aria-controls="picker-list"
                    aria-activedescendant={rows[active] ? `picker-row-${active}` : undefined}
                    autoFocus
                    spellCheck={false}
                    placeholder="Search folders, or type a path"
                    value={typed}
                    onChange={e => {
                        setTyped(e.target.value);
                        setActive(0);
                    }}
                    onKeyDown={onKey}
                />

                <nav className="picker-crumbs" aria-label="Open folder">
                    {trail.map((crumb, i) => (
                        <Fragment key={crumb.path}>
                            {i > 0 && trail[i - 1].name !== '/' && <span aria-hidden="true">/</span>}
                            <button type="button" aria-current={i === trail.length - 1 ? 'location' : undefined} onClick={() => enter(crumb.path)} title={crumb.path}>
                                {crumb.name}
                            </button>
                        </Fragment>
                    ))}
                </nav>

                {(broken || openError) && <div className="error" role="alert">{broken ? failure : openError}</div>}

                <ul className="picker-list" id="picker-list" role="listbox" aria-label="Folders">
                    {rows.map((row, i) => (
                        <Fragment key={`${row.kind} ${row.path}`}>
                            {!filter && row.kind !== rows[i - 1]?.kind && <li className="picker-label" role="presentation">{title(row.kind)}</li>}
                            <li
                                id={`picker-row-${i}`}
                                ref={i === active ? activeRow : undefined}
                                role="option"
                                aria-selected={i === active}
                                className={`picker-item${i === active ? ' active' : ''}${row.isRepo ? ' is-repo' : ''}`}
                                onMouseMove={() => i !== active && setActive(i)}
                                onClick={() => pick(row)}
                                title={row.path}
                            >
                                <span className="picker-folder" aria-hidden="true">{row.isRepo ? '⎇' : '▸'}</span>
                                <span className="name"><Marked text={row.name} marks={row.marks}/></span>
                                {row.kind === 'recent' && <span className="picker-sub">{home && row.path.startsWith(`${home}/`) ? `~${folderOf(row.path).slice(home.length)}` : folderOf(row.path)}</span>}
                                {i === active && <span className="picker-do"><Kbd>↵</Kbd>{row.isRepo ? 'Open' : 'Look inside'}</span>}
                            </li>
                        </Fragment>
                    ))}
                    {listing && !broken && rows.length === 0 && (
                        filter
                            ? <li className="none mascot-state"><OwlSearch/>Nothing in {here} matches “{filter}”.</li>
                            : <li className="none">No folders in {here}.</li>
                    )}
                </ul>

                <div className="picker-hint">
                    <span><Kbd>↑</Kbd><Kbd>↓</Kbd>move</span>
                    <span><Kbd>/</Kbd><Kbd>~</Kbd>type a path</span>
                    <span><Kbd>⌫</Kbd>up a folder</span>
                    <span><Kbd>esc</Kbd>close</span>
                </div>
            </div>
        </div>
    );
}
