/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Approval policy shared by the runners. No vscode import.
 *--------------------------------------------------------------------------------------------*/

import { needsApproval } from '../agent/approval';
import type { AutoRun, CliAgentId } from './types';

/** True when `command` starts with one of the allowlist entries and chains nothing else. */
export function commandAllowed(command: string, allowlist: readonly string[]): boolean {
	const cmd = command.trim();
	if (!cmd || /[;&|`\n\r<>]|\$\(/.test(cmd)) {
		return false;
	}
	// the same reading as the native allowlist: nothing hidden in ( ) or { }, no flag that runs a program, no path outside the project
	return !needsApproval(cmd, { autoRun: 'allowlist', allowlist, denylist: [] });
}

/** OpenCode, Gemini CLI and Grok cannot pause to ask. In Allowlist every other command would just be
 *  refused, which leaves the agent unable to work, so for them Allowlist runs like Auto: anything except
 *  the careful commands (delete, install, go online), which stay refused. Ask keeps everything refused. */
export function effectiveAutoRun(agent: CliAgentId, autoRun: AutoRun): AutoRun {
	return autoRun === 'allowlist' && (agent === 'opencode' || agent === 'gemini-cli' || agent === 'grok') ? 'auto' : autoRun;
}
