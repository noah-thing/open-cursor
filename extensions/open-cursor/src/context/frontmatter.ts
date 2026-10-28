/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import { minimatch } from 'minimatch';

export interface Frontmatter {
	description?: string;
	globs: string[];
	alwaysApply: boolean;
	raw: Record<string, string>;
}

function unquote(s: string): string {
	const t = s.trim();
	if ((t.startsWith('"') && t.endsWith('"') && t.length >= 2) || (t.startsWith('\'') && t.endsWith('\'') && t.length >= 2)) {
		return t.slice(1, -1);
	}
	return t;
}

function parseList(v: string): string[] {
	let t = v.trim();
	if (t.startsWith('[') && t.endsWith(']')) {
		t = t.slice(1, -1);
	}
	// Split on commas not inside braces ({a,b}).
	const out: string[] = [];
	let depth = 0;
	let cur = '';
	for (const ch of t) {
		if (ch === '{') { depth++; }
		if (ch === '}') { depth = Math.max(0, depth - 1); }
		if (ch === ',' && depth === 0) {
			out.push(cur);
			cur = '';
		} else {
			cur += ch;
		}
	}
	out.push(cur);
	return out.map(unquote).map(s => s.trim()).filter(Boolean);
}

/** Splits `---\nkey: value\n---\nbody`. Tolerates CRLF, a missing frontmatter block and YAML list values. */
export function parseFrontmatter(text: string): { fm: Frontmatter; body: string } {
	const fm: Frontmatter = { globs: [], alwaysApply: false, raw: {} };
	const src = text.replace(/^﻿/, '');
	const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
	if (!m) {
		return { fm, body: src };
	}
	const lines = m[1].split(/\r?\n/);
	let listKey: string | undefined;
	const lists: Record<string, string[]> = {};
	for (const line of lines) {
		const item = /^\s*-\s+(.*)$/.exec(line);
		if (item && listKey) {
			(lists[listKey] ??= []).push(unquote(item[1]));
			continue;
		}
		const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (!kv) {
			continue;
		}
		const key = kv[1];
		const val = kv[2].trim();
		listKey = val === '' ? key : undefined;
		fm.raw[key] = val;
	}
	if (fm.raw.description) {
		fm.description = unquote(fm.raw.description) || undefined;
	}
	const globsRaw = fm.raw.globs ?? fm.raw.paths;
	if (globsRaw) {
		fm.globs = parseList(globsRaw);
	} else if (lists.globs?.length) {
		fm.globs = lists.globs;
	} else if (lists.paths?.length) {
		fm.globs = lists.paths;
	}
	fm.alwaysApply = /^true$/i.test(unquote(fm.raw.alwaysApply ?? ''));
	return { fm, body: src.slice(m[0].length) };
}

/** Does any file (workspace relative, posix) match any of the globs. Bare patterns like `*.ts` match at any depth. */
export function globsMatch(globs: readonly string[], files: readonly string[]): boolean {
	for (const g of globs) {
		for (const f of files) {
			if (minimatch(f, g, { dot: true, matchBase: !g.includes('/') })) {
				return true;
			}
		}
	}
	return false;
}

export function firstLine(body: string, max = 100): string {
	for (const raw of body.split(/\r?\n/)) {
		const line = raw.replace(/^#+\s*/, '').trim();
		if (line) {
			return line.length > max ? line.slice(0, max - 1) + '…' : line;
		}
	}
	return '';
}
