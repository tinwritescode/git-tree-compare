// The Shiki tokenizer, run off the main thread so a large file never freezes the window.
// It takes source texts in one language and returns each text's lines as tokens.

import {createCssVariablesTheme, createHighlighterCore, type HighlighterCore} from 'shiki/core';
import {createJavaScriptRegexEngine} from 'shiki/engine/javascript';
import {bundledLanguages} from 'shiki/langs';
import {compact, type Token} from './syntax';

export type HighlightRequest = {id: number; lang: string; texts: string[]};
export type HighlightReply = {id: number; texts: Token[][][]} | {id: number; error: string};

const THEME = 'console';
const theme = createCssVariablesTheme({name: THEME, variablePrefix: '--shiki-', fontStyle: true});

let highlighter: Promise<HighlighterCore> | undefined;

// load starts the highlighter once and adds each language the first time a file needs it.
async function load(lang: string): Promise<HighlighterCore> {
    highlighter ??= createHighlighterCore({themes: [theme], langs: [], engine: createJavaScriptRegexEngine()});
    const hl = await highlighter;
    if (!hl.getLoadedLanguages().includes(lang)) {
        await hl.loadLanguage(bundledLanguages[lang as keyof typeof bundledLanguages]);
    }
    return hl;
}

self.onmessage = async (e: MessageEvent<HighlightRequest>) => {
    const {id, lang, texts} = e.data;
    try {
        if (!(lang in bundledLanguages)) {
            self.postMessage({id, texts: texts.map(() => [])} satisfies HighlightReply);
            return;
        }
        const hl = await load(lang);
        const out = texts.map(text => hl
            .codeToTokensBase(text, {lang, theme: THEME, tokenizeMaxLineLength: 1000})
            .map(row => compact(row.map(t => ({text: t.content, color: t.color})))));
        self.postMessage({id, texts: out} satisfies HighlightReply);
    } catch (err) {
        self.postMessage({id, error: String(err)} satisfies HighlightReply);
    }
};
