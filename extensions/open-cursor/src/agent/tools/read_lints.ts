/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { formatDiagnostics } from '../../context/diagnostics';
import { resolvePath } from '../../context/paths';
import type { ToolDef } from './types';

interface Args { paths?: string[] }

export const readLints: ToolDef<Args> = {
	readOnly: true,
	schema: {
		name: 'read_lints',
		description: 'Read current errors and warnings from the editor language servers (TypeScript, ESLint, etc.) for files, or for the whole workspace when no paths are given. Run after editing to check your work.',
		parameters: {
			type: 'object',
			properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Files or directories to check. Omit for the whole workspace.' } },
		},
	},
	async run(args) {
		const paths = Array.isArray(args.paths) ? args.paths.filter(p => typeof p === 'string' && p) : [];
		let r;
		if (paths.length) {
			const resolved = paths.map(p => resolvePath(p).uri.toString().replace(/\/$/, ''));
			const uris = vscode.languages.getDiagnostics()
				.filter(([u, d]) => d.length > 0 && resolved.some(prefix => { const k = u.toString(); return k === prefix || k.startsWith(prefix + '/'); }))
				.map(([u]) => u);
			r = formatDiagnostics({ uris });
		} else {
			r = formatDiagnostics({});
		}
		return r.count ? { content: r.text, output: `${r.count} problems` } : { content: 'No errors or warnings.', output: 'clean' };
	},
	title(args, status, r) {
		const target = args.paths?.length === 1 ? args.paths[0].split('/').pop() : args.paths?.length ? `${args.paths.length} files` : 'workspace';
		return status === 'done' ? `Checked lints ${target}${r?.output ? ` · ${r.output}` : ''}` : `Checking lints ${target}`;
	},
};
