import {clsx, type ClassValue} from 'clsx';
import {twMerge} from 'tailwind-merge';

// cn joins class names, then resolves Tailwind conflicts so the last one wins
// (cn('px-2', props.className) lets a caller override px-2).
export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs));
}
