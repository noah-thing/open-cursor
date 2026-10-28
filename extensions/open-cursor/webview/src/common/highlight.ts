/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  highlight.js with a curated language set to keep the bundle small.
 *--------------------------------------------------------------------------------------------*/

import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGS: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
	bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, markdown, php, python,
	ruby, rust, scss, shell, sql, swift, typescript, xml, yaml,
};
for (const [name, def] of Object.entries(LANGS)) {
	hljs.registerLanguage(name, def);
}

const ALIASES: Record<string, string> = {
	sh: 'bash', zsh: 'bash', console: 'shell', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
	ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', rs: 'rust', html: 'xml', svg: 'xml', vue: 'xml',
	yml: 'yaml', toml: 'ini', md: 'markdown', patch: 'diff', 'c++': 'cpp', cs: 'csharp', kt: 'kotlin', jsonc: 'json',
	json5: 'json', docker: 'dockerfile', golang: 'go', objc: 'c', h: 'c', hpp: 'cpp',
};

export function resolveLanguage(lang: string | undefined): string | undefined {
	if (!lang) { return undefined; }
	const l = lang.toLowerCase().trim().split(/\s|{/)[0];
	const name = ALIASES[l] ?? l;
	return hljs.getLanguage(name) ? name : undefined;
}

export function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const cache = new Map<string, string>();

/** Returns highlighted HTML (escaped). Falls back to escaped text for unknown languages. */
export function highlight(code: string, lang: string | undefined): string {
	const name = resolveLanguage(lang);
	if (!name) { return escapeHtml(code); }
	const key = name + '\u0000' + code;
	const hit = cache.get(key);
	if (hit !== undefined) { return hit; }
	let html: string;
	try {
		html = hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
	} catch {
		html = escapeHtml(code);
	}
	if (cache.size > 300) { cache.clear(); }
	cache.set(key, html);
	return html;
}
