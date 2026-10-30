/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as nodePath from 'path';

export function workspaceRoots(): vscode.Uri[] {
	return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri);
}

export function primaryRoot(): vscode.Uri | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** Posix style path relative to the owning workspace folder, or the absolute fsPath when outside. */
export function toDisplayPath(uri: vscode.Uri): string {
	const folder = vscode.workspace.getWorkspaceFolder(uri);
	if (!folder) {
		return uri.scheme === 'file' ? uri.fsPath : uri.toString();
	}
	const rel = nodePath.posix.relative(folder.uri.path, uri.path);
	const multi = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
	return multi ? `${folder.name}/${rel}` : rel;
}

export interface ResolvedPath {
	readonly uri: vscode.Uri;
	readonly inWorkspace: boolean;
}

/**
 * Resolves a user/model supplied path. Accepts workspace-relative paths, absolute paths, `~/`, and
 * `<folderName>/rel` in multi-root workspaces.
 */
export function resolvePath(input: string): ResolvedPath {
	let p = input.trim();
	if (p.startsWith('file://')) {
		// normalised like any path, so `file:///project/../etc/x` cannot pass as inside the project
		const uri = vscode.Uri.file(nodePath.normalize(vscode.Uri.parse(p).fsPath));
		return { uri, inWorkspace: !!vscode.workspace.getWorkspaceFolder(uri) && !leavesThroughLink(uri) };
	}
	if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
		p = nodePath.join(os.homedir(), p.slice(1));
	}
	const roots = workspaceRoots();
	let uri: vscode.Uri;
	if (nodePath.isAbsolute(p)) {
		uri = vscode.Uri.file(nodePath.normalize(p));
	} else {
		const clean = p.replace(/^\.\//, '');
		let base = roots[0];
		let rel = clean;
		if (roots.length > 1) {
			const folders = vscode.workspace.workspaceFolders ?? [];
			const first = clean.split(/[\\/]/)[0];
			const match = folders.find(f => f.name === first);
			if (match) {
				base = match.uri;
				rel = clean.slice(first.length + 1);
			}
		}
		uri = base ? vscode.Uri.joinPath(base, rel) : vscode.Uri.file(nodePath.resolve(clean));
	}
	return { uri, inWorkspace: !!vscode.workspace.getWorkspaceFolder(uri) && !leavesThroughLink(uri) };
}

/** Real path of the deepest part of `p` that exists, so a path through a symlink resolves to where it really points. */
function realOf(p: string): string {
	let cur = p;
	let rest = '';
	for (let i = 0; i < 64; i++) {
		try { return nodePath.join(fs.realpathSync.native(cur), rest); } catch { /* not there yet */ }
		const up = nodePath.dirname(cur);
		if (up === cur) { return p; }
		rest = nodePath.join(nodePath.basename(cur), rest);
		cur = up;
	}
	return p;
}

/**
 * A path inside the project that a symlink sends elsewhere (a `docs` link to ~/.ssh, say) is treated as
 * outside, so reading, writing or deleting through it asks first like any outside path.
 */
function leavesThroughLink(uri: vscode.Uri): boolean {
	if (uri.scheme !== 'file') { return false; }
	const real = realOf(uri.fsPath);
	if (real === uri.fsPath) { return false; }
	const roots = workspaceRoots().filter(r => r.scheme === 'file').map(r => realOf(r.fsPath));
	const sep = nodePath.sep;
	const norm = (s: string): string => (process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s);
	return !roots.some(r => norm(real) === norm(r) || norm(real).startsWith(norm(r.endsWith(sep) ? r : r + sep)));
}

export function homeDir(): string {
	return os.homedir();
}

export function normaliseToRelative(p: string): string {
	const roots = workspaceRoots();
	const posix = p.replace(/\\/g, '/');
	for (const r of roots) {
		const base = r.path.endsWith('/') ? r.path : r.path + '/';
		if (posix.startsWith(base)) {
			return posix.slice(base.length);
		}
	}
	return posix.replace(/^\.\//, '');
}
