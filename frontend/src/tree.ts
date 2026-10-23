import type {main} from '../wailsjs/go/models';

export type FileChange = main.FileChange;
export type SortMode = 'name' | 'size';

export interface TreeNode {
    name: string;
    path: string;
    file?: FileChange;
    children: TreeNode[];
    // Totals for the node: a file's own counts, or the sum under a folder.
    added: number;
    deleted: number;
    generated: boolean;
}

// Files a person rarely reviews by hand: lock files, snapshots, bundles, generated code.
const GENERATED = [
    /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock|composer\.lock)$/,
    /\.lock$/,
    /\.snap$/,
    /\.min\.(js|css)$/,
    /\.pb\.go$/,
    /(^|\/)(dist|build|vendor|node_modules|wailsjs)\//,
];

export function isGenerated(path: string): boolean {
    return GENERATED.some(re => re.test(path));
}

// buildTree turns flat changed-file paths into folders and files.
// Folders come first. Generated files come last. Other files follow the sort mode.
export function buildTree(changes: FileChange[], sort: SortMode = 'name'): TreeNode[] {
    const root: TreeNode = {name: '', path: '', children: [], added: 0, deleted: 0, generated: false};

    for (const change of changes) {
        const parts = change.path.split('/');
        let node = root;
        parts.forEach((part, i) => {
            const path = parts.slice(0, i + 1).join('/');
            let child = node.children.find(c => c.name === part);
            if (!child) {
                child = {name: part, path, children: [], added: 0, deleted: 0, generated: false};
                node.children.push(child);
            }
            if (i === parts.length - 1) {
                child.file = change;
                child.generated = isGenerated(change.path);
            }
            node = child;
        });
    }

    // Totals first, so sorting by size can use them.
    const total = (n: TreeNode) => {
        if (n.file) {
            n.added = n.file.added;
            n.deleted = n.file.deleted;
            return;
        }
        for (const c of n.children) {
            total(c);
            n.added += c.added;
            n.deleted += c.deleted;
        }
    };
    total(root);

    const compare = (a: TreeNode, b: TreeNode): number => {
        const aFile = a.file ? 1 : 0;
        const bFile = b.file ? 1 : 0;
        if (aFile !== bFile) return aFile - bFile;
        if (a.generated !== b.generated) return a.generated ? 1 : -1;
        if (sort === 'size') {
            const diff = (b.added + b.deleted) - (a.added + a.deleted);
            if (diff) return diff;
        }
        return a.name.localeCompare(b.name);
    };

    const order = (nodes: TreeNode[]): TreeNode[] =>
        nodes
            .map(n => ({...n, children: order(n.children)}))
            .sort(compare);

    return order(root.children);
}
