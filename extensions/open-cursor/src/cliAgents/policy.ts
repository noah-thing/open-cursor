/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Approval policy shared by the runners. No vscode import.
 *--------------------------------------------------------------------------------------------*/

/** True when `command` starts with one of the allowlist entries and chains nothing else. */
export function commandAllowed(command: string, allowlist: readonly string[]): boolean {
	const cmd = command.trim();
	if (!cmd || /[;&|`\n<>]|\$\(/.test(cmd)) {
		return false;
	}
	return allowlist.some(entry => {
		const e = entry.trim();
		return e.length > 0 && (cmd === e || cmd.startsWith(e + ' '));
	});
}
