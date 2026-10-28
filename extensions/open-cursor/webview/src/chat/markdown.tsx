/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import { createContext, memo, useCallback, useContext, useMemo, useState, type MouseEvent, type ReactElement } from 'react';
import { Marked, type Token, type Tokens } from 'marked';
import { escapeHtml, highlight } from '../common/highlight';
import { Icon } from '../common/icons';
import { post } from './host';

const SAFE_HREF = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i;
const PATH_LIKE = /^[\w@.\-/\\]*[\w\-]\.[A-Za-z0-9]{1,8}(?::\d+(?:-\d+)?)?$|^(?:[\w@.\-]+\/)+[\w@.\-]*(?::\d+(?:-\d+)?)?$/;

const GO_ARROW = '<svg class="oc-go-arrow" width="11" height="11" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const md = new Marked({
	gfm: true,
	breaks: false,
	renderer: {
		// Never pass raw HTML from the model through.
		html(token: Tokens.HTML | Tokens.Tag): string {
			return escapeHtml(token.text);
		},
		link(this: { parser: { parseInline(t: Token[]): string } }, token: Tokens.Link): string {
			const text = this.parser.parseInline(token.tokens);
			// Help's links into the app become buttons; the host checks the target before opening anything.
			if (/^opencursor:/i.test(token.href.trim())) {
				return '<button type="button" class="oc-go" data-help="' + escapeHtml(token.href.trim()) + '"><span>' + text + '</span>' + GO_ARROW + '</button>';
			}
			if (!SAFE_HREF.test(token.href.trim())) { return text; }
			const title = token.title ? ' title="' + escapeHtml(token.title) + '"' : '';
			return '<a href="' + escapeHtml(token.href) + '"' + title + '>' + text + '</a>';
		},
		image(token: Tokens.Image): string {
			return '<span class="oc-md-image">' + escapeHtml(token.text || token.href) + '</span>';
		},
		codespan(token: Tokens.Codespan): string {
			const text = token.text;
			if (PATH_LIKE.test(text) && text.length < 160) {
				return '<code class="oc-path" data-path="' + escapeHtml(text) + '" title="Open file">' + escapeHtml(text) + '</code>';
			}
			return '<code>' + escapeHtml(text) + '</code>';
		},
	},
});

export function parseBlocks(text: string): Token[] {
	try {
		return md.lexer(text);
	} catch {
		return [{ type: 'paragraph', raw: text, text, tokens: [{ type: 'text', raw: text, text }] } as Tokens.Paragraph];
	}
}

function renderToken(token: Token): string {
	try {
		return md.parser([token] as unknown as Token[]);
	} catch {
		return escapeHtml(token.raw);
	}
}

const htmlCache = new Map<string, string>();
function cachedHtml(token: Token): string {
	const key = token.type + '\u0000' + token.raw;
	let html = htmlCache.get(key);
	if (html === undefined) {
		html = renderToken(token);
		if (htmlCache.size > 600) { htmlCache.clear(); }
		htmlCache.set(key, html);
	}
	return html;
}

interface FenceInfo { readonly lang: string | undefined; readonly path: string | undefined }

function parseFence(info: string | undefined): FenceInfo {
	if (!info) { return { lang: undefined, path: undefined }; }
	const s = info.trim();
	const titled = /title=["']([^"']+)["']/.exec(s);
	const first = s.split(/\s+/)[0];
	const colon = first.indexOf(':');
	if (colon > 0) {
		return { lang: first.slice(0, colon), path: first.slice(colon + 1) || undefined };
	}
	if (/[./\\]/.test(first) && !/^[\w+#-]+$/.test(first)) {
		return { lang: first.split('.').pop(), path: first };
	}
	return { lang: first.replace(/[{].*/, ''), path: titled?.[1] };
}

const SHELL_LANGS = new Set(['bash', 'sh', 'zsh', 'shell', 'console', 'fish', 'powershell', 'ps1', 'cmd']);

function CopyIcon({ code }: { readonly code: string }): ReactElement {
	const [done, setDone] = useState(false);
	return (
		<button
			type="button"
			className="oc-iconbtn"
			title="Copy"
			aria-label="Copy code"
			onClick={() => {
				post({ type: 'copy', text: code });
				setDone(true);
				setTimeout(() => setDone(false), 1200);
			}}
		>
			<Icon name={done ? 'check' : 'copy'} size={14} />
		</button>
	);
}

const COLLAPSE_LINES = 22;

/** False in Help: its answers only explain, so code in them gets Copy and nothing that runs or writes. */
export const CodeActions = createContext(true);

export const CodeBlock = memo(function CodeBlock({ code, info }: { readonly code: string; readonly info?: string }): ReactElement {
	const { lang, path } = useMemo(() => parseFence(info), [info]);
	const html = useMemo(() => highlight(code, lang), [code, lang]);
	const lineCount = useMemo(() => code.split('\n').length, [code]);
	const [expanded, setExpanded] = useState(false);
	const collapsible = lineCount > COLLAPSE_LINES;
	const isShell = !!lang && SHELL_LANGS.has(lang.toLowerCase());
	const label = path ?? (lang && lang !== 'text' ? lang : '');
	const actions = useContext(CodeActions);
	return (
		<div className="oc-code">
			<div className="oc-code-head">
				<span className="oc-code-label" title={path}>
					{path ? <Icon name="file" size={12} /> : null}
					<span>{label || 'text'}</span>
				</span>
				<span className="oc-code-actions">
					<CopyIcon code={code} />
					{!actions ? null : isShell ? (
						<button type="button" className="oc-iconbtn" title="Run in terminal" aria-label="Run in terminal" onClick={() => post({ type: 'runInTerminal', command: code.trim() })}>
							<Icon name="terminal" size={14} />
						</button>
					) : (
						<>
							<button type="button" className="oc-iconbtn" title="Insert at cursor" aria-label="Insert at cursor" onClick={() => post({ type: 'insertCode', code, languageId: lang })}>
								<Icon name="arrowRight" size={14} />
							</button>
							<button type="button" className="oc-textbtn" title={path ? 'Apply to ' + path : 'Apply to the active file'} onClick={() => post({ type: 'applyCode', code, path })}>
								Apply
							</button>
						</>
					)}
				</span>
			</div>
			<pre className={'oc-code-body' + (collapsible && !expanded ? ' is-collapsed' : '')}>
				<code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
			</pre>
			{collapsible ? (
				<button type="button" className="oc-code-more" onClick={() => setExpanded(e => !e)}>
					{expanded ? 'Show less' : 'Show ' + (lineCount - COLLAPSE_LINES) + ' more lines'}
				</button>
			) : null}
		</div>
	);
});

const HtmlBlock = memo(
	function HtmlBlock({ token }: { readonly token: Token }): ReactElement {
		const html = cachedHtml(token);
		return <div className="oc-md-block" dangerouslySetInnerHTML={{ __html: html }} />;
	},
	(a, b) => a.token.raw === b.token.raw && a.token.type === b.token.type,
);

const CodeToken = memo(
	function CodeToken({ token }: { readonly token: Tokens.Code }): ReactElement {
		return <CodeBlock code={token.text} info={token.lang} />;
	},
	(a, b) => a.token.text === b.token.text && a.token.lang === b.token.lang,
);

function openPath(raw: string): void {
	const m = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(raw);
	const p = m?.[1] ?? raw;
	const start = m?.[2] ? Number(m[2]) : undefined;
	const end = m?.[3] ? Number(m[3]) : start;
	post({ type: 'openFile', uri: p, range: start ? { startLine: start, endLine: end ?? start } : undefined });
}

/** Renders markdown block by block so streaming only re-renders the block that is still growing. */
export const Markdown = memo(function Markdown({ text, className }: { readonly text: string; readonly className?: string }): ReactElement {
	const tokens = useMemo(() => parseBlocks(text).filter(t => t.type !== 'space'), [text]);
	const onClick = useCallback((e: MouseEvent<HTMLDivElement>) => {
		const target = e.target as HTMLElement;
		const go = target.closest<HTMLElement>('[data-help]');
		if (go?.dataset.help) {
			e.preventDefault();
			post({ type: 'helpAction', href: go.dataset.help });
			return;
		}
		const el = target.closest<HTMLElement>('[data-path]');
		if (el?.dataset.path) {
			e.preventDefault();
			openPath(el.dataset.path);
		}
	}, []);
	return (
		<div className={'oc-md' + (className ? ' ' + className : '')} onClick={onClick}>
			{tokens.map((t, i) => (t.type === 'code' ? <CodeToken key={i} token={t as Tokens.Code} /> : <HtmlBlock key={i} token={t} />))}
		</div>
	);
});
