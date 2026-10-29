/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Approval policy shared by the runners. No vscode import.
 *--------------------------------------------------------------------------------------------*/

import type { AutoRun, CliAgentId } from './types';

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

/** OpenCode, Gemini CLI and Grok cannot pause to ask. In Allowlist every other command would just be
 *  refused, which leaves the agent unable to work, so for them Allowlist runs like Auto: anything except
 *  the careful commands (delete, install, go online), which stay refused. Ask keeps everything refused. */
export function effectiveAutoRun(agent: CliAgentId, autoRun: AutoRun): AutoRun {
	return autoRun === 'allowlist' && (agent === 'opencode' || agent === 'gemini-cli' || agent === 'grok') ? 'auto' : autoRun;
}
