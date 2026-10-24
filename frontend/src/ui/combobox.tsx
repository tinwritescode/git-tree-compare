import {type KeyboardEvent, useEffect, useMemo, useRef, useState} from 'react';
import {cn} from '../lib/utils';
import {fuzzyScore} from '../util';
import {Button} from './button';

export type ComboOption = {value: string; label: string};

// Combobox is a dropdown with a search box. Typing narrows the options by fuzzy match.
export function Combobox({value, options, onChange, disabled, title, ariaLabel, align = 'left', className}: {
    value: string;
    options: ComboOption[];
    onChange: (value: string) => void;
    disabled?: boolean;
    title?: string;
    ariaLabel: string;
    align?: 'left' | 'right';
    className?: string;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [index, setIndex] = useState(0);
    const root = useRef<HTMLDivElement>(null);
    const current = options.find(o => o.value === value);

    const matches = useMemo(() => {
        return options
            .map(o => ({o, score: fuzzyScore(query, o.label)}))
            .filter(m => m.score >= 0)
            .sort((a, b) => a.score - b.score)
            .map(m => m.o);
    }, [options, query]);

    useEffect(() => {
        if (!open) return;
        function onDown(e: MouseEvent) {
            if (!root.current?.contains(e.target as Node)) close();
        }
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [open]);

    function openList() {
        setQuery('');
        setIndex(Math.max(0, options.findIndex(o => o.value === value)));
        setOpen(true);
    }

    function close() {
        setOpen(false);
        setQuery('');
    }

    function pick(o: ComboOption) {
        onChange(o.value);
        close();
    }

    function onKey(e: KeyboardEvent<HTMLInputElement>) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            close();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setIndex(i => Math.min(i + 1, matches.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setIndex(i => Math.max(i - 1, 0));
        } else if (e.key === 'Enter' && matches[index]) {
            e.preventDefault();
            pick(matches[index]);
        }
    }

    return (
        <div ref={root} className={cn('relative shrink-0', className)}>
            <Button
                className="max-w-[260px] min-w-0"
                onClick={() => (open ? close() : openList())}
                disabled={disabled}
                title={title}
                aria-label={ariaLabel}
                aria-haspopup="listbox"
                aria-expanded={open}
            >
                <span className="truncate">{current?.label ?? value}</span>
                <span aria-hidden className="text-[10px] text-[var(--text-dim)]">▾</span>
            </Button>
            {open && (
                <div
                    className={cn(
                        'absolute top-full z-20 mt-1 flex w-[340px] max-w-[90vw] flex-col overflow-hidden rounded-lg border border-[var(--btn-border)] bg-[var(--bg-alt)] shadow-lg [--wails-draggable:no-drag]',
                        align === 'right' ? 'right-0' : 'left-0',
                    )}
                >
                    <input
                        autoFocus
                        aria-label={`Search ${ariaLabel}`}
                        placeholder="Search…"
                        value={query}
                        onChange={e => {
                            setQuery(e.target.value);
                            setIndex(0);
                        }}
                        onKeyDown={onKey}
                        className="m-2 rounded-md border border-[var(--btn-border)] bg-[var(--btn-bg)] px-2.5 py-1 text-[13px] [color:inherit] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
                    />
                    <ul role="listbox" className="max-h-[50vh] overflow-auto px-1 pb-1">
                        {matches.map((o, i) => (
                            <li
                                key={o.value}
                                role="option"
                                aria-selected={o.value === value}
                                onMouseEnter={() => setIndex(i)}
                                onClick={() => pick(o)}
                                className={cn(
                                    'flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1 font-mono text-[12px]',
                                    i === index && 'bg-[var(--bg-active)] shadow-[inset_2px_0_0_var(--accent)]',
                                )}
                            >
                                <span className="truncate">{o.label}</span>
                                {o.value === value && <span aria-hidden className="text-[var(--accent)]">✓</span>}
                            </li>
                        ))}
                        {matches.length === 0 && <li className="px-2 py-1 text-[12px] text-[var(--text-dim)] opacity-70">No match</li>}
                    </ul>
                </div>
            )}
        </div>
    );
}
