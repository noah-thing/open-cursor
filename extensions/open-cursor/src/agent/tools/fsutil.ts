/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  File helpers shared by the tools.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { readDocumentText } from '../../context/mentions';
import { resolvePath, toDisplayPath } from '../../context/paths';
import type { ToolContext } from './types';

export { readDocumentText, toDisplayPath };

export async function exists(uri: vscode.Uri): Promise<vscode.FileType | undefined> {
	try {
		return (await vscode.workspace.fs.stat(uri)).type;
	} catch {
		return undefined;
	}
}

/** Resolve a path for a mutating tool; asks the user when it lies outside the workspace. */
export async function resolveForWrite(p: string, ctx: ToolContext, action: string): Promise<{ uri: vscode.Uri } | { error: string }> {
	const r = resolvePath(p);
	if (!r.inWorkspace) {
		const ok = await ctx.confirmOutsideWorkspace(r.uri.scheme === 'file' ? r.uri.fsPath : r.uri.toString(), action);
		if (!ok) {
			return { error: `The user did not allow ${action} outside the workspace (${r.uri.fsPath}).` };
		}
	}
	return { uri: r.uri };
}

/** Resolve a path for a read-only tool; asks the user when it lies outside the workspace. */
export async function resolveForRead(p: string, ctx: ToolContext, action: string): Promise<{ uri: vscode.Uri } | { error: string }> {
	const r = resolvePath(p);
	if (!r.inWorkspace) {
		const ok = await ctx.confirmOutsideWorkspace(r.uri.scheme === 'file' ? r.uri.fsPath : r.uri.toString(), action);
		if (!ok) {
			return { error: `The user did not allow ${action} outside the workspace (${r.uri.fsPath}).` };
		}
	}
	return { uri: r.uri };
}

/** Run a mutating step with checkpoint capture. `before` is the content on disk/buffer before the write. */
export function capture(ctx: ToolContext, uri: vscode.Uri, before: string | undefined): void {
	if (ctx.checkpointId) {
		try {
			ctx.services.checkpoints.capture(ctx.checkpointId, uri, before);
		} catch {
			// checkpoint failure must not block the edit
		}
	}
}

export function msg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
