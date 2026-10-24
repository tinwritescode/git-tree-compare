import type {ButtonHTMLAttributes} from 'react';
import {cn} from '../lib/utils';

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'link';
export type ButtonSize = 'md' | 'icon';

export const base =
    'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border text-[12.5px] font-normal leading-none [font-family:var(--font-ui)] [color:inherit] cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-default disabled:opacity-40';

export const variants: Record<ButtonVariant, string> = {
    // Quiet by default: a hairline border and a faint lift. The border turns accent on hover.
    default: 'border-[var(--border)] bg-[var(--btn-bg)] shadow-[0_1px_1px_rgba(0,0,0,0.04)] enabled:hover:border-[var(--btn-border)] enabled:hover:bg-[var(--bg-hover)]',
    // The main action of a view. Its key chips invert so they stay readable on the accent.
    primary: 'border-[var(--accent)] bg-[var(--accent)] font-medium shadow-none [color:var(--bg)] enabled:hover:brightness-110 [&_kbd]:border-transparent [&_kbd]:bg-white/20 [&_kbd]:[color:inherit]',
    // Sits on a tinted strip, such as the error bar, and shows its edge only on hover.
    ghost: 'border-transparent bg-transparent enabled:hover:border-[var(--btn-border)] enabled:hover:bg-[var(--bg-hover)]',
    // Plain text that acts like a button, such as "Open on GitHub".
    link: 'border-0 bg-transparent px-0.5 py-0 [color:var(--accent)]',
};

export const sizes: Record<ButtonSize, string> = {
    md: 'h-7 px-2.5',
    icon: 'h-7 w-7 justify-center px-0 text-[15px] leading-none',
};

// Button is the shared look for every action. className wins over the variant and size.
export function Button({variant = 'default', size = 'md', className, ...props}: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
}) {
    return <button className={cn(base, variants[variant], sizes[size], className)} {...props}/>;
}
