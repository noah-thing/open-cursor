/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Per shell syntax for changing folder before a command. No vscode import.
 *--------------------------------------------------------------------------------------------*/

export type ShellKind = 'powershell' | 'cmd' | 'posix';

export function shellKind(shellPath: string | undefined, platform: string = process.platform): ShellKind {
	const base = (shellPath ?? '').split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? '';
	if (base === 'powershell' || base === 'pwsh') { return 'powershell'; }
	if (base === 'cmd') { return 'cmd'; }
	if (base) { return 'posix'; }
	return platform === 'win32' ? 'powershell' : 'posix';
}

/** One line that moves to `cwd` and then runs `command`, valid in the given shell. */
export function cdLine(kind: ShellKind, cwd: string, command: string): string {
	if (kind === 'powershell') { return `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; ${command}`; }
	if (kind === 'cmd') { return `cd /d "${cwd}" && ${command}`; }
	return `cd '${cwd.replace(/'/g, `'\\''`)}' && ${command}`;
}
