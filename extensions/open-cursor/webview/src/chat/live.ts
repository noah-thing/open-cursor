/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Words for what the agent is doing right now: the live reasoning and the running tool. Pure, so tested.
 *--------------------------------------------------------------------------------------------*/

import type { ToolPart } from '../../../src/shared/protocol';
import { basename } from './util';

/** The newest part of the reasoning as plain paragraphs: markdown marks removed, cut at a paragraph so it never starts mid word. */
export function thoughtTail(text: string, max = 2400): string[] {
	let t = text.length > max ? text.slice(-max) : text;
	if (text.length > max) {
		const cut = t.search(/\n\s*\n/);
		t = cut >= 0 && cut < max * 0.75 ? t.slice(cut) : t.slice(t.indexOf(' ') + 1);
	}
	return t.replace(/\*\*|__|`|^#+\s*/gm, '').split(/\n\s*\n/).map(p => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/** What a running tool is doing, in words: "Reading cart.ts", "Searching for removeItem", "Running npm test". */
export function toolActivity(t: ToolPart): string | undefined {
	const a = t.args ?? {};
	switch (t.name) {
		case 'read_file': return str(a.path) ? 'Reading ' + basename(str(a.path)) : 'Reading a file';
		case 'list_dir': return str(a.path) && str(a.path) !== '.' ? 'Looking in ' + basename(str(a.path)) : 'Looking around the project';
		case 'grep': return str(a.pattern) ? 'Searching for ' + clip(str(a.pattern), 36) : 'Searching';
		case 'glob_file_search': return str(a.glob_pattern) ? 'Finding ' + clip(str(a.glob_pattern), 36) : 'Finding files';
		case 'codebase_search': return str(a.query) ? 'Searching the codebase for ' + clip(str(a.query), 32) : 'Searching the codebase';
		case 'read_lints': return 'Checking for errors';
		case 'fetch_url': {
			try { return 'Reading ' + new URL(str(a.url)).hostname.replace(/^www\./, ''); } catch { return 'Reading a web page'; }
		}
		case 'web_search': return 'Searching the web';
		case 'todo_write': return 'Planning';
	}
	const cmd = t.command?.text || (t.name === 'run_terminal_cmd' ? str(a.command) : '');
	if (cmd) { return 'Running ' + clip(cmd.split('\n')[0], 44); }
	if (t.name.startsWith('mcp_')) { return 'Using ' + t.name.slice(4).split('_')[0]; }
	return undefined;
}

