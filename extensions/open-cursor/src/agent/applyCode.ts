/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  "Apply" for code blocks in chat: ask a cheap model to merge the snippet into the target file,
 *  then land the result as a pending edit.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { readDocumentText } from '../context/mentions';
import { resolvePath } from '../context/paths';
import type { Services } from '../services';

const MAX_FILE_CHARS = 300000;

export function stripFence(s: string): string {
	const t = s.replace(/^\s*\n/, '');
	const m = /^```[\w+-]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(t.trim());
	return m ? m[1] : s;
}

export async function applyCodeToFile(services: Services, code: string, path: string | undefined, signal: AbortSignal): Promise<{ ok: boolean; message: string }> {
	const uri = path ? resolvePath(path).uri : vscode.window.activeTextEditor?.document.uri;
	if (!uri) { return { ok: false, message: 'No target file: open a file or pass a path.' }; }
	let exists = true;
	try { await vscode.workspace.fs.stat(uri); } catch { exists = false; }
	if (!exists) {
		await services.pendingEdits.applyContent(uri, code, 'agent');
		return { ok: true, message: `Created ${uri.fsPath}` };
	}
	const original = await readDocumentText(uri);
	if (original === undefined) { return { ok: false, message: 'Could not read the target file.' }; }
	if (original.length > MAX_FILE_CHARS) { return { ok: false, message: 'File is too large to apply automatically.' }; }
	const model = services.registry.getDefaultModel('inline') ?? services.registry.getDefaultModel('chat');
	if (!model) { return { ok: false, message: 'No model available. Add an API key in settings.' }; }
	let out = '';
	for await (const ev of services.registry.stream({
		model, signal, temperature: 0, maxTokens: Math.min(model.maxOutputTokens || 16000, 32000),
		system: 'You apply an edit snippet to a file. Output the COMPLETE updated file and nothing else: no explanation, no markdown fences. Change only what the snippet implies. Comments such as "... existing code ..." in the snippet stand for unchanged parts of the file; keep those parts exactly as they are. Preserve indentation, line endings and everything not affected.',
		messages: [{ role: 'user', content: [{ type: 'text', text: `File ${uri.fsPath}:\n<file>\n${original}\n</file>\n\nEdit snippet:\n<snippet>\n${code}\n</snippet>` }] }],
	})) {
		if (ev.type === 'text') { out += ev.text; }
	}
	if (signal.aborted) { return { ok: false, message: 'Cancelled.' }; }
	const updated = stripFence(out);
	if (!updated.trim()) { return { ok: false, message: 'The model returned no content.' }; }
	const eol = original.includes('\r\n') ? '\r\n' : '\n';
	const normalised = updated.replace(/\r?\n/g, eol);
	await services.pendingEdits.applyContent(uri, original.endsWith(eol) && !normalised.endsWith(eol) ? normalised + eol : normalised, 'agent');
	return { ok: true, message: `Applied to ${uri.fsPath}` };
}
