import {describe, expect, it} from 'vitest';
import type {main} from '../wailsjs/go/models';
import {inboxGroups, type InboxRow, rowKey} from './inbox';

const pr = (number: number, group: string, title = `PR ${number}`): main.PRInfo => ({
    id: `id${number}`, number, title, url: '', author: 'ana', headRefName: `b${number}`, headRefOid: '', baseRefName: 'main',
    isDraft: false, additions: 1, deletions: 1, changedFiles: 1, updatedAt: '', reviewDecision: '', mergeable: '', group,
});
const commit = (short: string, subject: string): main.CommitRef => ({hash: `${short}000`, short, subject, author: 'bo', when: '1 hour ago'});
const local = {
    branch: {name: 'feat/limit', base: 'main', ahead: 3},
    commits: [commit('a1', 'Fix the parser'), commit('b2', 'Add rate limit')],
};
const keys = (groups: {id: string; rows: InboxRow[]}[]) => groups.map(g => [g.id, g.rows.map(rowKey)]);

describe('inboxGroups', () => {
    it('lists local work after your pull requests, branch first', () => {
        const prs = [pr(3, 'other'), pr(1, 'requested'), pr(2, 'mine')];
        expect(keys(inboxGroups({prs, local, query: ''}))).toEqual([
            ['requested', ['pr:1']],
            ['mine', ['pr:2']],
            ['local', ['branch:feat/limit', 'commit:a1000', 'commit:b2000']],
            ['other', ['pr:3']],
        ]);
    });

    it('shows local work when there are no pull requests', () => {
        expect(keys(inboxGroups({prs: [], local: {commits: [commit('a1', 'Fix')]}, query: ''}))).toEqual([
            ['local', ['commit:a1000']],
        ]);
    });

    it('filters local rows with the same query as pull requests', () => {
        const prs = [pr(1, 'requested', 'Rate limit the API')];
        expect(keys(inboxGroups({prs, local, query: 'LIMIT'}))).toEqual([
            ['requested', ['pr:1']],
            ['local', ['branch:feat/limit', 'commit:b2000']],
        ]);
        expect(keys(inboxGroups({prs, local, query: 'a1'}))).toEqual([['local', ['commit:a1000']]]);
    });

    it('has no local group before local work is read', () => {
        expect(keys(inboxGroups({prs: [pr(1, 'mine')], local: null, query: ''}))).toEqual([['mine', ['pr:1']]]);
    });
});
