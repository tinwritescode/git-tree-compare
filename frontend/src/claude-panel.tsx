// The Claude panel on the right of the diff, shared by Explain (one answer about a hunk) and Ask
// (a conversation). Claude's words are drawn as text: paragraphs, inline code and code blocks.
import {useEffect, useRef, useState} from 'react';
import {type ClaudePart, textBlocks, toolActivity, type Turn} from './claude-chat';
import {Button} from './ui/button';

export function ClaudePanel({title, turns, ask, onClose}: {
    title: string;
    turns: Turn[];
    // The question box, for Ask. prefill puts a question in it to edit and send, such as Why? on a finding.
    ask: {onSend: (question: string) => void; busy: boolean; prefill: {text: string; id: number} | null} | null;
    onClose: () => void; // stops a running answer too
}) {
    const end = useRef<HTMLDivElement>(null);
    const last = turns.at(-1);
    // Follow the answer as it streams.
    useEffect(() => end.current?.scrollIntoView({block: 'end'}), [last]);

    return (
        <aside className="claude-panel" aria-label={`Claude · ${title}`}>
            <div className="claude-panel-head">
                <span className="claude-panel-title">Claude · {title}</span>
                <Button size="icon" onClick={onClose} aria-label="Close" title="Close (Esc)">×</Button>
            </div>
            <div className="claude-panel-body" aria-live="polite">
                {turns.length === 0 && ask && (
                    <p className="claude-panel-hint">Ask Claude about this change. It reads the diff and the code at the head, and changes nothing.</p>
                )}
                {turns.map(turn => <TurnView key={turn.taskId} turn={turn} showAsk={ask !== null}/>)}
                <div ref={end}/>
            </div>
            {ask && <AskBox key={ask.prefill?.id ?? 0} initial={ask.prefill?.text ?? ''} busy={ask.busy} onSend={ask.onSend} onClose={onClose}/>}
        </aside>
    );
}

function TurnView({turn, showAsk}: {turn: Turn; showAsk: boolean}) {
    const {status} = turn;
    return (
        <div className="claude-turn">
            {showAsk ? <div className="claude-ask">{turn.ask}</div> : <div className="claude-subject">{turn.ask}</div>}
            <div className="claude-answer">
                <div className="claude-label">
                    Claude
                    {status.kind === 'done' && status.costUsd !== null && <span className="brief-cost">${status.costUsd.toFixed(2)}</span>}
                </div>
                {turn.parts.map((part, i) => <PartView key={i} part={part}/>)}
                {status.kind === 'running' && turn.parts.length === 0 && <p className="claude-tool">Reading the diff…</p>}
                {status.kind === 'error' && <p className="claude-error">{status.message === 'Stopped.' ? 'Stopped.' : `Claude could not answer: ${status.message}`}</p>}
            </div>
        </div>
    );
}

function PartView({part}: {part: ClaudePart}) {
    switch (part.kind) {
        case 'tool':
            return <p className="claude-tool">{toolActivity(part)}</p>;
        case 'text':
            return (
                <>
                    {textBlocks(part.text).map((block, i) => (block.kind === 'code'
                        ? <pre key={i} className="claude-code">{block.text}</pre>
                        : <p key={i} className="claude-text">
                            {block.spans.map((span, j) => (span.kind === 'code' ? <code key={j}>{span.text}</code> : span.text))}
                        </p>))}
                </>
            );
        default: {
            const _exhaustive: never = part;
            return _exhaustive;
        }
    }
}

// AskBox: Enter sends, ⇧Enter starts a new line, Esc closes the panel.
function AskBox({initial, busy, onSend, onClose}: {initial: string; busy: boolean; onSend: (question: string) => void; onClose: () => void}) {
    const [question, setQuestion] = useState(initial);
    return (
        <div className="claude-ask-box">
            <textarea
                autoFocus
                rows={2}
                value={question}
                placeholder={busy ? 'Claude is answering… (Esc stops it)' : 'Ask about this change (Enter to send)'}
                aria-label="Question for Claude"
                onChange={e => setQuestion(e.target.value)}
                onKeyDown={e => {
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        onClose();
                    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        if (busy || !question.trim()) return;
                        onSend(question);
                        setQuestion('');
                    }
                }}
            />
        </div>
    );
}

// ClaudeSwitch turns Claude on or off. Off, no task runs, so nothing is spent.
export function ClaudeSwitch({on, onFlip}: {on: boolean; onFlip: () => void}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            className="claude-switch"
            onClick={onFlip}
            title={on
                ? 'Claude writes a brief and looks for findings when a review opens. Turn it off to spend nothing.'
                : 'Claude is off: no brief, findings, Explain or Ask. Turning it on starts a brief for the open review.'}
        >
            <span className="claude-switch-knob" aria-hidden="true"/>Claude {on ? 'on' : 'off'}
        </button>
    );
}
