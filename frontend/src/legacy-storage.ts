// The Wails build kept its state in another origin's localStorage. On the first start of this build
// the backend reads it, and the items this build lacks are copied, before the app reads any of them.
import {LegacyStorage} from '../wailsjs/go/main/App';

const MIGRATED_KEY = 'git-tree-compare:migratedFromWails';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

// copyLegacy writes each item the store lacks, so nothing this build saved is overwritten.
export function copyLegacy(store: Store, items: Array<[string, string]>): void {
    for (const [key, value] of items) {
        if (store.getItem(key) === null) store.setItem(key, value);
    }
    store.setItem(MIGRATED_KEY, '1');
}

// migrateLegacyStorage copies the old state once. When the backend cannot read it, the next start tries again.
export async function migrateLegacyStorage(store: Store = localStorage): Promise<void> {
    if (store.getItem(MIGRATED_KEY) !== null) return;
    try {
        copyLegacy(store, await LegacyStorage());
    } catch {
        // The old state is a convenience; the app works without it.
    }
}
