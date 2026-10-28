/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { primaryRoot, toDisplayPath } from '../../context/paths';
import { baseName, num, str, type ToolDef } from './types';
import { msg, resolveForRead } from './fsutil';

interface Args { path?: string; depth?: number }

const SKIP = new Set(['node_modules', '.git', '.DS_Store', '__pycache__', '.next', '.venv']);
const MAX_ENTRIES = 300;

export const listDir: ToolDef<Args> = {
	readOnly: true,
	schema: {
		name: 'list_dir',
		description: 'List the contents of a directory (directories end with /). Skips node_modules and .git. Use depth 2-3 for a quick tree.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Directory, workspace-relative or absolute. Defaults to the workspace root.' },
				depth: { type: 'integer', description: 'How many levels to show (1-4, default 1).' },
			},
		},
	},
	async run(args, ctx) {
		const p = str(args.path) || '.';
		let uri: vscode.Uri | undefined;
		if (p === '.' || p === '') {
			uri = primaryRoot();
		} else {
			const target = await resolveForRead(p, ctx, 'listing a directory');
			if ('error' in target) { return { content: target.error, isError: true }; }
			uri = target.uri;
		}
		if (!uri) { return { content: 'No workspace folder is open.', isError: true }; }
		const maxDepth = Math.min(4, Math.max(1, Math.floor(num(args.depth) ?? 1)));
		const lines: string[] = [];
		let count = 0;
		const walk = async (dir: vscode.Uri, depth: number, prefix: string): Promise<void> => {
			const entries = await vscode.workspace.fs.readDirectory(dir);
			entries.sort((a, b) => Number(!!(b[1] & vscode.FileType.Directory)) - Number(!!(a[1] & vscode.FileType.Directory)) || a[0].localeCompare(b[0]));
			for (const [name, type] of entries) {
				if (SKIP.has(name)) { continue; }
				if (count >= MAX_ENTRIES) { return; }
				count++;
				const isDir = !!(type & vscode.FileType.Directory);
				lines.push(`${prefix}${name}${isDir ? '/' : ''}`);
				if (isDir && depth < maxDepth) { await walk(vscode.Uri.joinPath(dir, name), depth + 1, prefix + '  '); }
			}
		};
		try {
			await walk(uri, 1, '');
		} catch (e) {
			return { content: `Cannot list ${p}: ${msg(e)}`, isError: true };
		}
		if (!lines.length) { return { content: `${toDisplayPath(uri) || '.'} is empty.` }; }
		if (count >= MAX_ENTRIES) { lines.push(`[... truncated at ${MAX_ENTRIES} entries]`); }
		return { content: lines.join('\n'), output: `${count} entries` };
	},
	title(args, status, r) {
		const n = baseName(args.path) || 'workspace';
		return status === 'done' ? `Listed ${n}${r?.output ? ` · ${r.output}` : ''}` : `Listing ${n}`;
	},
};
