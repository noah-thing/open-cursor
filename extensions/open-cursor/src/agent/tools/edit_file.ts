/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { applyEdit } from '../editMatch';
import { baseName, bool, str, type ToolDef } from './types';
import { capture, exists, msg, readDocumentText, resolveForWrite, toDisplayPath } from './fsutil';

interface Args { path?: string; old_string?: string; new_string?: string; replace_all?: boolean }

export const editFile: ToolDef<Args> = {
	readOnly: false,
	schema: {
		name: 'edit_file',
		description: 'Edit a file by replacing old_string with new_string. old_string must match the file text exactly (indentation included, without the "N|" line prefixes) and be unique unless replace_all is true; include a few surrounding lines for uniqueness. To create a new file pass an empty old_string, or use write_file. Always read the file first. Changes land as pending edits the user can keep or undo.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Workspace-relative or absolute path.' },
				old_string: { type: 'string', description: 'Exact text to replace.' },
				new_string: { type: 'string', description: 'Replacement text.' },
				replace_all: { type: 'boolean', description: 'Replace every occurrence (e.g. renames).' },
			},
			required: ['path', 'old_string', 'new_string'],
		},
	},
	async run(args, ctx) {
		const p = str(args.path);
		if (!p) { return { content: 'Missing required argument: path', isError: true }; }
		if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') {
			return { content: 'old_string and new_string must both be strings.', isError: true };
		}
		const target = await resolveForWrite(p, ctx, 'editing a file');
		if ('error' in target) { return { content: target.error, isError: true }; }
		const { uri } = target;
		try {
			const type = await exists(uri);
			if (type !== undefined && (type & vscode.FileType.Directory)) { return { content: `${p} is a directory.`, isError: true }; }
			const before = type === undefined ? undefined : await readDocumentText(uri);
			if (type !== undefined && before === undefined) { return { content: `Could not read ${p}.`, isError: true }; }
			if (before === undefined) {
				if (args.old_string !== '') {
					return { content: `File not found: ${p}. To create it pass an empty old_string or use write_file.`, isError: true };
				}
			}
			const result = applyEdit(before ?? '', args.old_string, args.new_string, bool(args.replace_all) ?? false);
			if (!result.ok) { return { content: `Edit failed for ${p}: ${result.error}`, isError: true }; }
			capture(ctx, uri, before);
			const r = await ctx.services.pendingEdits.applyContent(uri, result.content, 'agent', ctx.chatId, undefined, before ?? null);
			const where = toDisplayPath(uri);
			const note = result.fuzzy ? ' (matched ignoring whitespace differences)' : '';
			const many = result.replacements > 1 ? `${result.replacements} replacements, ` : '';
			return {
				content: `${r.isNew ? 'Created' : 'Edited'} ${where}: ${many}+${r.added} -${r.removed}${note}.`,
				edit: { uri: uri.toString(), path: where, added: r.added, removed: r.removed, isNew: r.isNew },
			};
		} catch (e) {
			return { content: `Edit failed for ${p}: ${msg(e)}`, isError: true };
		}
	},
	title(args, status, r) {
		const n = baseName(args.path);
		if (status === 'done' && r?.edit) { return `${r.edit.isNew ? 'Created' : 'Edited'} ${n} +${r.edit.added} -${r.edit.removed}`; }
		return status === 'error' ? `Edit failed ${n}` : `Editing ${n}`;
	},
};
