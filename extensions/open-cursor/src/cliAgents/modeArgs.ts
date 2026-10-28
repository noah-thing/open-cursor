/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  How each chat mode maps onto the flags of the subscription CLIs. Pure (no vscode, no spawn)
 *  so the mapping is unit tested. Flags verified against claude 2.1.312, codex-cli 0.157.1,
 *  gemini 0.46.0, grok 1.0.70 (`<cli> --help`).
 *
 *  Strongest equivalent per mode:
 *    ask / plan : the CLI's own read-only permission mode AND, where it has one, an OS sandbox
 *                 that cannot write (codex -s read-only, grok --sandbox read-only); Claude Code
 *                 also has its edit tools removed with --disallowed-tools.
 *    agent/debug: edits allowed (workspace sandbox where the CLI has one).
 *  Mode guidance travels as a real system prompt where a flag exists (claude
 *  --append-system-prompt, codex -c developer_instructions) and as a prompt prefix otherwise
 *  (gemini, grok: neither `grok --rules` nor `--system-prompt-override` changed the reply when
 *  tested headless).
 *--------------------------------------------------------------------------------------------*/

import { cliModeGuidance } from '../agent/prompts';
import type { RunOptions } from './types';
import { MODE_READONLY } from './types';

type ModeOpts = Pick<RunOptions, 'mode' | 'autoRun'>;

/** Claude Code tools that change files; removed outright in ask and plan. */
export const CLAUDE_EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

export const CLAUDE_BASE_PROMPT =
	'You are running inside Open Cursor, a code editor. The user sees your replies and tool calls in its chat panel and reviews every file edit there (Keep or Undo), so edit files directly with your normal tools and keep chat replies concise. Permission requests are answered in the editor. Do not use interactive terminal-only features.';

/** System prompt and permission flags for Claude Code. `acceptEdits` is applied by the caller when there is no approval channel. */
export function claudeModeArgs(o: Pick<RunOptions, 'mode'>): string[] {
	const readonly = MODE_READONLY(o.mode);
	// Always pass a mode: a user-level defaultMode (e.g. bypassPermissions) would otherwise skip our prompts.
	const args = ['--append-system-prompt', `${CLAUDE_BASE_PROMPT}\n\n${cliModeGuidance(o.mode)}`, '--permission-mode', readonly ? 'plan' : 'default'];
	if (readonly) {
		args.push('--disallowed-tools', CLAUDE_EDIT_TOOLS.join(','));
	}
	return args;
}

/** Sandbox, approval and developer-instructions flags for `codex exec` (new or resumed session). */
export function codexModeArgs(o: ModeOpts & Pick<RunOptions, 'sessionId'>): string[] {
	const readonly = MODE_READONLY(o.mode);
	const sandbox = readonly ? 'read-only' : 'workspace-write';
	const args: string[] = [];
	if (o.autoRun === 'always' && !readonly) {
		args.push('--dangerously-bypass-approvals-and-sandbox');
	} else if (o.sessionId) {
		args.push('-c', `sandbox_mode="${sandbox}"`);
	} else {
		args.push('-s', sandbox);
	}
	args.push('-c', 'approval_policy="never"');
	// a JSON string is a valid TOML basic string
	args.push('-c', `developer_instructions=${JSON.stringify(cliModeGuidance(o.mode))}`);
	return args;
}

/** `--approval-mode` for Gemini CLI. Headless cannot ask, so agent/debug use auto_edit (shell denied) unless autoRun is always. */
export function geminiModeArgs(o: ModeOpts): string[] {
	return ['--approval-mode', MODE_READONLY(o.mode) ? 'plan' : o.autoRun === 'always' ? 'yolo' : 'auto_edit'];
}

/** Text put in front of the user's prompt for CLIs without a system-prompt flag. */
export function cliPromptPrefix(mode: RunOptions['mode']): string {
	return cliModeGuidance(mode) + '\n\n---\n\n';
}
