/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Pure logic for Tab completion, no vscode import.
 *--------------------------------------------------------------------------------------------*/

export const DEFAULT_PREFIX_CHARS = 8000; // ~2000 tokens, upper bound ~3000
export const DEFAULT_SUFFIX_CHARS = 2800; // ~700 tokens
export const HEADER_BUDGET_CHARS = 1400;

export interface Window { prefix: string; suffix: string; prefixTruncated: boolean; suffixTruncated: boolean }

/** Takes up to `maxPrefix` chars before and `maxSuffix` after the offset, cutting at line boundaries. */
export function extractWindow(text: string, offset: number, maxPrefix = DEFAULT_PREFIX_CHARS, maxSuffix = DEFAULT_SUFFIX_CHARS): Window {
	let prefix = text.slice(0, offset);
	let suffix = text.slice(offset);
	let prefixTruncated = false;
	let suffixTruncated = false;
	if (prefix.length > maxPrefix) {
		prefix = prefix.slice(prefix.length - maxPrefix);
		const nl = prefix.indexOf('\n');
		if (nl >= 0 && nl < prefix.length - 1) { prefix = prefix.slice(nl + 1); }
		prefixTruncated = true;
	}
	if (suffix.length > maxSuffix) {
		suffix = suffix.slice(0, maxSuffix);
		const nl = suffix.lastIndexOf('\n');
		if (nl > 0) { suffix = suffix.slice(0, nl); }
		suffixTruncated = true;
	}
	return { prefix, suffix, prefixTruncated, suffixTruncated };
}

export interface Snippet { path: string; text: string }

const HASH = new Set(['python', 'ruby', 'shellscript', 'bash', 'zsh', 'yaml', 'toml', 'perl', 'r', 'makefile', 'dockerfile', 'powershell', 'elixir', 'properties', 'ini']);
const DASH = new Set(['lua', 'sql', 'haskell']);
const SEMI = new Set(['lisp', 'clojure', 'scheme']);

export function commentLeader(languageId: string): string {
	if (HASH.has(languageId)) { return '#'; }
	if (DASH.has(languageId)) { return '--'; }
	if (SEMI.has(languageId)) { return ';'; }
	if (languageId === 'html' || languageId === 'xml' || languageId === 'markdown') { return ''; }
	return '//';
}

/** Comment header with path, language and recent snippets. Empty for languages without line comments. */
export function buildHeader(path: string, languageId: string, snippets: Snippet[], budget = HEADER_BUDGET_CHARS): string {
	const c = commentLeader(languageId);
	if (!c) { return ''; }
	const lines: string[] = [`${c} Path: ${path}`, `${c} Language: ${languageId}`];
	let used = lines.join('\n').length;
	for (const s of snippets) {
		const body = s.text.split('\n').map(l => `${c} ${l}`.trimEnd());
		const block = [`${c} Recent in ${s.path}:`, ...body];
		const len = block.join('\n').length + 1;
		if (used + len > budget) { continue; }
		lines.push(...block);
		used += len;
	}
	return lines.join('\n') + '\n';
}

const SPECIAL = /<\|?(?:fim_prefix|fim_suffix|fim_middle|endoftext|file_sep|repo_name|im_end|im_start)\|?>|<CURSOR>|\[CURSOR\]/g;

/** Strips markdown fences and special FIM tokens. */
export function cleanCompletion(raw: string): string {
	let t = raw;
	const sep = t.search(/<\|(?:file_sep|endoftext|im_end)\|>/);
	if (sep >= 0) { t = t.slice(0, sep); }
	t = t.replace(SPECIAL, '');
	const m = /^\s*```[\w+-]*\r?\n/.exec(t);
	if (m) {
		t = t.slice(m[0].length);
		const end = t.indexOf('\n```');
		if (end >= 0) { t = t.slice(0, end); }
		else if (t.endsWith('```')) { t = t.slice(0, -3); }
	}
	return t.replace(/\r\n/g, '\n');
}

/** Drops a tail of the completion that repeats what already follows the cursor. '' when all of it does. */
export function trimOverlap(completion: string, suffix: string): string {
	return trimOverlapInfo(completion, suffix).text;
}

/** Like trimOverlap, and reports how long the cut tail was. */
export function trimOverlapInfo(completion: string, suffix: string): { text: string; cut: number } {
	const c = completion.replace(/\s+$/, '');
	if (!c || !suffix) { return { text: c, cut: 0 }; }
	const max = Math.min(c.length, suffix.length, 400);
	for (let k = max; k >= 1; k--) {
		const s = suffix.slice(0, k);
		if (s.trim() === '') { continue; }
		if (c.endsWith(s)) { return { text: c.slice(0, c.length - k).replace(/[ \t]+$/, ''), cut: k }; }
	}
	// the suffix often starts with newline and indent while the model dropped the indent
	const sl = suffix.replace(/^\s+/, '');
	if (sl) {
		const max2 = Math.min(c.length, sl.length, 400);
		for (let k = max2; k >= 1; k--) {
			const s = sl.slice(0, k);
			if (/^\s*[)\]}"'`;,>]*$/.test(s) || k < 3) { continue; }
			if (c.endsWith(s) && (c.length - k === 0 || c[c.length - k - 1] === '\n' || c[c.length - k - 1] === ' ' || c[c.length - k - 1] === '\t')) {
				return { text: c.slice(0, c.length - k).replace(/\s+$/, ''), cut: k };
			}
		}
	}
	// closing lines the model repeated with different indentation
	const sufLines = suffix.split('\n').map(l => l.trim()).filter(l => l !== '');
	const cLines = c.split('\n');
	for (let n = Math.min(cLines.length, sufLines.length, 6); n >= 1; n--) {
		const tail = cLines.slice(-n).map(l => l.trim());
		if (tail.every((l, i) => l === sufLines[i] && CLOSER.test(l)) && (sameIndent(cLines.slice(-n), suffix, n) || unbalanced(c))) {
			const text = cLines.slice(0, -n).join('\n').replace(/\s+$/, '');
			return { text, cut: c.length - text.length };
		}
	}
	return { text: c, cut: 0 };
}

// a differently indented closer is the completion's own inner closer unless its brackets would otherwise be unbalanced
function sameIndent(tail: string[], suffix: string, n: number): boolean {
	const suf = suffix.split('\n').filter(l => l.trim() !== '').slice(0, n);
	return tail.every((l, i) => l.replace(/\s+$/, '') === suf[i].replace(/\s+$/, ''));
}

function unbalanced(c: string): boolean {
	let d = 0;
	for (const ch of c) {
		if (ch === '(' || ch === '[' || ch === '{') { d++; } else if (ch === ')' || ch === ']' || ch === '}') { d--; }
	}
	return d < 0;
}

export function indentOf(line: string): number {
	let n = 0;
	for (const ch of line) {
		if (ch === ' ') { n++; } else if (ch === '\t') { n += 4; } else { break; }
	}
	return n;
}

const CLOSER = /^\s*[}\])]+[;,)]*\s*$|^\s*(?:end|fi|done|esac)\s*$|^\s*<\/\w+>\s*$|^\s*\}\)?;?\s*$/;

export interface TruncateOptions { maxLines: number; baseIndent: number; midLine: boolean; final: boolean }
export interface Truncated { text: string; stopped: boolean }

/**
 * Cuts a completion at one line when the cursor is mid-line, at `maxLines`, before a blank line,
 * before a dedent below the cursor's indent, or after a block closer.
 * Unless `final`, the last unterminated line is only subject to the line limit.
 */
export function truncateCompletion(text: string, o: TruncateOptions): Truncated {
	const lines = text.split('\n');
	const out: string[] = [];
	let stopped = false;
	const lastIdx = lines.length - 1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const terminated = i < lastIdx || o.final;
		if (i > 0) {
			if (o.midLine && out.length >= 1) { stopped = true; break; }
			if (out.length >= o.maxLines) { stopped = true; break; }
			if (terminated) {
				if (line.trim() === '') {
					if (out.some(l => l.trim() !== '')) { stopped = true; break; }
				} else if (indentOf(line) < o.baseIndent) {
					if (CLOSER.test(line)) { out.push(line); stopped = true; break; }
					stopped = true; break;
				}
			}
		}
		out.push(line);
		if (i === 0 && o.midLine && lines.length > 1) { stopped = true; break; }
	}
	while (out.length > 1 && out[out.length - 1].trim() === '' && (stopped || o.final)) { out.pop(); }
	return { text: out.join('\n'), stopped };
}

export interface PostOptions extends TruncateOptions { linePrefix: string; suffix: string }

export function postProcess(raw: string, o: PostOptions): Truncated {
	let t = cleanCompletion(raw);
	t = fixIndent(t, o.linePrefix);
	const first = trimOverlapInfo(t, o.suffix);
	const r = truncateCompletion(first.text, o);
	// the model has run into the text after the cursor, so stop waiting for more
	const rejoined = first.cut >= 2 || /\n/.test(o.suffix.slice(0, first.cut));
	return { text: trimOverlap(r.text, o.suffix), stopped: r.stopped || rejoined };
}

/** When the cursor line is only whitespace and the completion repeats it, drops the duplicate. */
export function fixIndent(completion: string, linePrefix: string): string {
	if (linePrefix !== '' && linePrefix.trim() === '' && completion.startsWith(linePrefix)) {
		return completion.slice(linePrefix.length);
	}
	if (linePrefix !== '' && linePrefix.trim() === '') {
		// the model started with different whitespace: keep the user's
		const m = /^[ \t]+/.exec(completion);
		if (m && !completion.startsWith('\n')) { return completion.slice(m[0].length); }
	}
	return completion;
}

/** Suggest only when the rest of the line is blank or closing characters. */
export function restOfLineAllowsTab(lineSuffix: string): boolean {
	return /^[)\]}"'`;,:>\s]*$/.test(lineSuffix);
}

interface CacheEntry { file: string; offset: number; tail: string; suffixHead: string; completion: string }

/** LRU of completions keyed by file, offset and prefix tail. Typing through a suggestion returns the remainder. */
export class CompletionCache {
	private entries: CacheEntry[] = [];
	constructor(private readonly max = 40, private readonly tailLen = 240, private readonly suffixLen = 120) { }

	put(file: string, prefix: string, suffix: string, completion: string): void {
		this.entries = this.entries.filter(e => !(e.file === file && e.offset === prefix.length && e.tail === prefix.slice(-this.tailLen)));
		this.entries.unshift({ file, offset: prefix.length, tail: prefix.slice(-this.tailLen), suffixHead: suffix.slice(0, this.suffixLen), completion });
		if (this.entries.length > this.max) { this.entries.length = this.max; }
	}

	/** `prefix` and `suffix` are the full text before and after the cursor now. */
	get(file: string, prefix: string, suffix: string): string | undefined {
		for (let i = 0; i < this.entries.length; i++) {
			const e = this.entries[i];
			if (e.file !== file || prefix.length < e.offset) { continue; }
			const typed = prefix.slice(e.offset);
			if (typed.length > e.completion.length || !e.completion.startsWith(typed)) { continue; }
			if (prefix.slice(0, e.offset).slice(-this.tailLen) !== e.tail) { continue; }
			if (e.suffixHead !== suffix.slice(0, this.suffixLen)) { continue; }
			const rest = e.completion.slice(typed.length);
			if (!rest.trim()) { continue; }
			if (i > 0) { this.entries.splice(i, 1); this.entries.unshift(e); }
			return rest;
		}
		return undefined;
	}

	clear(): void { this.entries = []; }
}

export const CHAT_TAB_SYSTEM = 'You are a code completion engine inside an editor. The user shows code with a <CURSOR> marker. Reply with ONLY the text to insert at <CURSOR>: no explanation, no markdown fences, no repeating the code before or after the marker. Match the existing indentation and style. Prefer a short completion (one statement or a small block). If nothing useful fits, reply with nothing.';

export function buildChatTabPrompt(header: string, prefix: string, suffix: string): string {
	return `${header ? header + '\n' : ''}Complete the code at <CURSOR>:\n\n${prefix}<CURSOR>${suffix}`;
}

export const NEXT_EDIT_SYSTEM = 'You predict the developer\'s next edit. You see a file with numbered lines and the edit they just made. If the same change (rename, signature change, repeated pattern, updated call site, import) is clearly needed somewhere else in the file, answer with the replacement for that region in this exact format:\nLINES <start>-<end>\n```\n<new text for those lines>\n```\nLine numbers are 1-based and inclusive. If no obvious related edit exists, answer exactly: NONE';

export function buildNextEditPrompt(path: string, numberedWindow: string, recentEditDiff: string, cursorLine: number): string {
	return `File: ${path}\nCursor is at line ${cursorLine}.\n\nRecent edit:\n${recentEditDiff}\n\nFile (numbered):\n${numberedWindow}`;
}

export interface NextEdit { startLine: number; endLine: number; text: string }

export function parseNextEdit(raw: string, maxLine: number): NextEdit | undefined {
	if (/^\s*NONE\b/.test(raw)) { return undefined; }
	const m = /LINES\s+(\d+)\s*-\s*(\d+)\s*\r?\n```[\w+-]*\r?\n([\s\S]*?)\r?\n?```/.exec(raw);
	if (!m) { return undefined; }
	const startLine = Number(m[1]);
	const endLine = Number(m[2]);
	if (!(startLine >= 1 && endLine >= startLine && endLine <= maxLine) || endLine - startLine > 40) { return undefined; }
	return { startLine, endLine, text: m[3] };
}

export function numberLines(text: string, firstLine: number): string {
	return text.split('\n').map((l, i) => `${firstLine + i}| ${l}`).join('\n');
}
