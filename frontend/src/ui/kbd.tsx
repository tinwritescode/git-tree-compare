import type {HTMLAttributes} from 'react';
import {cn} from '../lib/utils';

// Kbd shows a shortcut key inside a button or a hint.
export function Kbd({className, ...props}: HTMLAttributes<HTMLElement>) {
    return (
        <kbd
            className={cn(
                'rounded border border-[var(--border)] bg-[var(--bg-alt)] px-1.5 py-0.5 font-mono text-[11px] leading-none text-[var(--text-dim)]',
                className,
            )}
            {...props}
        />
    );
}
