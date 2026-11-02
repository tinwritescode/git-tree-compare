import type {ButtonHTMLAttributes} from 'react';
import {cn} from '../lib/utils';

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'link';
export type ButtonSize = 'md' | 'icon';

// HeroUI's button classes on a native button, so callers keep onClick, title and disabled as they are.
// Console squares HeroUI's pill to the control radius.
const base = 'button rounded-[var(--radius)] text-[14px] font-medium';

const variants: Record<ButtonVariant, string> = {
    // A hairline outline on the panel colour: most actions.
    default: 'button--outline border-[var(--btn-border)] bg-[var(--btn-bg)]',
    // The main action of a view. Its key chips take the accent's ink so they stay readable.
    primary: 'button--primary [&_kbd]:bg-transparent [&_kbd]:[color:inherit]',
    // Sits on a tinted strip, such as the error bar, and shows only on hover.
    ghost: 'button--ghost',
    // Plain text that acts like a button, such as "Open on GitHub".
    link: 'button--ghost h-auto px-0.5 py-0 underline decoration-[var(--btn-border)] underline-offset-4 [color:var(--accent-text)]',
};

const sizes: Record<ButtonSize, string> = {
    md: 'button--sm',
    icon: 'button--sm button--icon-only',
};

// Button is the shared look for every action. className wins over the variant and size.
export function Button({variant = 'default', size = 'md', className, ...props}: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
}) {
    return <button className={cn(base, variants[variant], variant === 'link' ? undefined : sizes[size], className)} {...props}/>;
}
