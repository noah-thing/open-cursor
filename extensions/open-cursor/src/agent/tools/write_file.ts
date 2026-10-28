/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { baseName, str, type ToolDef } from './types';
import { capture, exists, msg, readDocumentText, resolveForWrite, toDisplayPath } from './fsutil';

interface Args { path?: string; contents?: string }

export const writeFile: ToolDef<Args> = {
	readOnly: false,
	schema: {
		name: 'write_file',
		description: 'Create a file or overwrite it with the full contents. Parent directories are created. For changes to an existing file prefer edit_file. Changes land as pending edits the user can keep or undo.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Workspace-relative or absolute path.' },
				contents: { type: 'string', description: 'Complete file contents.' },
			},
			required: ['path', 'contents'],
		},
	},
	async run(args, ctx) {
		const p = str(args.path);
		if (!p) { return { content: 'Missing required argument: path', isError: true }; }
		if (typeof args.contents !== 'string') { return { content: 'contents must be a string.', isError: true }; }
		const target = await resolveForWrite(p, ctx, 'writing a file');
		if ('error' in target) { return { content: target.error, isError: true }; }
		const { uri } = target;
		try {
			const type = await exists(uri);
			if (type !== undefined && (type & vscode.FileType.Directory)) { return { content: `${p} is a directory.`, isError: true }; }
			const before = type === undefined ? undefined : await readDocumentText(uri);
			if (type !== undefined && (before === undefined || before.slice(0, 8000).includes('\u0000'))) {
				return { content: `${p} exists but cannot be read as text (binary or too large); refusing to overwrite it.`, isError: true };
			}
			if (before === args.contents) { return { content: `${toDisplayPath(uri)} already has exactly this content.` }; }
			capture(ctx, uri, before);
			const r = await ctx.services.pendingEdits.applyContent(uri, args.contents, 'agent', ctx.chatId, undefined, before ?? null);
			const where = toDisplayPath(uri);
			return {
				content: `${r.isNew ? 'Created' : 'Overwrote'} ${where}: +${r.added} -${r.removed}.`,
				edit: { uri: uri.toString(), path: where, added: r.added, removed: r.removed, isNew: r.isNew },
			};
		} catch (e) {
			return { content: `Write failed for ${p}: ${msg(e)}`, isError: true };
		}
	},
	title(args, status, r) {
		const n = baseName(args.path);
		if (status === 'done' && r?.edit) { return `${r.edit.isNew ? 'Created' : 'Wrote'} ${n} +${r.edit.added} -${r.edit.removed}`; }
		return status === 'error' ? `Write failed ${n}` : `Writing ${n}`;
	},
};
