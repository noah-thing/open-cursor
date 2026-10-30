/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Terminal Cmd+K pure logic: ANSI stripping, output ring buffer, prompt, command cleanup.
 *--------------------------------------------------------------------------------------------*/

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]|\u001b[=>]|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

export function stripAnsi(s: string): string {
	return s.replace(ANSI, '').replace(/\r\n/g, '\n').replace(/[^\n]*\r(?!\n)/g, '');
}

const MAX_LINE = 4000;

export class OutputBuffer {
	private lines: string[] = [''];
	constructor(private readonly max = 200) { }
	append(chunk: string): void {
		const parts = stripAnsi(chunk).split('\n');
		this.lines[this.lines.length - 1] += parts[0];
		for (let i = 1; i < parts.length; i++) { this.lines.push(parts[i]); }
		// one endless line (a minified file, a progress bar) must not grow memory without limit
		for (let i = Math.max(0, this.lines.length - parts.length); i < this.lines.length; i++) {
			if (this.lines[i].length > MAX_LINE) { this.lines[i] = this.lines[i].slice(0, MAX_LINE); }
		}
		if (this.lines.length > this.max) { this.lines.splice(0, this.lines.length - this.max); }
	}
	tail(n: number): string {
		return this.lines.slice(-n).join('\n').replace(/\s+$/, '');
	}
}

export const TERMINAL_SYSTEM = 'You turn a description into ONE shell command for the user\'s terminal. Reply with only the command in a single line (use && or pipes when needed, no line breaks except inside quotes), no explanation, no markdown, no prompt symbol. Use tools that exist on the stated OS. Prefer safe, non destructive flags unless the user asks otherwise.';

export interface TerminalContext { os: string; shell: string; cwd: string; output: string }

export function buildTerminalPrompt(request: string, c: TerminalContext): string {
	const out = c.output.trim() ? `\n\nRecent terminal output (last lines):\n${c.output.trim().slice(-4000)}` : '';
	return `OS: ${c.os}\nShell: ${c.shell}\nWorking directory: ${c.cwd}${out}\n\nDescription: ${request}\n\nCommand:`;
}

/** Strip fences, prompt chars and quotes a model may wrap around the command. */
export function cleanCommand(raw: string): string {
	let t = raw.trim();
	const fence = /^```[\w-]*\r?\n([\s\S]*?)\r?\n?```/.exec(t);
	if (fence) { t = fence[1]; }
	else { t = t.replace(/^```[\w-]*\s*/, '').replace(/```\s*$/, ''); }
	const lines = t.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
	t = lines.join(' ').trim();
	if (/^`[^`]+`$/.test(t)) { t = t.slice(1, -1); }
	t = t.replace(/^[$>]\s+/, '');
	return t;
}
