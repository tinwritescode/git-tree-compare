// Zooming the page with Cmd = / Cmd + / Cmd - / Cmd 0. Tauri's own zoomHotkeysEnabled also zooms on
// ctrl+wheel, which is how a trackpad pinch reaches the page: dozens of events a gesture, 20% each.
import {getCurrentWebview} from '@tauri-apps/api/webview';

const STEP = 0.2;
const MIN = 0.4;
const MAX = 3;

// zoomAfter returns the zoom a key leads to from zoom, or null for a key that does not zoom.
export function zoomAfter(key: string, zoom: number): number | null {
    const next = key === '=' || key === '+' ? zoom + STEP : key === '-' ? zoom - STEP : key === '0' ? 1 : null;
    if (next === null) return null;
    // Rounded so repeated steps land on 0.4, not 0.39999.
    return Math.min(MAX, Math.max(MIN, Math.round(next * 10) / 10));
}

// enableZoomKeys zooms the window's page on Cmd and those keys.
export function enableZoomKeys() {
    let zoom = 1;
    window.addEventListener('keydown', e => {
        if (!e.metaKey) return;
        const next = zoomAfter(e.key, zoom);
        if (next === null) return;
        e.preventDefault();
        zoom = next;
        getCurrentWebview().setZoom(zoom).catch(() => {});
    });
}
