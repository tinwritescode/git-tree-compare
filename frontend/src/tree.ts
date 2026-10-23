import type {main} from '../wailsjs/go/models';

export type FileChange = main.FileChange;

export interface TreeNode {
    name: string;
    path: string;
    file?: FileChange;
    children: TreeNode[];
}

// buildTree turns flat changed-file paths into folders and files.
// Folders come first, then files, both sorted by name.
export function buildTree(changes: FileChange[]): TreeNode[] {
    const root: TreeNode = {name: '', path: '', children: []};

    for (const change of changes) {
        const parts = change.path.split('/');
        let node = root;
        parts.forEach((part, i) => {
            const path = parts.slice(0, i + 1).join('/');
            let child = node.children.find(c => c.name === part);
            if (!child) {
                child = {name: part, path, children: []};
                node.children.push(child);
            }
            if (i === parts.length - 1) {
                child.file = change;
            }
            node = child;
        });
    }

    const sort = (nodes: TreeNode[]): TreeNode[] =>
        nodes
            .map(n => ({...n, children: sort(n.children)}))
            .sort((a, b) => {
                const aDir = a.file ? 1 : 0;
                const bDir = b.file ? 1 : 0;
                return aDir - bDir || a.name.localeCompare(b.name);
            });

    return sort(root.children);
}
