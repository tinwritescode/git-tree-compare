import {describe, expect, it} from 'vitest';
import {crumbs, pickerRows, splitQuery} from './picker';

const HOME = '/Users/me';

describe('splitQuery', () => {
    it('reads plain words as a filter over the open folder', () => {
        expect(splitQuery({typed: ' metrics pull ', home: HOME})).toEqual({dir: null, filter: 'metrics pull'});
    });

    it('reads a path as the folder to list and the part being typed', () => {
        expect(splitQuery({typed: '/Users/me/Coding/air', home: HOME})).toEqual({dir: '/Users/me/Coding', filter: 'air'});
        expect(splitQuery({typed: '/Us', home: HOME})).toEqual({dir: '/', filter: 'Us'});
    });

    it('reads ~ as the home folder', () => {
        expect(splitQuery({typed: '~/Co', home: HOME})).toEqual({dir: HOME, filter: 'Co'});
        expect(splitQuery({typed: '~', home: HOME})).toEqual({dir: HOME, filter: ''});
    });
});

const entries = [
    {name: 'agent-api-demo', path: '/c/agent-api-demo', isRepo: false},
    {name: 'air-metrics-api', path: '/c/air-metrics-api', isRepo: true},
    {name: 'air-metrics-api.feat-mai-pull', path: '/c/air-metrics-api.feat-mai-pull', isRepo: true},
    {name: 'air-money-api', path: '/c/air-money-api', isRepo: true},
];

describe('pickerRows', () => {
    it('lists the open repository, then recent ones, then the other folders', () => {
        const rows = pickerRows({filter: '', here: {path: '/c', isRepo: true}, entries, recent: ['/c/air-money-api', '/d/elsewhere']});
        expect(rows.map(r => `${r.kind} ${r.path}`)).toEqual([
            'here /c',
            'recent /c/air-money-api',
            'recent /d/elsewhere',
            'folder /c/agent-api-demo',
            'folder /c/air-metrics-api',
            'folder /c/air-metrics-api.feat-mai-pull',
        ]);
    });

    it('does not offer an open folder that is no repository', () => {
        expect(pickerRows({filter: '', here: {path: '/c', isRepo: false}, entries: [], recent: []})).toEqual([]);
    });

    it('keeps only what the filter matches, the best match first', () => {
        const rows = pickerRows({filter: 'metpull', here: {path: '/c', isRepo: true}, entries, recent: []});
        expect(rows.map(r => r.name)).toEqual(['air-metrics-api.feat-mai-pull']);

        const ranked = pickerRows({filter: 'airm', here: null, entries, recent: ['/d/air-mail']});
        expect(ranked.map(r => r.name)).toEqual(['air-mail', 'air-money-api', 'air-metrics-api', 'air-metrics-api.feat-mai-pull']);
    });

    it('wants every word, in any order, and marks a whole word where the name holds it', () => {
        const moca = {name: 'air-metrics-api.feat-MOCA-2382-mai-accounts', path: '/c/moca', isRepo: true};
        const [row] = pickerRows({filter: 'metrics mai', here: null, entries: [moca], recent: []});
        expect(row.marks.map(i => row.name[i]).join('')).toBe('metricsmai');

        expect(pickerRows({filter: 'pull metrics', here: null, entries, recent: []}).map(r => r.name)).toEqual(['air-metrics-api.feat-mai-pull']);
        expect(pickerRows({filter: 'metrics zzz', here: null, entries, recent: []})).toEqual([]);
    });

    it('ranks a name that holds the word above one that only has its letters', () => {
        const scattered = {name: 'a-misc-all-items', path: '/c/scattered', isRepo: true};
        const whole = {name: 'zz-long-prefix-here.feat-mai', path: '/c/whole', isRepo: true};
        expect(pickerRows({filter: 'mai', here: null, entries: [scattered, whole], recent: []}).map(r => r.path)).toEqual(['/c/whole', '/c/scattered']);
    });

    it('marks the letters the filter matched', () => {
        const [row] = pickerRows({filter: 'amp', here: null, entries: [entries[2]], recent: []});
        expect(row.marks.map(i => row.name[i]).join('')).toBe('amp');
    });
});

describe('crumbs', () => {
    it('splits a path into the folders that lead to it, home shortened to ~', () => {
        expect(crumbs({path: '/Users/me/Coding/app', home: HOME})).toEqual([
            {name: '~', path: '/Users/me'},
            {name: 'Coding', path: '/Users/me/Coding'},
            {name: 'app', path: '/Users/me/Coding/app'},
        ]);
    });

    it('starts at the root outside home', () => {
        expect(crumbs({path: '/opt/src', home: HOME})).toEqual([
            {name: '/', path: '/'},
            {name: 'opt', path: '/opt'},
            {name: 'src', path: '/opt/src'},
        ]);
        expect(crumbs({path: '/', home: HOME})).toEqual([{name: '/', path: '/'}]);
    });
});
