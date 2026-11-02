import type {HTMLAttributes} from 'react';
import {cn} from '../lib/utils';

// Kbd shows a shortcut key inside a button or a hint, in HeroUI's key style and the measured face.
export function Kbd({className, ...props}: HTMLAttributes<HTMLElement>) {
    return <kbd className={cn('kbd h-5 rounded-[4px] px-1.5 font-[family-name:var(--font-mono)] text-xs', className)} {...props}/>;
}
