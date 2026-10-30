/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { readDocumentText } from '../../context/mentions';
import { resolvePath, toDisplayPath } from '../../context/paths';
import { MAX_EDIT_BYTES, tooLargeMessage, unsafeEncoding } from '../../edits/encoding';
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
export const BUILD_FILES = /(^|[\\/])(package\.json|makefile|gnumakefile|[^\\/]*\.mk|justfile|taskfile\.ya?ml|pyproject\.toml|setup\.py|setup\.cfg|tox\.ini|noxfile\.py|conftest\.py|pytest\.ini|cargo\.toml|build\.rs|build\.gradle(\.kts)?|pom\.xml|deno\.jsonc?|bunfig\.toml|\.npmrc|\.yarnrc(\.yml)?|tsconfig[^\\/]*\.json|vite\.config\.[cm]?[jt]s|webpack\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|go\.mod)|next\.config\.[cm]?[jt]s|eslint\.config\.[cm]?[jt]s|\.eslintrc[^\\/]*|babel\.config\.[cm]?[jt]s|\.babelrc|\.mocharc[^\\/]*|rakefile|gulpfile\.[cm]?[jt]s|gruntfile\.[cm]?[jt]s|cmakelists\.txt|playwright\.config\.[cm]?[jt]s|rollup\.config\.[cm]?[jt]s$/i;

/** Resolve a path for a mutating tool; asks the user when it lies outside the workspace or in a guarded folder. */
export async function resolveForWrite(p: string, ctx: ToolContext, action: string): Promise<{ uri: vscode.Uri } | { error: string }> {
	const r = resolvePath(p);
	if (r.ambiguous) {
		return { error: `${p} exists in more than one workspace folder (${r.ambiguous.join(', ')}). Start the path with the folder name, for example ${r.ambiguous[0]}/${p}.` };
	}
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

/**
 * Error text when an existing file must not be rewritten: too large to read whole, or not UTF-8 (a
 * save would turn its bytes into replacement characters). Files open in the editor are checked by
 * their VS Code encoding, which VS Code keeps on save.
 */
export async function whyNotEditable(uri: vscode.Uri, name: string): Promise<string | undefined> {
	const key = uri.toString();
	const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
	const enc = open ? (open as { encoding?: string }).encoding : undefined;
	if (open && typeof enc === 'string' && !/^utf-?8/i.test(enc)) { return undefined; }
	if (open && !open.getText().includes('\uFFFD')) { return undefined; }
	try {
		const size = (await vscode.workspace.fs.stat(uri)).size;
		if (size > MAX_EDIT_BYTES) { return open ? undefined : tooLargeMessage(name, size); }
		const bad = unsafeEncoding(await vscode.workspace.fs.readFile(uri));
		return bad ? `${name} was not edited because ${bad}, and saving would damage its characters.` : undefined;
	} catch {
		return undefined;
	}
}
