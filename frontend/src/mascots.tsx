import type {CSSProperties, ReactNode} from 'react';

// One flat mascot per app state. Colours come from CSS variables, motion from the
// .mascot-* keyframes in App.css, which switch off under prefers-reduced-motion.

const OWL_EARS = 'M-18 -22 L-14 -40 L-6 -28 Z M18 -22 L14 -40 L6 -28 Z';

// The owl body, centred on (0,0). `tone` flips it white for the dark "all reviewed" card.
function Owl({tone = 'ink', eyes}: {tone?: 'ink' | 'paper'; eyes: 'asleep' | 'open' | 'happy' | 'search'}) {
    const body = tone === 'ink' ? 'var(--m-ink)' : '#fff';
    return (
        <g>
            <path d={OWL_EARS} fill={body}/>
            <ellipse cx="0" cy="0" rx="25" ry="28" fill={body}/>
            <ellipse cx="0" cy="9" rx="14" ry="16" fill="var(--m-lilac)"/>
            {eyes === 'asleep' && <path d="M-13 -6 q5 4 10 0 M3 -6 q5 4 10 0" stroke="#fff" strokeWidth="2.5" fill="none" strokeLinecap="round"/>}
            {eyes === 'happy' && <path d="M-13 -4 q4 -5 8 0 M5 -4 q4 -5 8 0" stroke="var(--m-pupil)" strokeWidth="3" fill="none" strokeLinecap="round"/>}
            {(eyes === 'open' || eyes === 'search') && (
                <g className={eyes === 'open' ? 'mascot-blink' : undefined}>
                    <circle cx="-10" cy="-8" r="9" fill="#fff"/>
                    <circle cx="10" cy="-8" r="9" fill="#fff"/>
                    <g className={eyes === 'search' ? 'mascot-look' : undefined}>
                        <circle cx="-8" cy="-7" r="4" fill="var(--m-pupil)"/>
                        <circle cx="12" cy="-7" r="4" fill="var(--m-pupil)"/>
                    </g>
                </g>
            )}
            <path d="M-3 -1 L3 -1 L0 5 Z" fill="var(--m-sun)"/>
        </g>
    );
}

function Art({children}: {children: ReactNode}) {
    return (
        <svg className="mascot" width="150" height="110" viewBox="0 0 150 110" role="img" aria-hidden="true">
            {children}
        </svg>
    );
}

// Landing: the owl dozes on a git branch, zzz floating up.
export function OwlAsleep() {
    return (
        <Art>
            <path d="M5 92 H145" stroke="var(--m-acorn)" strokeWidth="6" strokeLinecap="round"/>
            <path d="M95 92 Q110 92 118 76" stroke="var(--m-acorn)" strokeWidth="5" fill="none" strokeLinecap="round"/>
            <circle cx="30" cy="92" r="6" fill="var(--m-sun)" stroke="var(--m-ink)" strokeWidth="2.5"/>
            <circle cx="118" cy="76" r="6" fill="var(--m-cherry)" stroke="var(--m-ink)" strokeWidth="2.5"/>
            <circle cx="130" cy="92" r="6" fill="#fff" stroke="var(--m-ink)" strokeWidth="2.5"/>
            <g transform="translate(70 62)"><g className="mascot-breathe"><Owl eyes="asleep"/></g></g>
            {[13, 15, 17].map((size, i) => (
                <text key={size} className="mascot-z" x="96" y="38" fontSize={size} style={{animationDelay: `${i * 0.9}s`}}>z</text>
            ))}
        </Art>
    );
}

// Loading pull requests: a snail crawls along a track and leaves a yellow trail.
export function Snail() {
    return (
        <div className="mascot-snail" aria-hidden="true">
            <div className="mascot-track"><div className="mascot-trail"/></div>
            <svg className="mascot-crawl" width="46" height="40" viewBox="0 0 46 40">
                <g className="mascot-squish">
                    <path d="M2 36 Q2 28 12 28 H40 Q46 28 44 36 Z" fill="var(--m-pink)"/>
                    <path d="M38 28 L40 14 M42 28 L46 16" stroke="var(--m-pink)" strokeWidth="3" strokeLinecap="round"/>
                    <circle cx="40" cy="13" r="2.5" fill="var(--m-ink)"/>
                    <circle cx="46" cy="15" r="2.5" fill="var(--m-ink)"/>
                    <circle cx="20" cy="20" r="14" fill="var(--m-sun)"/>
                    <path d="M20 20 m0 -8 a8 8 0 1 1 -8 8 a5 5 0 1 1 5 -5 a2 2 0 1 1 -2 2" stroke="var(--m-sun-deep)" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
                </g>
            </svg>
        </div>
    );
}

// Work is waiting: the owl is awake on its branch. Leads the inbox and sits beside the diff.
export function OwlPerch() {
    return (
        <Art>
            <path d="M5 95 H145" stroke="var(--m-acorn)" strokeWidth="6" strokeLinecap="round"/>
            <g transform="translate(75 62)"><Owl eyes="open"/></g>
        </Art>
    );
}

// Nothing to review: the owl sits by an empty tray and blinks.
export function OwlTray() {
    return (
        <Art>
            <g transform="translate(60 62)"><g className="mascot-bob"><Owl eyes="open"/></g></g>
            <path d="M92 74 H138 L132 94 H98 Z" fill="#fff" stroke="var(--m-ink)" strokeWidth="3" strokeLinejoin="round"/>
            <path d="M5 95 H145" stroke="var(--m-lilac)" strokeWidth="4" strokeLinecap="round"/>
        </Art>
    );
}

// Every file reviewed: the owl hops, confetti falls.
const CONFETTI: {x: number; y: number; dx: number; delay: number; fill: string; shape: 'rect' | 'dot'}[] = [
    {x: 60, y: 30, dx: -30, delay: 0, fill: 'var(--m-sun)', shape: 'rect'},
    {x: 88, y: 28, dx: 28, delay: 0.3, fill: 'var(--m-cherry)', shape: 'rect'},
    {x: 75, y: 24, dx: 6, delay: 0.6, fill: 'var(--m-leaf)', shape: 'dot'},
    {x: 50, y: 40, dx: -18, delay: 0.9, fill: 'var(--m-pink)', shape: 'rect'},
];

export function OwlHop() {
    return (
        <Art>
            <g transform="translate(75 64)"><g className="mascot-hop"><Owl tone="paper" eyes="happy"/></g></g>
            {CONFETTI.map(c => {
                const style = {'--dx': `${c.dx}px`, animationDelay: `${c.delay}s`} as CSSProperties;
                return c.shape === 'dot'
                    ? <circle key={c.x} className="mascot-bit" cx={c.x} cy={c.y} r="3.5" fill={c.fill} style={style}/>
                    : <rect key={c.x} className="mascot-bit" x={c.x} y={c.y} width="6" height="6" fill={c.fill} style={style}/>;
            })}
        </Art>
    );
}

// Search found nothing: the owl scans with a magnifier.
export function OwlSearch() {
    return (
        <Art>
            <g transform="translate(75 62)"><Owl eyes="search"/></g>
            <g className="mascot-sweep">
                <g transform="translate(28 70)">
                    <circle r="11" fill="var(--m-sun-soft)" stroke="var(--m-sun)" strokeWidth="4"/>
                    <path d="M8 8 L18 18" stroke="var(--m-acorn)" strokeWidth="5" strokeLinecap="round"/>
                </g>
            </g>
            <path d="M5 95 H145" stroke="var(--m-lilac)" strokeWidth="4" strokeLinecap="round"/>
        </Art>
    );
}
