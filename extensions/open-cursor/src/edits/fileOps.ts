/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  File helpers shared by pending edits and checkpoints.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { minimalEdit, norm, withEol } from './hunks';

export async function openDoc(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
	try {
		return await vscode.workspace.openTextDocument(uri);
	} catch {
		return undefined;
	}
}

/** Current text with `\n` endings, or undefined if the file does not exist. */
export async function readCurrent(uri: vscode.Uri): Promise<string | undefined> {
	const doc = await openDoc(uri);
	return doc ? norm(doc.getText()) : undefined;
}

// Files whose writes should stay in the editor buffer for now (inline edit streaming).
const holdSave = new Map<string, number>();

/** While held, writeDocument leaves the document dirty instead of saving. Call the result to release. */
export function holdSaves(uri: vscode.Uri): () => void {
	const k = uri.toString();
	holdSave.set(k, (holdSave.get(k) ?? 0) + 1);
	let released = false;
	return () => {
		if (released) { return; }
		released = true;
		const n = (holdSave.get(k) ?? 1) - 1;
		if (n <= 0) { holdSave.delete(k); } else { holdSave.set(k, n); }
	};
}

/** Writes through the editor buffer so undo and dirty state stay right, then saves. Creates the file if missing. */
export async function writeDocument(uri: vscode.Uri, text: string, opts: { save?: boolean } = {}): Promise<void> {
	let doc = await openDoc(uri);
	if (!doc) {
		try {
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
		} catch { /* directory already exists */ }
		await vscode.workspace.fs.writeFile(uri, Buffer.from(norm(text), 'utf8'));
		return;
	}
	const old = doc.getText();
	const next = withEol(text, doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
	const m = minimalEdit(old, next);
	if (m) {
		const we = new vscode.WorkspaceEdit();
		we.replace(uri, new vscode.Range(doc.positionAt(m.start), doc.positionAt(m.end)), m.text);
		await vscode.workspace.applyEdit(we);
		doc = (await openDoc(uri)) ?? doc;
	}
	if (doc.isDirty && opts.save !== false && !holdSave.has(uri.toString())) {
		await doc.save();
	}
}

export async function deleteOnDisk(uri: vscode.Uri): Promise<void> {
	const we = new vscode.WorkspaceEdit();
	we.deleteFile(uri, { ignoreIfNotExists: true });
	await vscode.workspace.applyEdit(we);
}
