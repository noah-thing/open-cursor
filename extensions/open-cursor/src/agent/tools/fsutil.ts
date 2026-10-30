/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
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

/**
 * Folders whose files make tools run programs: git hooks and config, editor tasks and settings, the
 * agent CLIs' project settings, CI workflows. Changing them is asked about like a path outside the project.
 */
const GUARDED = /(^|[\\/])(\.git|\.vscode|\.claude|\.gemini|\.cursor|\.open-cursor|\.husky|\.devcontainer)([\\/]|$)|(^|[\\/])\.github[\\/]workflows([\\/]|$)/i;

/** Build and script files: once the agent changes one, allowlisted commands that run it ask again for this turn. */
export const BUILD_FILES = /(^|[\\/])(package\.json|makefile|gnumakefile|[^\\/]*\.mk|justfile|taskfile\.ya?ml|pyproject\.toml|setup\.py|setup\.cfg|tox\.ini|noxfile\.py|conftest\.py|pytest\.ini|cargo\.toml|build\.rs|build\.gradle(\.kts)?|pom\.xml|deno\.jsonc?|bunfig\.toml|\.npmrc|\.yarnrc(\.yml)?|tsconfig[^\\/]*\.json|vite\.config\.[cm]?[jt]s|webpack\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|go\.mod)$/i;

/** Resolve a path for a mutating tool; asks the user when it lies outside the workspace or in a guarded folder. */
export async function resolveForWrite(p: string, ctx: ToolContext, action: string): Promise<{ uri: vscode.Uri } | { error: string }> {
	const r = resolvePath(p);
	if (r.inWorkspace && GUARDED.test(toDisplayPath(r.uri))) {
		const ok = await ctx.confirmOutsideWorkspace(r.uri.scheme === 'file' ? r.uri.fsPath : r.uri.toString(), `${action} in a folder that makes tools run programs (git, editor tasks, agent settings)`);
		if (!ok) { return { error: `The user did not allow ${action} in ${toDisplayPath(r.uri)}.` }; }
		return { uri: r.uri };
	}
	if (r.inWorkspace && BUILD_FILES.test(toDisplayPath(r.uri))) { ctx.onBuildFileWrite?.(); }
	if (!r.inWorkspace) {
		const ok = await ctx.confirmOutsideWorkspace(r.uri.scheme === 'file' ? r.uri.fsPath : r.uri.toString(), action);
		if (!ok) {
			return { error: `The user did not allow ${action} outside the workspace (${r.uri.fsPath}).` };
		}
	}
	return { uri: r.uri };
}

/** Resolve a path for a readonly tool; asks the user when it lies outside the workspace. */
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
