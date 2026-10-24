import type {SelectHTMLAttributes} from 'react';
import {cn} from '../lib/utils';
import {base, sizes, variants} from './button';

// Select is the shared look for a dropdown. It takes the Button default look, so a Select and a Button line up in a row.
export function Select({className, ...props}: SelectHTMLAttributes<HTMLSelectElement>) {
    return (
        <select
            className={cn(
                base,
                variants.default,
                sizes.md,
                'max-w-[260px] cursor-pointer pr-1.5 pl-2',
                className,
            )}
            {...props}
        />
    );
}
