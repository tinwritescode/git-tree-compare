import {useEffect, useRef, useState} from 'react';
import type {main} from '../wailsjs/go/models';
import {Button} from './ui/button';

// EditorMenu opens the file in the current editor. The arrow lists the other installed editors,
// and picking one opens the file in it and makes it the current one.
export function EditorMenu({editors, current, disabled, onOpen}: {
    editors: main.Editor[];
    current: string;
    disabled: boolean;
    onOpen: (id: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const target = editors.find(e => e.id === current) ?? editors[0];

    useEffect(() => {
        if (!open) return;
        function onPointer(e: MouseEvent) {
            if (!root.current?.contains(e.target as Node)) setOpen(false);
        }
        window.addEventListener('mousedown', onPointer);
        return () => window.removeEventListener('mousedown', onPointer);
    }, [open]);

    if (!target) {
        return <Button disabled title="No supported editor is installed. Zed, VS Code, Cursor or Sublime Text.">Open in editor</Button>;
    }

    return (
        <div ref={root} className="relative inline-flex">
            <Button disabled={disabled} onClick={() => onOpen(target.id)} title={`Open in ${target.name} (o)`}>
                Open in {target.name}
            </Button>
            <Button
                size="icon"
                className="-ml-px rounded-l-none"
                disabled={disabled}
                onClick={() => setOpen(v => !v)}
                aria-label="Choose editor"
                aria-haspopup="menu"
                aria-expanded={open}
            >
                ▾
            </Button>
            {open && (
                <div
                    role="menu"
                    className="absolute right-0 top-full z-10 mt-1 min-w-[170px] rounded-md border border-[var(--border)] bg-[var(--btn-bg)] p-1 shadow-lg"
                >
                    {editors.map(e => (
                        <button
                            key={e.id}
                            role="menuitem"
                            className="block w-full cursor-pointer rounded px-2.5 py-1.5 text-left text-[13px] hover:bg-[var(--bg-hover)] aria-[current=true]:font-medium"
                            aria-current={e.id === target.id}
                            onClick={() => {
                                setOpen(false);
                                onOpen(e.id);
                            }}
                        >
                            {e.name}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
