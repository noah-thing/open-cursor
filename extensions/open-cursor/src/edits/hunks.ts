/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Pure hunk logic for pending edits (no vscode import): line diff, stable ids, accept/reject folding.
 *--------------------------------------------------------------------------------------------*/

import { diffArrays } from 'diff';

/** Normalise line endings. All review state is kept with `\n`; VS Code converts to the document EOL on write. */
export function norm(text: string): string {
	return text.indexOf('\r') === -1 ? text : text.replace(/\r\n?/g, '\n');
}

export function splitLines(text: string): string[] {
	return norm(text).split('\n');
}

export interface Hunk {
	readonly id: string;
	/** 0-based start line in the original. */
	readonly origStart: number;
	readonly origCount: number;
	/** 0-based start line in the current text. */
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

/** Smallest single replacement turning `oldText` into `newText` (keeps cursors and folds outside it intact). */
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

/** Convert `\n` text to the document EOL. */
export function withEol(text: string, eol: '\n' | '\r\n'): string {
	return eol === '\n' ? norm(text) : norm(text).replace(/\n/g, '\r\n');
}
