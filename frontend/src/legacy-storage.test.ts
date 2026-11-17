import {describe, expect, it} from 'vitest';
import {copyLegacy} from './legacy-storage';

function memoryStore(init: Record<string, string> = {}) {
    const items = new Map(Object.entries(init));
    return {
        items,
        getItem: (k: string) => items.get(k) ?? null,
        setItem: (k: string, v: string) => void items.set(k, v),
    };
}

describe('copyLegacy', () => {
    it('copies what the store lacks, keeps what it has, and marks the copy done', () => {
        const store = memoryStore({'git-tree-compare:recent': '["/new"]'});
        copyLegacy(store, [
            ['git-tree-compare:recent', '["/old"]'],
            ['git-tree-compare:review:/r#1', '{"viewed":["a.go"]}'],
        ]);
        expect(Object.fromEntries(store.items)).toEqual({
            'git-tree-compare:recent': '["/new"]',
            'git-tree-compare:review:/r#1': '{"viewed":["a.go"]}',
            'git-tree-compare:migratedFromWails': '1',
        });
    });
});
