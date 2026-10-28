/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  edit_file matching: exact replace with a whitespace tolerant fallback and precise failure
 *  messages. Pure (no vscode import).
 *--------------------------------------------------------------------------------------------*/

export type EditOutcome =
	| { ok: true; content: string; replacements: number; fuzzy: boolean }
	| { ok: false; error: string };

function detectEol(s: string): '\r\n' | '\n' {
	const crlf = (s.match(/\r\n/g) ?? []).length;
	const lf = (s.match(/\n/g) ?? []).length - crlf;
	return crlf > lf ? '\r\n' : '\n';
}

function countOccurrences(hay: string, needle: string): number {
	if (!needle) { return 0; }
	let n = 0;
	let i = 0;
	while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
	return n;
}

const LINE_PREFIX = /^\s*\d+\|/;

/** Removes `  12|` prefixes copied from read_file output, only when every non-empty line has one. */
export function stripLineNumberPrefixes(s: string): string | undefined {
	const lines = s.split('\n');
	const nonEmpty = lines.filter(l => l.trim() !== '');
	if (nonEmpty.length === 0 || !nonEmpty.every(l => LINE_PREFIX.test(l))) { return undefined; }
	return lines.map(l => l.replace(LINE_PREFIX, '')).join('\n');
}

function leadingWs(s: string): string {
	return /^[ \t]*/.exec(s)![0];
}

function normLine(s: string): string {
	return s.trim().replace(/[ \t]+/g, ' ');
}

interface Window { start: number; end: number } // end exclusive, line indices

function findLineWindows(fileLines: string[], oldLines: string[]): Window[] {
	const target = oldLines.map(normLine);
	const out: Window[] = [];
	for (let i = 0; i + target.length <= fileLines.length; i++) {
		let ok = true;
		for (let j = 0; j < target.length; j++) {
			if (normLine(fileLines[i + j]) !== target[j]) { ok = false; break; }
		}
		if (ok) { out.push({ start: i, end: i + target.length }); }
	}
	return out;
}

/** Re-indent `replacement` so it lines up with how the file indents the matched region. */
function reindent(replacement: string[], oldFirst: string, fileFirst: string): string[] {
	const oldIndent = leadingWs(oldFirst);
	const fileIndent = leadingWs(fileFirst);
	if (oldIndent === fileIndent) { return replacement; }
	return replacement.map(l => {
		if (l.trim() === '') { return l; }
		if (l.startsWith(oldIndent)) { return fileIndent + l.slice(oldIndent.length); }
		return l;
	});
}

function similarity(a: string, b: string): number {
	if (a === b) { return 1; }
	if (!a || !b) { return 0; }
	const grams = (s: string) => {
		const m = new Map<string, number>();
		for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); }
		return m;
	};
	const ga = grams(a);
	const gb = grams(b);
	let inter = 0;
	for (const [g, n] of ga) { inter += Math.min(n, gb.get(g) ?? 0); }
	return (2 * inter) / (Math.max(a.length - 1, 1) + Math.max(b.length - 1, 1));
}

/** Best matching window for an error message. */
export function closestRegion(fileLines: string[], oldLines: string[]): { start: number; end: number; score: number } | undefined {
	if (!fileLines.length || !oldLines.length) { return undefined; }
	const target = oldLines.map(normLine);
	const n = Math.min(target.length, fileLines.length);
	const norm = fileLines.map(normLine);
	let best: { start: number; score: number } | undefined;
	// Anchor on lines of the target that appear somewhere to keep this cheap on big files.
	const targetSet = new Set(target.filter(t => t.length > 2));
	const candidates: number[] = [];
	for (let i = 0; i < norm.length; i++) {
		if (targetSet.has(norm[i])) { candidates.push(i); }
	}
	const starts = new Set<number>();
	for (const c of candidates) {
		for (let k = 0; k < n; k++) { if (c - k >= 0 && c - k + n <= norm.length) { starts.add(c - k); } }
	}
	if (starts.size === 0) {
		// No shared whole line: fall back to the best similar first line.
		for (let i = 0; i + n <= norm.length; i++) { starts.add(i); }
		if (starts.size > 4000) { return undefined; }
	}
	for (const s of starts) {
		let score = 0;
		for (let j = 0; j < n; j++) { score += similarity(norm[s + j], target[j]); }
		score /= n;
		if (!best || score > best.score) { best = { start: s, score }; }
	}
	return best && best.score > 0.35 ? { start: best.start, end: best.start + n, score: best.score } : undefined;
}

function describeDifference(fileLines: string[], oldLines: string[], start: number): string {
	for (let j = 0; j < oldLines.length && start + j < fileLines.length; j++) {
		const a = fileLines[start + j];
		const b = oldLines[j];
		if (a !== b) {
			if (a.trim() === b.trim()) { return `line ${start + j + 1} differs only in indentation/whitespace (file has ${JSON.stringify(leadingWs(a))} indent).`; }
			return `first difference at line ${start + j + 1}: file has ${JSON.stringify(a.slice(0, 160))} but old_string has ${JSON.stringify(b.slice(0, 160))}.`;
		}
	}
	return 'old_string is longer than the matching region.';
}

export function applyEdit(content: string, oldString: string, newString: string, replaceAll = false): EditOutcome {
	if (oldString === newString) {
		return { ok: false, error: 'old_string and new_string are identical; nothing to change.' };
	}
	const eol = detectEol(content);
	let oldS = oldString;
	let newS = newString;
	if (eol === '\r\n') {
		oldS = oldS.replace(/\r?\n/g, '\r\n');
		newS = newS.replace(/\r?\n/g, '\r\n');
	} else {
		oldS = oldS.replace(/\r\n/g, '\n');
		newS = newS.replace(/\r\n/g, '\n');
	}
	if (oldS === '') {
		if (content === '') { return { ok: true, content: newS, replacements: 1, fuzzy: false }; }
		return { ok: false, error: 'old_string is empty but the file is not. Provide the text to replace, or use write_file to overwrite the whole file.' };
	}

	// 1. exact
	const exact = countOccurrences(content, oldS);
	// A match that starts inside a line's indentation would leave new_string mis-indented: let the line based path handle it.
	const midIndent = exact === 1 && /^[ \t]/.test(oldS) && /[ \t]/.test(content[content.indexOf(oldS) - 1] ?? '');
	if ((exact === 1 && !midIndent) || (exact > 1 && replaceAll)) {
		const out = replaceAll ? content.split(oldS).join(newS) : content.replace(oldS, () => newS);
		return { ok: true, content: out, replacements: exact, fuzzy: false };
	}
	if (exact > 1) {
		return { ok: false, error: `old_string matches ${exact} places in the file. Add surrounding lines to make it unique, or set replace_all to true to change every occurrence.` };
	}

	// 2. line number prefixes copied from read_file
	const stripped = stripLineNumberPrefixes(oldS);
	if (stripped !== undefined) {
		const strippedNew = stripLineNumberPrefixes(newS) ?? newS;
		const c = countOccurrences(content, stripped);
		if (c === 1 || (c > 1 && replaceAll)) {
			const out = replaceAll ? content.split(stripped).join(strippedNew) : content.replace(stripped, () => strippedNew);
			return { ok: true, content: out, replacements: c, fuzzy: true };
		}
	}

	// 3. whitespace tolerant, line based
	const fileLines = content.split(eol);
	let oldLines = oldS.split(eol);
	let newLines = newS.split(eol);
	while (oldLines.length > 1 && oldLines[0].trim() === '') { oldLines = oldLines.slice(1); }
	while (oldLines.length > 1 && oldLines[oldLines.length - 1].trim() === '') { oldLines = oldLines.slice(0, -1); }
	if (oldLines.length && oldLines.some(l => l.trim() !== '')) {
		const wins = findLineWindows(fileLines, oldLines);
		if (wins.length === 1 || (wins.length > 1 && replaceAll)) {
			let result = fileLines.slice();
			// apply from the bottom so indices stay valid
			for (const w of [...wins].sort((a, b) => b.start - a.start)) {
				const rep = reindent(newLines, oldLines[0], fileLines[w.start]);
				result = [...result.slice(0, w.start), ...rep, ...result.slice(w.end)];
			}
			return { ok: true, content: result.join(eol), replacements: wins.length, fuzzy: true };
		}
		if (wins.length > 1) {
			return { ok: false, error: `old_string matches ${wins.length} places when ignoring whitespace. Add surrounding lines to make it unique, or set replace_all to true.` };
		}
	}

	if (midIndent) {
		return { ok: true, content: content.replace(oldS, () => newS), replacements: 1, fuzzy: false };
	}

	// 4. failure with the closest region
	const region = closestRegion(fileLines, oldLines);
	if (!region) {
		return { ok: false, error: 'old_string was not found in the file and nothing similar exists. Re-read the file with read_file and copy the text exactly.' };
	}
	const ctxStart = Math.max(0, region.start - 1);
	const ctxEnd = Math.min(fileLines.length, region.end + 1);
	const snippet = fileLines.slice(ctxStart, ctxEnd).map((l, i) => `${ctxStart + i + 1}|${l.length > 300 ? l.slice(0, 300) + '…' : l}`).join('\n');
	return {
		ok: false,
		error: `old_string was not found. Closest region is lines ${region.start + 1}-${region.end}:\n${snippet}\nDifference: ${describeDifference(fileLines, oldLines, region.start)}\nCopy the text exactly from the file (without the "N|" line prefixes) and retry.`,
	};
}
