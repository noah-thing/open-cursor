/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { baseName, str, type ToolDef } from './types';
import { capture, exists, msg, readDocumentText, resolveForWrite, toDisplayPath } from './fsutil';

interface Args { path?: string }

export const deleteFile: ToolDef<Args> = {
	readOnly: false,
	schema: {
		name: 'delete_file',
		description: 'Delete a single file. The deletion is a pending edit the user can undo. Does not delete directories.',
		parameters: {
			type: 'object',
			properties: { path: { type: 'string', description: 'Workspace-relative or absolute path.' } },
			required: ['path'],
		},
	},
	async run(args, ctx) {
		const p = str(args.path);
		if (!p) { return { content: 'Missing required argument: path', isError: true }; }
		const target = await resolveForWrite(p, ctx, 'deleting a file');
		if ('error' in target) { return { content: target.error, isError: true }; }
		const { uri } = target;
		try {
			const type = await exists(uri);
			if (type === undefined) { return { content: `File not found: ${p}`, isError: true }; }
			if (type & vscode.FileType.Directory) { return { content: `${p} is a directory; delete_file only deletes files.`, isError: true }; }
			const before = await readDocumentText(uri);
			if (before === undefined || before.slice(0, 8000).includes('\u0000')) {
				return { content: `${p} cannot be read as text (binary or too large); refusing to delete it.`, isError: true };
			}
			capture(ctx, uri, before);
			await ctx.services.pendingEdits.deleteFile(uri, ctx.chatId);
			const where = toDisplayPath(uri);
			const removed = before ? before.split('\n').length : 0;
			return { content: `Deleted ${where}.`, edit: { uri: uri.toString(), path: where, added: 0, removed, deleted: true } };
		} catch (e) {
			return { content: `Delete failed for ${p}: ${msg(e)}`, isError: true };
		}
	},
	title(args, status) {
		const n = baseName(args.path);
		return status === 'done' ? `Deleted ${n}` : status === 'error' ? `Delete failed ${n}` : `Deleting ${n}`;
	},
};
