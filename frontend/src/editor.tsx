import {type KeyboardEvent, useEffect, useState} from 'react';
import {ReadFile, WriteFile} from '../wailsjs/go/main/App';
import {Button} from './ui/button';
import {Kbd} from './ui/kbd';

// EditorPanel edits one file of the working tree. Save writes it to disk, and the
// comparison reloads on its own. Close asks before dropping unsaved text.
export function EditorPanel({repo, path, onSaved, onClose}: {
    repo: string;
    path: string;
    onSaved: () => void;
    onClose: () => void;
}) {
    const [saved, setSaved] = useState('');
    const [text, setText] = useState('');
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [confirming, setConfirming] = useState(false);
    const dirty = loaded && text !== saved;

    useEffect(() => {
        let cancelled = false;
        setLoaded(false);
        setError('');
        setConfirming(false);
        ReadFile(repo, path)
            .then(content => {
                if (cancelled) return;
                setSaved(content);
                setText(content);
                setLoaded(true);
            })
            .catch(e => !cancelled && setError(String(e)));
        return () => {
            cancelled = true;
        };
    }, [repo, path]);

    async function save() {
        if (!dirty || busy) return;
        setBusy(true);
        setError('');
        try {
            await WriteFile(repo, path, text);
            setSaved(text);
            onSaved();
        } catch (e) {
            setError(String(e));
        } finally {
            setBusy(false);
        }
    }

    function close() {
        if (dirty) setConfirming(true);
        else onClose();
    }

    function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            save();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
        }
    }

    return (
        <section className="editor" aria-label={`Edit ${path}`}>
            <div className="editor-bar">
                <span className="editor-path" title={path}>{path}</span>
                {dirty && <span className="editor-dirty">Unsaved</span>}
                <span className="spacer"/>
                {confirming ? (
                    <>
                        <span>Discard unsaved changes?</span>
                        <Button onClick={onClose}>Discard</Button>
                        <Button onClick={() => setConfirming(false)}>Keep editing</Button>
                    </>
                ) : (
                    <>
                        <Button variant="primary" onClick={save} disabled={!dirty || busy} title="Save (⌘S)">
                            {busy ? 'Saving…' : 'Save'} <Kbd>⌘S</Kbd>
                        </Button>
                        <Button onClick={close} title="Close (Esc)">
                            Close <Kbd>Esc</Kbd>
                        </Button>
                    </>
                )}
            </div>
            {error && <div className="editor-error" role="alert">{error}</div>}
            <textarea
                className="editor-text"
                aria-label={`Contents of ${path}`}
                value={text}
                disabled={!loaded}
                spellCheck={false}
                autoFocus
                onChange={e => setText(e.target.value)}
                onKeyDown={onKey}
            />
        </section>
    );
}
