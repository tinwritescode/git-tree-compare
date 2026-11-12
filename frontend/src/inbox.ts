// The inbox: open pull requests and local work (the checked-out branch, recent commits) as one
// list, so a commit or branch review starts from the same place as a pull request.
import type {main} from '../wailsjs/go/models';

export type LocalWork = Pick<main.LocalSubjects, 'branch' | 'commits'>;

export type InboxRow =
    | {kind: 'pr'; pr: main.PRInfo}
    | {kind: 'branch'; branch: main.LocalBranch}
    | {kind: 'commit'; commit: main.CommitRef};

export type InboxGroup = {id: string; title: string; rows: InboxRow[]};

const GROUPS: {id: string; title: string}[] = [
    {id: 'requested', title: 'Waiting for your review'},
    {id: 'mine', title: 'Your pull requests'},
    {id: 'local', title: 'Local'},
    {id: 'other', title: 'Other open pull requests'},
];

export function rowKey(row: InboxRow): string {
    switch (row.kind) {
        case 'pr':
            return `pr:${row.pr.number}`;
        case 'branch':
            return `branch:${row.branch.name}`;
        case 'commit':
            return `commit:${row.commit.hash}`;
        default: {
            const _exhaustive: never = row;
            return _exhaustive;
        }
    }
}

// The text a filter query is matched against.
function rowText(row: InboxRow): string {
    switch (row.kind) {
        case 'pr':
            return `${row.pr.number} ${row.pr.title} ${row.pr.author} ${row.pr.headRefName}`;
        case 'branch':
            return `${row.branch.name} ${row.branch.base}`;
        case 'commit':
            return `${row.commit.short} ${row.commit.subject} ${row.commit.author}`;
        default: {
            const _exhaustive: never = row;
            return _exhaustive;
        }
    }
}

const groupOf = (row: InboxRow) => (row.kind === 'pr' ? row.pr.group : 'local');

// inboxGroups lists the rows matching query, grouped: what asks for you first, then your own work.
// local is null until it has been read. Empty groups are left out.
export function inboxGroups({prs, local, query}: {prs: main.PRInfo[]; local: LocalWork | null; query: string}): InboxGroup[] {
    const q = query.trim().toLowerCase();
    const rows: InboxRow[] = [
        ...prs.map(pr => ({kind: 'pr', pr}) satisfies InboxRow),
        ...(local?.branch ? [{kind: 'branch', branch: local.branch} satisfies InboxRow] : []),
        ...(local?.commits ?? []).map(commit => ({kind: 'commit', commit}) satisfies InboxRow),
    ];
    const found = q ? rows.filter(r => rowText(r).toLowerCase().includes(q)) : rows;
    return GROUPS.map(g => ({...g, rows: found.filter(r => groupOf(r) === g.id)})).filter(g => g.rows.length);
}

// nextUp is the row the inbox leads with: the first pull request waiting for this reviewer.
export function nextUp(groups: InboxGroup[]): InboxRow | null {
    return groups.find(g => g.id === 'requested')?.rows[0] ?? null;
}
