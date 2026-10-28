/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as nodePath from 'path';
import { spawn } from 'child_process';
import { primaryRoot, resolvePath } from '../../context/paths';
import { bool, clip, num, str, type ToolDef } from './types';
import { msg } from './fsutil';

interface Args {
	pattern?: string; path?: string; glob?: string; case_insensitive?: boolean;
	output_mode?: 'content' | 'files_with_matches' | 'count'; context?: number; head_limit?: number; multiline?: boolean;
}

let rgPath: string | undefined;

export function findRipgrep(): string {
	if (rgPath) { return rgPath; }
	const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
	const root = vscode.env.appRoot;
	const candidates = [
		nodePath.join(root, 'node_modules', '@vscode', 'ripgrep', 'bin', exe),
		nodePath.join(root, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe),
	];
	rgPath = candidates.find(c => { try { return fs.existsSync(c); } catch { return false; } }) ?? 'rg';
	return rgPath;
}

export function runRipgrep(args: string[], cwd: string, signal: AbortSignal, maxLines: number): Promise<{ lines: string[]; code: number | null; stderr: string; truncated: boolean }> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) { reject(new Error('aborted')); return; }
		const child = spawn(findRipgrep(), args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		const lines: string[] = [];
		let buf = '';
		let stderr = '';
		let truncated = false;
		const onAbort = () => child.kill('SIGKILL');
		signal.addEventListener('abort', onAbort, { once: true });
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (d: string) => {
			buf += d;
			let i: number;
			while ((i = buf.indexOf('\n')) !== -1) {
				lines.push(buf.slice(0, i));
				buf = buf.slice(i + 1);
				if (lines.length >= maxLines) {
					truncated = true;
					child.kill('SIGKILL');
					return;
				}
			}
		});
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (d: string) => { if (stderr.length < 4000) { stderr += d; } });
		child.on('error', err => { signal.removeEventListener('abort', onAbort); reject(err); });
		child.on('close', code => {
			signal.removeEventListener('abort', onAbort);
			if (buf && !truncated) { lines.push(buf); }
			resolve({ lines, code, stderr, truncated });
		});
	});
}

export const grep: ToolDef<Args> = {
	readOnly: true,
	schema: {
		name: 'grep',
		description: 'Search file contents with ripgrep (regex). Respects .gitignore. Use for exact symbols and strings; use codebase_search for concepts.',
		parameters: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: 'Regular expression (ripgrep / Rust syntax).' },
				path: { type: 'string', description: 'File or directory to search (default: workspace).' },
				glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts".' },
				case_insensitive: { type: 'boolean' },
				output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Default content.' },
				context: { type: 'integer', description: 'Lines of context around each match (content mode).' },
				head_limit: { type: 'integer', description: 'Max output lines (default 250).' },
				multiline: { type: 'boolean', description: 'Let patterns span lines.' },
			},
			required: ['pattern'],
		},
	},
	async run(args, ctx) {
		const pattern = str(args.pattern);
		if (!pattern) { return { content: 'Missing required argument: pattern', isError: true }; }
		const root = primaryRoot();
		if (!root || root.scheme !== 'file') { return { content: 'Search needs a local workspace folder.', isError: true }; }
		const mode = args.output_mode ?? 'content';
		const limit = Math.min(1000, Math.max(1, Math.floor(num(args.head_limit) ?? 250)));
		const rgArgs = ['--no-heading', '--with-filename', '--color', 'never', '--max-columns', '300', '--max-columns-preview', '--hidden', '-g', '!.git', '--max-filesize', '2M'];
		if (bool(args.case_insensitive)) { rgArgs.push('-i'); }
		if (bool(args.multiline)) { rgArgs.push('-U', '--multiline-dotall'); }
		if (mode === 'files_with_matches') { rgArgs.push('-l'); }
		else if (mode === 'count') { rgArgs.push('-c'); }
		else {
			rgArgs.push('--line-number');
			const c = num(args.context);
			if (c && c > 0) { rgArgs.push('-C', String(Math.min(10, Math.floor(c)))); }
		}
		if (args.glob) { rgArgs.push('-g', args.glob); }
		rgArgs.push('-e', pattern, '--', args.path ? resolvePath(args.path).uri.fsPath : '.');
		try {
			const r = await runRipgrep(rgArgs, root.fsPath, ctx.signal, limit);
			if (r.code !== 0 && r.code !== 1 && !r.truncated) {
				return { content: `ripgrep error: ${r.stderr.trim() || `exit ${r.code}`}`, isError: true };
			}
			if (!r.lines.length) { return { content: 'No matches found.', output: '0 matches' }; }
			const cleaned = r.lines.map(l => l.replace(/^\.\//, ''));
			let out = cleaned.join('\n');
			if (r.truncated) { out += `\n[Output limited to ${limit} lines. Narrow the pattern or path, or raise head_limit.]`; }
			const n = mode === 'content' ? cleaned.filter(l => /^.+?:\d+:/.test(l)).length : cleaned.length;
			return { content: out, output: mode === 'content' ? `${n} matches` : `${n} files` };
		} catch (e) {
			if (ctx.signal.aborted) { return { content: 'Search cancelled.', isError: true }; }
			const m = msg(e);
			return { content: /ENOENT/.test(m) ? 'ripgrep (rg) was not found. Use glob_file_search and read_file instead.' : `grep failed: ${m}`, isError: true };
		}
	},
	title(args, status, r) {
		const p = clip(args.pattern ?? '', 40);
		return status === 'done' ? `Grepped \`${p}\`${r?.output ? ` · ${r.output}` : ''}` : `Grepping \`${p}\``;
	},
};
