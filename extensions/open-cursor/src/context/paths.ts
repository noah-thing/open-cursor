/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as os from 'os';
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
		const uri = vscode.Uri.parse(p);
		return { uri, inWorkspace: !!vscode.workspace.getWorkspaceFolder(uri) };
	}
	if (p === '~' || p.startsWith('~/')) {
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
			const first = clean.split('/')[0];
			const match = folders.find(f => f.name === first);
			if (match) {
				base = match.uri;
				rel = clean.slice(first.length + 1);
			}
		}
		uri = base ? vscode.Uri.joinPath(base, rel) : vscode.Uri.file(nodePath.resolve(clean));
	}
	return { uri, inWorkspace: !!vscode.workspace.getWorkspaceFolder(uri) };
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
