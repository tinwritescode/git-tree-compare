// The parts of a desktop runtime the frontend uses, on Tauri: backend events, opening a link, and
// dragging the window by its toolbar.
import {listen, type UnlistenFn} from '@tauri-apps/api/event';
import {invoke} from '@tauri-apps/api/core';
import {getCurrentWindow} from '@tauri-apps/api/window';

// Listeners still registering. Tauri registers a listener asynchronously, so a command that answers
// through an event at once (a kept Claude answer) could fire before its listener exists.
const pending = new Set<Promise<void>>();

// listenersReady resolves once every listener asked for so far is live.
export async function listenersReady(): Promise<void> {
    await Promise.all(pending);
}

// EventsOn calls callback with each payload of the event name, until the returned function is called.
export function EventsOn(eventName: string, callback: (...data: any) => void): () => void {
    let off: UnlistenFn | undefined;
    let stopped = false;
    const ready: Promise<void> = listen(eventName, (e) => callback(e.payload))
        .then((unlisten) => {
            if (stopped) unlisten();
            else off = unlisten;
        })
        .finally(() => pending.delete(ready));
    pending.add(ready);
    return () => {
        stopped = true;
        off?.();
    };
}

// BrowserOpenURL opens an https page in the default browser.
export function BrowserOpenURL(url: string): void {
    void invoke('open_url', {url});
}

// enableWindowDrag lets the toolbar move the window, like the title bar it replaces: an element whose
// computed --window-drag is "drag" starts a drag. The property inherits, so a toolbar sets drag and
// its buttons set no-drag.
export function enableWindowDrag(): void {
    window.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || !(e.target instanceof Element)) return;
        if (getComputedStyle(e.target).getPropertyValue('--window-drag').trim() !== 'drag') return;
        e.preventDefault();
        void getCurrentWindow().startDragging();
    });
}
