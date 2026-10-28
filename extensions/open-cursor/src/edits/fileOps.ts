/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  File helpers shared by pending edits and checkpoints: write through the editor buffer.
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

/** Write full content through the editor buffer (undo stack, dirty state), then save. Creates the file if missing. */
export async function writeDocument(uri: vscode.Uri, text: string): Promise<void> {
	let doc = await openDoc(uri);
	if (!doc) {
		try {
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
		} catch { /* exists */ }
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
	if (doc.isDirty) {
		await doc.save();
	}
}

export async function deleteOnDisk(uri: vscode.Uri): Promise<void> {
	const we = new vscode.WorkspaceEdit();
	we.deleteFile(uri, { ignoreIfNotExists: true });
	await vscode.workspace.applyEdit(we);
}
