import {useEffect, useMemo, useState} from 'react';
import './App.css';
import {Changes, Diff, PickRepo, Refs} from '../wailsjs/go/main/App';
import {buildTree, FileChange, TreeNode} from './tree';

const PREFERRED_BASES = ['main', 'staging', 'master'];

function App() {
    const [repo, setRepo] = useState('');
    const [refs, setRefs] = useState<string[]>([]);
    const [base, setBase] = useState('');
    const [changes, setChanges] = useState<FileChange[]>([]);
    const [selected, setSelected] = useState<FileChange | null>(null);
    const [diff, setDiff] = useState('');
    const [error, setError] = useState('');

    const tree = useMemo(() => buildTree(changes), [changes]);

    async function chooseRepo() {
        const path = await PickRepo();
        if (path) {
            setRepo(path);
        }
    }

    // Load branches and tags whenever the repo changes.
    useEffect(() => {
        if (!repo) return;
        Refs(repo)
            .then(list => {
                setRefs(list);
                setBase(PREFERRED_BASES.find(b => list.includes(b)) ?? list[0] ?? '');
            })
            .catch(e => setError(String(e)));
    }, [repo]);

    // Reload the changed files whenever the repo or base changes.
    useEffect(() => {
        if (!repo || !base) return;
        setSelected(null);
        setDiff('');
        Changes(repo, base)
            .then(list => {
                setChanges(list);
                setError('');
            })
            .catch(e => setError(String(e)));
    }, [repo, base]);

    useEffect(() => {
        if (!selected) return;
        Diff(repo, base, selected.path)
            .then(setDiff)
            .catch(e => setError(String(e)));
    }, [selected, repo, base]);

    return (
        <div id="app">
            <header className="toolbar">
                <button onClick={chooseRepo}>Open repo</button>
                <span className="repo-path">{repo || 'No repository selected'}</span>
                <label>
                    Compare against
                    <select value={base} onChange={e => setBase(e.target.value)} disabled={!refs.length}>
                        {refs.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                </label>
            </header>

            {error && <div className="error">{error}</div>}

            <div className="panes">
                <aside className="tree">
                    {tree.length === 0 && <div className="empty">No changes</div>}
                    <TreeList nodes={tree} selectedPath={selected?.path} onSelect={setSelected}/>
                </aside>
                <main className="diff">
                    {selected
                        ? <DiffView text={diff}/>
                        : <div className="empty">Select a file to see its diff</div>}
                </main>
            </div>
        </div>
    );
}

function TreeList({nodes, selectedPath, onSelect, depth = 0}: {
    nodes: TreeNode[];
    selectedPath?: string;
    onSelect: (file: FileChange) => void;
    depth?: number;
}) {
    return (
        <ul className="tree-list">
            {nodes.map(node => <TreeItem key={node.path} node={node} selectedPath={selectedPath} onSelect={onSelect} depth={depth}/>)}
        </ul>
    );
}

function TreeItem({node, selectedPath, onSelect, depth}: {
    node: TreeNode;
    selectedPath?: string;
    onSelect: (file: FileChange) => void;
    depth: number;
}) {
    const [open, setOpen] = useState(true);
    const indent = {paddingLeft: 8 + depth * 14};

    if (node.file) {
        const active = node.file.path === selectedPath;
        return (
            <li>
                <div className={`row file ${active ? 'active' : ''}`} style={indent} onClick={() => onSelect(node.file!)}>
                    <span className={`status status-${node.file.status}`}>{node.file.status}</span>
                    <span className="name" title={node.path}>{node.name}</span>
                </div>
            </li>
        );
    }

    return (
        <li>
            <div className="row folder" style={indent} onClick={() => setOpen(!open)}>
                <span className="caret">{open ? '▾' : '▸'}</span>
                <span className="name">{node.name}</span>
            </div>
            {open && <TreeList nodes={node.children} selectedPath={selectedPath} onSelect={onSelect} depth={depth + 1}/>}
        </li>
    );
}

function DiffView({text}: {text: string}) {
    // Drop git's file header; the hunks start at the first "@@".
    const lines = text.split('\n');
    const start = lines.findIndex(l => l.startsWith('@@'));
    const body = start === -1 ? lines : lines.slice(start);

    return (
        <pre className="diff-body">
            {body.map((line, i) => {
                let kind = 'ctx';
                if (line.startsWith('@@')) kind = 'hunk';
                else if (line.startsWith('+')) kind = 'add';
                else if (line.startsWith('-')) kind = 'del';
                return <div key={i} className={`line ${kind}`}>{line || ' '}</div>;
            })}
        </pre>
    );
}

export default App;
