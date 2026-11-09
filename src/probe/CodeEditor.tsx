// CodeMirror for both the library file and the one-line console prompt, with completion of
// commands, place names inside quotes, and the player's own library functions.

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionStatus, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab, insertNewlineAndIndent } from '@codemirror/commands';
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript';
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { COMMANDS } from './world';

/** What completion can offer, read fresh on every keystroke. */
export interface Vocab {
  /** Names that go inside quotes: places, shop items, pack items, encounter options. */
  strings: () => string[];
  /** The library file, so its functions can be offered. */
  library: () => string;
}

const LIB_DEF = /^(?:async\s+)?function\s+([\w$]+)|^(?:const|let|var)\s+([\w$]+)\s*=/gm;

function gameCompletions(vocab: Vocab) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
    if (node.name === 'String') {
      const from = node.from + 1;
      return { from, options: [...new Set(vocab.strings())].map((label) => ({ label, type: 'text' })), validFor: /^[\w ]*$/ };
    }
    const word = ctx.matchBefore(/[\w$]*/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    if (ctx.state.sliceDoc(word.from - 1, word.from) === '.') return null; // member access: leave it to the language
    const call = (name: string, hasArgs: boolean) => (view: EditorView, _c: Completion, from: number, to: number) => {
      view.dispatch({ changes: { from, to, insert: `${name}()` }, selection: { anchor: from + name.length + (hasArgs ? 1 : 2) } });
    };
    const options: Completion[] = COMMANDS.map((c) => ({
      label: c.name, type: 'function', detail: c.sig.slice(c.name.length), info: c.short, apply: call(c.name, !c.sig.endsWith('()')),
    }));
    const seen = new Set(options.map((o) => o.label));
    for (const m of vocab.library().matchAll(LIB_DEF)) {
      const name = m[1] ?? m[2];
      if (name && !seen.has(name)) { seen.add(name); options.push({ label: name, type: 'variable', detail: 'library', boost: 1 }); }
    }
    return { from: word.from, options, validFor: /^[\w$]*$/ };
  };
}

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: '#c792ea' },
  { tag: [t.string, t.special(t.string)], color: '#c3e88d' },
  { tag: [t.number, t.bool, t.null], color: '#f78c6c' },
  { tag: t.comment, color: '#6b7380', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#82aaff' },
  { tag: t.propertyName, color: '#e6e9ee' },
  { tag: [t.operator, t.punctuation], color: '#89ddff' },
]);

const theme = EditorView.theme({
  '&': { color: '#e6e9ee', backgroundColor: '#11151a', height: '100%', fontSize: '0.95rem' },
  '.cm-content': { fontFamily: 'ui-monospace, monospace', caretColor: '#5ab0ff', padding: '8px 0' },
  '.cm-scroller': { fontFamily: 'ui-monospace, monospace', lineHeight: '1.5' },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': { backgroundColor: '#11151a', color: '#4b5361', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'rgba(90, 176, 255, 0.05)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#8b93a0' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'rgba(90, 176, 255, 0.25)' },
  '.cm-tooltip': { backgroundColor: '#171b21', border: '1px solid #2a3038', color: '#e6e9ee' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '4px 8px', fontFamily: 'ui-monospace, monospace' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: '#22324a', color: '#e6e9ee' },
  '.cm-completionDetail': { color: '#8b93a0', marginLeft: '8px', fontStyle: 'normal' },
  '.cm-completionInfo': { backgroundColor: '#171b21', border: '1px solid #2a3038', padding: '6px 8px' },
}, { dark: true });

export interface EditorHandle {
  focus: () => void;
  /** Replace the text and put the cursor at the end. */
  setText: (text: string) => void;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** 'file': a full editor. 'line': the console prompt, where Enter submits. */
  mode: 'file' | 'line';
  vocab: Vocab;
  onSubmit?: () => void;
  onSave?: () => void;
  /** Up (-1) or down (+1) through console history; returns the text to show, or null to do nothing. */
  onHistory?: (dir: -1 | 1) => string | null;
}

export const CodeEditor = forwardRef<EditorHandle, Props>(function CodeEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    setText: (text) => {
      const v = view.current;
      if (v && v.state.doc.toString() !== text) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: text.length } });
    },
  }), []);

  useEffect(() => {
    const p = latest.current;
    const line = p.mode === 'line';
    const historyKey = (dir: -1 | 1) => (v: EditorView) => {
      if (v.state.doc.lines > 1 || completionStatus(v.state) === 'active') return false;
      const text = latest.current.onHistory?.(dir);
      if (text == null) return false;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: text.length } });
      return true;
    };
    const extensions: Extension[] = [
      history(), drawSelection(), bracketMatching(), closeBrackets(),
      javascript(), javascriptLanguage.data.of({ autocomplete: gameCompletions({ strings: () => latest.current.vocab.strings(), library: () => latest.current.vocab.library() }) }),
      autocompletion({ activateOnTyping: true }),
      syntaxHighlighting(highlight), theme,
      EditorView.updateListener.of((u) => { if (u.docChanged) latest.current.onChange(u.state.doc.toString()); }),
      EditorView.contentAttributes.of({ autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', ...(line ? { enterkeyhint: 'go' } : {}) }),
    ];
    if (line) {
      extensions.push(EditorView.lineWrapping, Prec.high(keymap.of([
        { key: 'Enter', run: () => { latest.current.onSubmit?.(); return true; } },
        { key: 'Shift-Enter', run: insertNewlineAndIndent },
        { key: 'ArrowUp', run: historyKey(-1) },
        { key: 'ArrowDown', run: historyKey(1) },
      ])));
    } else {
      extensions.push(lineNumbers(), highlightActiveLine(), indentOnInput(), Prec.high(keymap.of([
        { key: 'Mod-s', run: () => { latest.current.onSave?.(); return true; }, preventDefault: true },
      ])), keymap.of([indentWithTab]));
    }
    extensions.push(keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]));
    const v = new EditorView({ parent: host.current!, state: EditorState.create({ doc: p.value, extensions }) });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
  }, []);

  // Follow outside changes (cleared after submit, recalled from history or the log).
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === props.value) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value }, selection: { anchor: props.value.length } });
  }, [props.value]);

  return <div className={`editor ${props.mode}`} ref={host} />;
});
