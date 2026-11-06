// CI checks on a pull request's head, as the run-command panel shows them.
import type {main} from '../wailsjs/go/models';

export type CheckChip = {kind: 'pass' | 'fail' | 'pending' | 'neutral'; label: string};

// checkChip is the chip a check shows. bucket is gh's grouping of the check's state.
export function checkChip({bucket, state}: main.Check): CheckChip {
    switch (bucket) {
        case 'pass':
            return {kind: 'pass', label: 'Passed'};
        case 'fail':
            return {kind: 'fail', label: 'Failed'};
        case 'pending':
            return {kind: 'pending', label: 'Running'};
        case 'skipping':
            return {kind: 'neutral', label: 'Skipped'};
        case 'cancel':
            return {kind: 'neutral', label: 'Cancelled'};
        default:
            return {kind: 'neutral', label: state.toLowerCase()};
    }
}

export function checksSummary(checks: main.Check[]): string {
    if (!checks.length) return 'No checks on this pull request';
    const count = (kind: CheckChip['kind']) => checks.filter(c => checkChip(c).kind === kind).length;
    return [
        [count('fail'), 'failed'],
        [count('pending'), 'running'],
        [count('pass'), 'passed'],
        [count('neutral'), 'other'],
    ].flatMap(([n, label]) => (n ? [`${n} ${label}`] : [])).join(' · ');
}
