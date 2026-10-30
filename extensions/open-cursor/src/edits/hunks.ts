/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Pure hunk logic for pending edits, no vscode import.
 *--------------------------------------------------------------------------------------------*/

import { diffArrays } from 'diff';

/** Review state is kept with `\n` endings; withEol converts back to the document's EOL on write. */
export function norm(text: string): string {
	return text.indexOf('\r') === -1 ? text : text.replace(/\r\n?/g, '\n');
}

export function splitLines(text: string): string[] {
	return norm(text).split('\n');
}

export interface Hunk {
	readonly id: string;
	/** 0-based. */
	readonly origStart: number;
	readonly origCount: number;
	readonly curStart: number;
	readonly curCount: number;
	readonly removedLines: string[];
	readonly addedLines: string[];
}

function fnv1a(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(36);
}

/**
 * Line diff original -> current. A run of removed+added lines becomes one hunk.
 * Ids hash the hunk content plus its occurrence index among identical hunks, never the position,
 * so accepting or rejecting another hunk does not change them.
 */
export function computeHunks(original: string, current: string): Hunk[] {
	const a = splitLines(original);
	const b = splitLines(current);
	if (original === current) {
		return [];
	}
	const changes = diffArrays(a, b);
	const raw: Omit<Hunk, 'id'>[] = [];
	let oi = 0;
	let ci = 0;
	let open: { origStart: number; curStart: number; removed: string[]; added: string[] } | undefined;
	const close = () => {
		if (open && (open.removed.length || open.added.length)) {
			raw.push({
				origStart: open.origStart, origCount: open.removed.length,
				curStart: open.curStart, curCount: open.added.length,
				removedLines: open.removed, addedLines: open.added,
			});
		}
		open = undefined;
	};
	for (const ch of changes) {
		const lines = ch.value as string[];
		if (ch.removed) {
			open ??= { origStart: oi, curStart: ci, removed: [], added: [] };
			open.removed.push(...lines);
			oi += lines.length;
		} else if (ch.added) {
			open ??= { origStart: oi, curStart: ci, removed: [], added: [] };
			open.added.push(...lines);
			ci += lines.length;
		} else {
			close();
			oi += lines.length;
			ci += lines.length;
		}
	}
	close();
	const seen = new Map<string, number>();
	return raw.map(h => {
		const key = fnv1a(h.removedLines.join('\n') + '\u0000' + h.addedLines.join('\n'));
		const n = seen.get(key) ?? 0;
		seen.set(key, n + 1);
		return { ...h, id: `${key}-${n}` };
	});
}

/** New original snapshot after the user keeps `hunk`: its added lines replace the removed ones. */
export function foldAccept(original: string, hunk: Hunk): string {
	const a = splitLines(original);
	a.splice(hunk.origStart, hunk.origCount, ...hunk.addedLines);
	return a.join('\n');
}

/** New current text after the user undoes `hunk`: its removed lines come back. */
export function applyReject(current: string, hunk: Hunk): string {
	const b = splitLines(current);
	b.splice(hunk.curStart, hunk.curCount, ...hunk.removedLines);
	return b.join('\n');
}

export function countChanges(hunks: readonly Hunk[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const h of hunks) {
		added += h.curCount;
		removed += h.origCount;
	}
	return { added, removed };
}

/** Smallest single replacement turning `oldText` into `newText`, so cursors and folds outside it survive. */
export function minimalEdit(oldText: string, newText: string): { start: number; end: number; text: string } | undefined {
	if (oldText === newText) {
		return undefined;
	}
	const max = Math.min(oldText.length, newText.length);
	let p = 0;
	while (p < max && oldText.charCodeAt(p) === newText.charCodeAt(p)) {
		p++;
	}
	if (p > 0 && oldText[p - 1] === '\r') {
		p--;
	}
	let s = 0;
	while (s < max - p && oldText.charCodeAt(oldText.length - 1 - s) === newText.charCodeAt(newText.length - 1 - s)) {
		s++;
	}
	if (s > 0 && oldText[oldText.length - s] === '\n' && oldText[oldText.length - s - 1] === '\r') {
		s--;
	}
	return { start: p, end: oldText.length - s, text: newText.slice(p, newText.length - s) };
}

export function withEol(text: string, eol: '\n' | '\r\n'): string {
	return eol === '\n' ? norm(text) : norm(text).replace(/\n/g, '\r\n');
}

/**
 * Like minimalEdit, but `oldRaw` may mix `\n` and `\r\n`. The diff runs on normalized text and maps back, so
 * untouched lines keep their endings. Inserted text takes the ending of the lines around the change.
 */
export function minimalRawEdit(oldRaw: string, text: string, defaultEol: '\n' | '\r\n'): { start: number; end: number; text: string } | undefined {
	const nOld = norm(oldRaw);
	const nNew = norm(text);
	const m = minimalEdit(nOld, nNew);
	if (!m) {
		return undefined;
	}
	let start = m.start;
	let end = m.end;
	if (nOld.length !== oldRaw.length) {
		// walk the raw text once, counting normalized characters
		let n = 0;
		let rs = -1;
		let re = -1;
		for (let i = 0; i <= oldRaw.length; i++) {
			if (n === m.start && rs < 0) { rs = i; }
			if (n === m.end && re < 0) { re = i; break; }
			if (i === oldRaw.length) { break; }
			if (oldRaw[i] === '\r' && oldRaw[i + 1] === '\n') { i++; }
			n++;
		}
		start = rs < 0 ? oldRaw.length : rs;
		end = re < 0 ? oldRaw.length : re;
	}
	let eol = defaultEol;
	const before = start > 0 ? oldRaw.lastIndexOf('\n', start - 1) : -1;
	if (before >= 0) {
		eol = oldRaw[before - 1] === '\r' ? '\r\n' : '\n';
	} else {
		const after = oldRaw.indexOf('\n', end);
		if (after >= 0) { eol = oldRaw[after - 1] === '\r' ? '\r\n' : '\n'; }
	}
	return { start, end, text: withEol(m.text, eol) };
}
