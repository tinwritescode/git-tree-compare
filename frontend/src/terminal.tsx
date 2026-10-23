import {useEffect, useRef} from 'react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {ResizeTerminal, StartTerminal, StopTerminal, WriteTerminal} from '../wailsjs/go/main/App';
import {EventsOn} from '../wailsjs/runtime/runtime';

// TerminalPanel runs the user's shell in the repository, in the bottom dock.
// The shell keeps running while the dock is hidden; a new repository starts a new shell.
export function TerminalPanel({repo, visible}: {repo: string; visible: boolean}) {
    const host = useRef<HTMLDivElement>(null);
    const term = useRef<Terminal | null>(null);
    const fit = useRef<FitAddon | null>(null);

    // Size the terminal to its box and tell the shell the new size.
    function resize() {
        const t = term.current;
        const f = fit.current;
        if (!t || !f || !host.current?.offsetWidth) return;
        f.fit();
        ResizeTerminal(t.cols, t.rows).catch(() => {});
    }

    useEffect(() => {
        const style = getComputedStyle(document.documentElement);
        const t = new Terminal({
            cursorBlink: true,
            fontFamily: style.getPropertyValue('--font-mono') || 'monospace',
            fontSize: 12,
            theme: {background: style.getPropertyValue('--bg').trim(), foreground: style.getPropertyValue('--text').trim()},
        });
        const f = new FitAddon();
        t.loadAddon(f);
        t.open(host.current!);
        term.current = t;
        fit.current = f;

        const offData = EventsOn('term:data', (b64: string) => {
            t.write(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
        });
        const offExit = EventsOn('term:exit', () => t.write('\r\n[shell exited. Press Ctrl+` to reopen the dock.]\r\n'));
        const input = t.onData(data => WriteTerminal(data).catch(() => {}));
        const observer = new ResizeObserver(resize);
        observer.observe(host.current!);

        return () => {
            observer.disconnect();
            input.dispose();
            offData();
            offExit();
            t.dispose();
            term.current = null;
            fit.current = null;
        };
    }, []);

    // A new repository gets a new shell in its folder.
    useEffect(() => {
        const t = term.current;
        if (!repo || !t) return;
        t.clear();
        fit.current?.fit();
        StartTerminal(repo, t.cols, t.rows).catch(e => t.write(`\r\n${e}\r\n`));
    }, [repo]);

    useEffect(() => () => {
        StopTerminal();
    }, []);

    useEffect(() => {
        if (visible) {
            resize();
            term.current?.focus();
        }
    }, [visible]);

    return <div className="terminal-host" ref={host}/>;
}
