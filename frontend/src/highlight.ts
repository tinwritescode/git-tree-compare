// highlight colours a parsed diff with Shiki. Colours come out as CSS variables
// (--shiki-token-*), which App.css points at the theme, so light and dark both follow it.

import {createCssVariablesTheme, createHighlighterCore, type HighlighterCore} from 'shiki/core';
import {createJavaScriptRegexEngine} from 'shiki/engine/javascript';
import {bundledLanguages} from 'shiki/langs';
import type {Line} from './diff';
import {langFor, sides, type Token} from './syntax';

const THEME = 'console';
const theme = createCssVariablesTheme({name: THEME, variablePrefix: '--shiki-', fontStyle: true});

let highlighter: Promise<HighlighterCore> | undefined;

// load starts the highlighter once and adds each language the first time a file needs it.
async function load(lang: string): Promise<HighlighterCore | undefined> {
    if (!(lang in bundledLanguages)) return undefined;
    highlighter ??= createHighlighterCore({themes: [theme], langs: [], engine: createJavaScriptRegexEngine()});
    const hl = await highlighter;
    if (!hl.getLoadedLanguages().includes(lang)) {
        await hl.loadLanguage(bundledLanguages[lang as keyof typeof bundledLanguages]);
    }
    return hl;
}

// highlight returns the coloured tokens of each code line, keyed by the line.
// Each hunk is read as two files, old and new, so a token that spans lines keeps its colour.
// A file in an unknown language comes back empty and draws as plain text.
export async function highlight(lines: Line[], path: string): Promise<Map<Line, Token[]>> {
    const out = new Map<Line, Token[]>();
    const lang = langFor(path);
    const hl = lang && await load(lang);
    if (!lang || !hl) return out;

    const colour = (side: Line[], only?: Line['kind']) => {
        const rows = hl.codeToTokensBase(side.map(l => l.text).join('\n'), {lang, theme: THEME, tokenizeMaxLineLength: 1000});
        side.forEach((line, i) => {
            if (only && line.kind !== only) return;
            out.set(line, (rows[i] ?? []).map(t => ({text: t.content, color: t.color})));
        });
    };
    for (const side of sides(lines)) {
        colour(side.new);
        colour(side.old, 'del');
    }
    return out;
}
