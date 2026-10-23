import type {ReactNode} from 'react';
import logo from './assets/logo.svg';
import {basename} from './util';

export interface LandingProps {
    last: string; // the repository open last time, if any
    recent: string[]; // newest first
    error?: string; // why the last open failed
    onOpen: (path: string) => void;
    onPick: () => void; // opens the in-app repository picker
    onShortcuts: () => void;
    banner?: ReactNode; // an update notice, shown above the logo
}

// Landing is the first screen: where to start, before any repository is open.
export function Landing({last, recent, error, onOpen, onPick, onShortcuts, banner}: LandingProps) {
    return (
        <div className="landing">
            <div className="landing-inner">
                {banner}
                <img className="landing-logo" src={logo} alt=""/>
                <h1>git-tree-compare</h1>
                <p className="landing-lede">See what a branch changes, file by file, against the branch it merges into.</p>

                {error && <div className="error" role="alert">{error}</div>}

                <ul className="landing-actions">
                    <li>
                        <button className="landing-action primary" onClick={onPick}>
                            <span>Open repository…</span>
                            <span className="landing-sub">Browse folders, or pick a recent one</span>
                        </button>
                    </li>
                    {last && (
                        <li>
                            <button className="landing-action" onClick={() => onOpen(last)}>
                                <span>Continue with {basename(last)}</span>
                                <span className="landing-sub">{last}</span>
                            </button>
                        </li>
                    )}
                </ul>

                {recent.length > 0 && (
                    <section>
                        <h2>Recent</h2>
                        <ul className="landing-actions">
                            {recent.slice(0, 5).map(path => (
                                <li key={path}>
                                    <button className="landing-action" onClick={() => onOpen(path)}>
                                        <span>{basename(path)}</span>
                                        <span className="landing-sub">{path}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}

                <footer className="landing-foot">
                    <button className="landing-link" onClick={onShortcuts}>Keyboard shortcuts (?)</button>
                    <span>From a terminal: <code>git-tree-compare [path] [--base REF]</code></span>
                </footer>
            </div>
        </div>
    );
}
