/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Per shell syntax for changing folder before a command. No vscode import.
 *--------------------------------------------------------------------------------------------*/

export type ShellKind = 'powershell' | 'cmd' | 'posix' | 'wsl';

export function shellKind(shellPath: string | undefined, platform: string = process.platform): ShellKind {
	const base = (shellPath ?? '').split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? '';
	if (base === 'powershell' || base === 'pwsh') { return 'powershell'; }
	if (base === 'cmd') { return 'cmd'; }
	// bash running inside WSL cannot cd to C:\x; Git Bash (also bash.exe) can
	if (platform === 'win32' && (base === 'wsl' || (base === 'bash' && /[\\/]system32[\\/]/i.test(shellPath ?? '')))) { return 'wsl'; }
	if (base) { return 'posix'; }
	return platform === 'win32' ? 'powershell' : 'posix';
}

/** One line that moves to `cwd` and then runs `command`, valid in the given shell. */
export function cdLine(kind: ShellKind, cwd: string, command: string): string {
	// PowerShell also reads the typographic quotes (O’Neil) as quote characters; doubled, each stays literal
	if (kind === 'powershell') { return `Set-Location -LiteralPath '${cwd.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}' -ErrorAction Stop; ${command}`; }
	if (kind === 'wsl') { return `cd "$(wslpath -a '${cwd.replace(/'/g, `'\\''`)}')" && ${command}`; }
	if (kind === 'cmd') { return `cd /d "${cwd}" && ${command}`; }
	return `cd '${cwd.replace(/'/g, `'\\''`)}' && ${command}`;
}
