/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Cmd+K region math and prompt building. No vscode import.
 *--------------------------------------------------------------------------------------------*/

export interface Sel { startLine: number; startCol: number; endLine: number; endCol: number }

export interface Region {
	/** 'lines' replaces whole lines; 'cursor' inserts at a point in a non-blank line. */
	kind: 'lines' | 'cursor';
	start: number; // offsets into the document text
	end: number;
	startLine: number;
	endLine: number;
	before: string;
	selected: string;
	after: string;
}

function lineStarts(text: string): number[] {
	const starts = [0];
	for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) { starts.push(i + 1); }
	return starts;
}

function lineEnd(text: string, starts: number[], line: number): number {
	const next = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
	return next > starts[line] && text[next - 1] === '\r' && line + 1 < starts.length ? next - 1 : next;
}

export function computeRegion(text: string, sel: Sel): Region {
	const starts = lineStarts(text);
	const last = starts.length - 1;
	const clamp = (n: number) => Math.max(0, Math.min(last, n));
	const sl = clamp(sel.startLine);
	let el = clamp(sel.endLine);
	const empty = sel.startLine === sel.endLine && sel.startCol === sel.endCol;
	if (empty) {
		const lineText = text.slice(starts[sl], lineEnd(text, starts, sl));
		if (lineText.trim() !== '') {
			const off = Math.min(starts[sl] + sel.startCol, lineEnd(text, starts, sl));
			return { kind: 'cursor', start: off, end: off, startLine: sl, endLine: sl, before: text.slice(0, off), selected: '', after: text.slice(off) };
		}
	} else if (sel.endCol === 0 && el > sl) {
		el -= 1;
	}
	const start = starts[sl];
	const end = lineEnd(text, starts, el);
	return { kind: 'lines', start, end, startLine: sl, endLine: el, before: text.slice(0, start), selected: text.slice(start, end), after: text.slice(end) };
}

/** Last `maxLines` lines of s, including a final partial line. */
export function tailLines(s: string, maxLines: number): string {
	let idx = s.endsWith('\n') ? s.length - 1 : s.length;
	for (let n = 0; n < maxLines; n++) {
		idx = s.lastIndexOf('\n', idx - 1);
		if (idx < 0) { return s; }
	}
	return s.slice(idx + 1);
}

export function headLines(s: string, maxLines: number): string {
	let idx = -1;
	for (let n = 0; n < maxLines; n++) {
		idx = s.indexOf('\n', idx + 1);
		if (idx < 0) { return s; }
	}
	return s.slice(0, idx);
}

export interface InlinePromptInput {
	path: string;
	languageId: string;
	region: Region;
	instructions: string[]; // oldest first; last = current
	rules: { name: string; content: string }[];
	contextLines?: number;
}

export const INLINE_SYSTEM = [
	'You are the code editing engine behind an editor\'s Cmd+K. You rewrite a selected region of a file according to the user\'s instruction.',
	'Output rules:',
	'- Reply with exactly ONE fenced code block containing ONLY the new code for the region. No explanation before or after.',
	'- For a region of lines, output the complete replacement lines (keep the original indentation style). Do not include the surrounding context lines.',
	'- When told to insert at <CURSOR>, output only the text to insert at that point (it may span several lines).',
	'- Do not add comments about what you changed unless asked. Preserve everything that does not need to change.',
].join('\n');

export function buildInlinePrompt(i: InlinePromptInput): string {
	const n = i.contextLines ?? 150;
	const r = i.region;
	const parts: string[] = [];
	if (i.rules.length) {
		let budget = 6000;
		const rs: string[] = [];
		for (const rule of i.rules) {
			const c = rule.content.trim().slice(0, Math.min(2000, budget));
			if (!c) { continue; }
			rs.push(`## ${rule.name}\n${c}`);
			budget -= c.length;
			if (budget <= 0) { break; }
		}
		if (rs.length) { parts.push(`<rules>\n${rs.join('\n\n')}\n</rules>`); }
	}
	parts.push(`File: ${i.path}\nLanguage: ${i.languageId}`);
	const before = tailLines(r.before, n);
	const after = headLines(r.after, n);
	if (r.kind === 'cursor') {
		parts.push(`Code around the cursor (the text to produce goes at <CURSOR>):\n\`\`\`\n${before}<CURSOR>${after}\n\`\`\``);
	} else {
		parts.push(`<before>\n${before}</before>`);
		if (r.selected.trim() === '') {
			parts.push('<selected>\n(blank line: write new code here, at the right indentation)\n</selected>');
		} else {
			parts.push(`<selected>\n${r.selected}\n</selected>`);
		}
		parts.push(`<after>\n${after}\n</after>`);
	}
	if (i.instructions.length > 1) {
		const prev = i.instructions.slice(0, -1).map((p, k) => `${k + 1}. ${p}`).join('\n');
		parts.push(`The selected code is already the result of these earlier instructions:\n${prev}`);
		parts.push(`New follow-up instruction:\n${i.instructions[i.instructions.length - 1]}`);
	} else {
		parts.push(`Instruction:\n${i.instructions[0]}`);
	}
	parts.push(r.kind === 'cursor'
		? 'Reply with one fenced code block containing only the text to insert at <CURSOR>.'
		: 'Reply with one fenced code block containing only the replacement for <selected>.');
	return parts.join('\n\n');
}
