/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Finding the LM Studio app and the shell command that starts a program from a full path.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Where LM Studio puts its app, per system. Linux is left out: it ships as an AppImage with no fixed place. */
export function lmStudioAppPaths(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
	if (platform === 'darwin') { return ['/Applications/LM Studio.app', path.join(os.homedir(), 'Applications', 'LM Studio.app')]; }
	if (platform === 'win32') {
		const roots = [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']].filter((r): r is string => !!r);
		return roots.flatMap(r => [path.win32.join(r, 'LM Studio', 'LM Studio.exe'), path.win32.join(r, 'lm-studio', 'LM Studio.exe')]);
	}
	return [];
}

export function findLmStudioApp(): string | undefined {
	return lmStudioAppPaths().find(p => { try { return fs.existsSync(p); } catch { return false; } });
}

/**
 * `codex login` with `codex` swapped for its full path, quoted for the terminal's shell, so it works
 * when the program is not on PATH (a private Node copy, or an install that did not touch PATH).
 */
export function commandWithBinary(command: string, binaryPath: string | undefined, shell: string | undefined): string {
	if (!binaryPath) { return command; }
	const rest = command.replace(/^\S+/, '');
	const name = (shell ?? '').toLowerCase();
	if (/pwsh|powershell/.test(name)) { return `& '${binaryPath.replace(/'/g, "''")}'${rest}`; }
	if (/cmd(\.exe)?$/.test(name)) { return `"${binaryPath}"${rest}`; }
	return `'${binaryPath.replace(/'/g, `'\\''`)}'${rest}`;
}
