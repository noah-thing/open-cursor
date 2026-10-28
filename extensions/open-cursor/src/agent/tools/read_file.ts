/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as nodePath from 'path';
import { MAX_FILE_LINES, numberLines } from '../../context/mentions';
import { baseName, num, str, type ToolDef } from './types';
import { exists, msg, readDocumentText, resolveForRead, toDisplayPath } from './fsutil';

const IMAGES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface Args { path?: string; offset?: number; limit?: number }

export const readFile: ToolDef<Args> = {
	readOnly: true,
	schema: {
		name: 'read_file',
		description: `Read a file. Output lines are prefixed "N|" (not part of the file). Reads up to ${MAX_FILE_LINES} lines; use offset/limit for large files. Image files are returned as images. Prefer reading whole small files over many small reads.`,
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Workspace-relative or absolute path.' },
				offset: { type: 'integer', description: '1-based line to start from.' },
				limit: { type: 'integer', description: `Number of lines to read (max ${MAX_FILE_LINES}).` },
			},
			required: ['path'],
		},
	},
	async run(args, ctx) {
		const p = str(args.path);
		if (!p) { return { content: 'Missing required argument: path', isError: true }; }
		const target = await resolveForRead(p, ctx, 'reading a file');
		if ('error' in target) { return { content: target.error, isError: true }; }
		const { uri } = target;
		const type = await exists(uri);
		if (type === undefined) { return { content: `File not found: ${p}`, isError: true }; }
		if (type & vscode.FileType.Directory) { return { content: `${p} is a directory. Use list_dir.`, isError: true }; }
		const mediaType = IMAGES[nodePath.extname(uri.path).toLowerCase()];
		try {
			if (mediaType) {
				const bytes = await vscode.workspace.fs.readFile(uri);
				if (bytes.byteLength > MAX_IMAGE_BYTES) { return { content: `Image too large (${Math.round(bytes.byteLength / 1024)} KB, limit 5 MB).`, isError: true }; }
				return { content: `Image ${toDisplayPath(uri)} (${mediaType}, ${Math.round(bytes.byteLength / 1024)} KB) attached.`, images: [{ mediaType, data: Buffer.from(bytes).toString('base64') }] };
			}
			const text = await readDocumentText(uri);
			if (text === undefined) { return { content: `Could not read ${p}`, isError: true }; }
			if (text.slice(0, 8000).includes('\u0000')) { return { content: `${p} looks like a binary file; not shown.`, isError: true }; }
			if (text === '') { return { content: `${p} is empty.` }; }
			const lines = text.split(/\r?\n/);
			if (lines.length > 1 && lines[lines.length - 1] === '') { lines.pop(); }
			const start = Math.max(1, Math.floor(num(args.offset) ?? 1));
			if (start > lines.length) { return { content: `offset ${start} is beyond the end of the file (${lines.length} lines).`, isError: true }; }
			const limit = Math.min(MAX_FILE_LINES, Math.max(1, Math.floor(num(args.limit) ?? MAX_FILE_LINES)));
			const end = Math.min(lines.length, start + limit - 1);
			let out = numberLines(lines, start, end);
			if (end < lines.length) {
				out += `\n[Showing lines ${start}-${end} of ${lines.length}. Call read_file again with offset=${end + 1} to continue.]`;
			} else if (start > 1) {
				out += `\n[End of file, ${lines.length} lines.]`;
			}
			return { content: out, output: `${end - start + 1} lines` };
		} catch (e) {
			return { content: `Error reading ${p}: ${msg(e)}`, isError: true };
		}
	},
	title(args, status) {
		const name = baseName(args.path);
		const o = num(args.offset);
		const l = num(args.limit);
		const range = o || l ? ` L${o ?? 1}-${(o ?? 1) + (l ?? MAX_FILE_LINES) - 1}` : '';
		return status === 'running' || status === 'streaming' ? `Reading ${name}${range}` : `Read ${name}${range}`;
	},
};
