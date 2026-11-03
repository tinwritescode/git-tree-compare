import {useEffect, useMemo, useState} from 'react';
import type {main} from '../wailsjs/go/models';
import {ListRefs, ReviewBranch, ReviewCommit} from '../wailsjs/go/main/App';
import {Picker, type PickerItem} from './panels';

export type RefMode = 'commit' | 'branch';

const typedRef = (query: string): PickerItem => ({id: query, label: `Use “${query}”`});

// RefPicker chooses a commit, or a branch and the base it goes into, and reports the review.
// A typed ref that the lists do not hold, such as HEAD~2, is used as it is.
export function RefPicker({repo, mode, onOpen, onError, onClose}: {
    repo: string;
    mode: RefMode;
    onOpen: (review: main.LocalReview) => void;
    onError: (message: string) => void;
    onClose: () => void;
}) {
    const [refs, setRefs] = useState<main.RefList | null>(null);
    const [branch, setBranch] = useState(''); // the branch picked, while its base is chosen

    useEffect(() => {
        ListRefs(repo).then(setRefs).catch(e => onError(String(e)));
    }, [repo]);

    const commits = useMemo(() => (refs?.commits ?? []).map(c => ({
        id: c.hash,
        label: `${c.subject} · ${c.author}, ${c.when}`,
        leading: <span className="ref-sha">{c.short}</span>,
    })), [refs]);
    // Branches. When the base is being chosen, the default branch comes first and the picked
    // branch is left out.
    const branches = useMemo(() => {
        const names = (refs?.branches ?? []).filter(n => n !== branch);
        const first = branch && refs?.defaultBase ? [refs.defaultBase] : [];
        return [...first, ...names.filter(n => !first.includes(n))].map(n => ({
            id: n,
            label: n,
            hint: n === refs?.defaultBase ? 'default' : undefined,
        }));
    }, [refs, branch]);

    function open(found: Promise<main.LocalReview>) {
        onClose();
        found.then(onOpen).catch(e => onError(String(e)));
    }

    if (mode === 'commit') {
        return (
            <Picker
                placeholder="Review a commit…"
                empty={refs ? 'No matching commit' : 'Loading commits…'}
                items={commits}
                typed={typedRef}
                onPick={rev => open(ReviewCommit(repo, rev))}
                onClose={onClose}
            />
        );
    }
    if (!branch) {
        return (
            <Picker
                placeholder="Review a branch…"
                empty={refs ? 'No matching branch' : 'Loading branches…'}
                items={branches}
                typed={typedRef}
                onPick={setBranch}
                onClose={onClose}
            />
        );
    }
    return (
        <Picker
            key="base"
            placeholder={`Compare ${branch} with…`}
            empty="No matching branch"
            items={branches}
            typed={typedRef}
            onPick={base => open(ReviewBranch(repo, branch, base))}
            onClose={onClose}
        />
    );
}
