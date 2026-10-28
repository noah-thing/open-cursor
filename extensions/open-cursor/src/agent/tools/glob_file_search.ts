/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { toDisplayPath } from '../../context/paths';
import { clip, str, type ToolDef } from './types';
import { msg, resolveForRead } from './fsutil';

interface Args { glob_pattern?: string; target_directory?: string }

const MAX_RESULTS = 200;

export const globFileSearch: ToolDef<Args> = {
	readOnly: true,
	schema: {
		name: 'glob_file_search',
		description: 'Find files by glob pattern (e.g. "**/*.test.ts", "src/**/index.ts"). Patterns without "/" match at any depth. Results are sorted by most recently modified. Ignores node_modules and .git.',
		parameters: {
			type: 'object',
			properties: {
				glob_pattern: { type: 'string', description: 'Glob pattern.' },
				target_directory: { type: 'string', description: 'Directory to search in (default: workspace).' },
			},
			required: ['glob_pattern'],
		},
	},
	async run(args, ctx) {
		let pattern = str(args.glob_pattern);
		if (!pattern) { return { content: 'Missing required argument: glob_pattern', isError: true }; }
		if (!pattern.includes('/') && !pattern.startsWith('**')) { pattern = `**/${pattern}`; }
		try {
			const cts = new vscode.CancellationTokenSource();
			ctx.signal.addEventListener('abort', () => cts.cancel(), { once: true });
			let found: vscode.Uri[];
			let searchDir: vscode.Uri | undefined;
			if (args.target_directory) {
				const target = await resolveForRead(args.target_directory, ctx, 'searching files');
				if ('error' in target) { return { content: target.error, isError: true }; }
				searchDir = target.uri;
			}
			const exclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/__pycache__/**}';
			try {
				if (searchDir) {
					found = await vscode.workspace.findFiles(new vscode.RelativePattern(searchDir, pattern), exclude, 1000, cts.token);
				} else {
					found = await vscode.workspace.findFiles(pattern, exclude, 1000, cts.token);
				}
			} finally {
				cts.dispose();
			}
			const stats = await Promise.all(found.map(async u => {
				try { return { u, mtime: (await vscode.workspace.fs.stat(u)).mtime }; } catch { return { u, mtime: 0 }; }
			}));
			stats.sort((a, b) => b.mtime - a.mtime);
			if (!stats.length) { return { content: `No files match ${pattern}`, output: '0 files' }; }
			const shown = stats.slice(0, MAX_RESULTS).map(s => toDisplayPath(s.u));
			let out = shown.join('\n');
			if (stats.length > MAX_RESULTS) { out += `\n[... ${stats.length - MAX_RESULTS} more files not shown]`; }
			return { content: out, output: `${stats.length} files` };
		} catch (e) {
			return { content: `Glob failed: ${msg(e)}`, isError: true };
		}
	},
	title(args, status, r) {
		const p = clip(args.glob_pattern ?? '', 40);
		return status === 'done' ? `Globbed \`${p}\`${r?.output ? ` · ${r.output}` : ''}` : `Searching files \`${p}\``;
	},
};
