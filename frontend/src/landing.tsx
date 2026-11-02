import type {ReactNode} from 'react';
import {Button} from './ui/button';
import {Kbd} from './ui/kbd';
import {OwlAsleep} from './mascots';
import {basename} from './util';

export interface LandingProps {
    last: string; // the repository open last time, if any
    recent: string[]; // newest first
    error?: string; // why the last open failed
    onOpen: (path: string) => void;
    onPick: () => void; // opens the in-app repository picker
    onShortcuts: () => void;
    banner?: ReactNode; // an update notice, shown above the heading
}

// Landing is the first screen: where to start, before any repository is open.
// The last repository leads the recent list, so continuing is one Enter away.
export function Landing({last, recent, error, onOpen, onPick, onShortcuts, banner}: LandingProps) {
    const repos = [...new Set([last, ...recent].filter(Boolean))].slice(0, 5);
    return (
        <div className="landing">
            <div className="landing-inner">
                {banner}
                <OwlAsleep/>
                <h1>Review pull requests file by file.</h1>
                <p className="landing-lede">Press X when a file is done. GitHub marks it viewed too.</p>

                {error && <div className="error" role="alert">{error}</div>}

                <div className="landing-row">
                    <Button variant="primary" onClick={onPick}>Open repository…</Button>
                    <Button onClick={onShortcuts}>Shortcuts <Kbd>?</Kbd></Button>
                </div>

                {repos.length > 0 && (
                    <section className="landing-recent">
                        <h2>Recent</h2>
                        <ul>
                            {repos.map(path => (
                                <li key={path}>
                                    <button className="landing-action" onClick={() => onOpen(path)}>
                                        <span className="landing-name">{basename(path)}</span>
                                        <span className="landing-sub">{path}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}

                <p className="landing-foot">From a terminal: <code>git-tree-compare [path]</code></p>
            </div>
        </div>
    );
}
