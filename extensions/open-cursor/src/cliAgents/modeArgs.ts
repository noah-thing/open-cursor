/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  How each chat mode maps onto the flags of the subscription CLIs. Pure (no vscode, no spawn)
 *  so the mapping is unit tested. Flags verified against claude 2.1.312, codex-cli 0.157.1,
 *  gemini 0.46.0, grok 1.0.70 (`<cli> --help`).
 *
 *  Strongest equivalent per mode:
 *    ask / plan : the CLI's own read only permission mode AND, where it has one, an OS sandbox
 *                 that cannot write (codex -s read-only, grok --sandbox read-only); Claude Code
 *                 also has its edit tools removed with --disallowed-tools.
 *    agent/debug: edits allowed (workspace sandbox where the CLI has one).
 *  Mode guidance travels as a real system prompt where a flag exists (claude
 *  --append-system-prompt, codex -c developer_instructions) and as a prompt prefix otherwise
 *  (gemini, grok: neither `grok --rules` nor `--system-prompt-override` changed the reply when
 *  tested headless).
 *--------------------------------------------------------------------------------------------*/

import { claudeEffortArgs, codexEffortArgs } from '../agent/effort';
import { cliModeGuidance } from '../agent/prompts';
import type { RunOptions } from './types';
import { MODE_READONLY } from './types';
import { commandAllowed } from './policy';

type ModeOpts = Pick<RunOptions, 'mode' | 'autoRun' | 'effort'>;

/** Claude Code tools that change files; removed outright in ask and plan. */
export const CLAUDE_EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

export const CLAUDE_BASE_PROMPT =
	'You are running inside OpenCursor, a code editor. The user sees your replies and tool calls in its chat panel and reviews every file edit there (Keep or Undo), so edit files directly with your normal tools and keep chat replies concise. Permission requests are answered in the editor. Do not use interactive terminal-only features.';

/** System prompt and permission flags for Claude Code. `acceptEdits` is applied by the caller when there is no approval channel. */
export function claudeModeArgs(o: Pick<RunOptions, 'mode' | 'effort'>): string[] {
	if (o.mode === 'help') {
		// Help answers from the manual alone: no tools at all, not even reading.
		// A lookup with the manual in hand: the fast model at low effort answers it as well, in a fraction of the time.
		return ['--append-system-prompt', cliModeGuidance('help'), '--permission-mode', 'plan', '--tools', '', '--strict-mcp-config', '--model', 'haiku', '--effort', 'low'];
	}
	const readonly = MODE_READONLY(o.mode);
	// Always pass a mode: a defaultMode set at user level (e.g. bypassPermissions) would otherwise skip our prompts.
	const args = ['--append-system-prompt', `${CLAUDE_BASE_PROMPT}\n\n${cliModeGuidance(o.mode)}`, '--permission-mode', readonly ? 'plan' : 'default'];
	if (readonly) {
		args.push('--disallowed-tools', CLAUDE_EDIT_TOOLS.join(','));
	}
	args.push(...claudeEffortArgs(o.effort));
	return args;
}

/** `[mcp_servers.x]` names in a Codex config.toml. */
export function codexMcpServers(configToml: string): string[] {
	return [...configToml.matchAll(/^\[mcp_servers\.("[^"]+"|[A-Za-z0-9_-]+)\]\s*$/gm)].map(m => m[1]);
}

/** Codex features that bring tools able to act without approval: plugins (computer use carries a JS REPL), connectors, browsers. */
const CODEX_TOOL_FEATURES = ['plugins', 'apps', 'computer_use', 'browser_use', 'in_app_browser'];

/**
 * Sandbox, approval and developer-instructions flags for `codex exec` (new or resumed session).
 * Codex cannot pause for approval, so below Full access it only gets what needs none: the user's
 * MCP servers, plugins and connectors (computer use, a browser, a JS REPL) are switched off for the
 * run, and in Ask the shell too. Allowlist and Auto keep the shell inside the workspace sandbox, offline.
 */
export function codexModeArgs(o: ModeOpts & Pick<RunOptions, 'sessionId'> & { readonly configToml?: string }): string[] {
	const readonly = MODE_READONLY(o.mode);
	const sandbox = readonly ? 'read-only' : 'workspace-write';
	const args: string[] = [];
	if (o.autoRun !== 'always' || readonly) {
		for (const s of codexMcpServers(o.configToml ?? '')) { args.push('-c', `mcp_servers.${s}.enabled=false`); }
		for (const f of CODEX_TOOL_FEATURES) { args.push('-c', `features.${f}=false`); }
		if (o.autoRun === 'ask' && !readonly) { args.push('-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false'); }
	}
	if (o.autoRun === 'always' && !readonly) {
		args.push('--dangerously-bypass-approvals-and-sandbox');
	} else if (o.sessionId) {
		args.push('-c', `sandbox_mode="${sandbox}"`);
	} else {
		args.push('-s', sandbox);
	}
	args.push('-c', 'approval_policy="never"');
	args.push(...(o.mode === 'help' ? ['-c', 'model_reasoning_effort="low"'] : codexEffortArgs(o.effort)));
	// a JSON string is a valid TOML basic string
	args.push('-c', `developer_instructions=${JSON.stringify(cliModeGuidance(o.mode))}`);
	return args;
}

/**
 * `--approval-mode` for Gemini CLI. Headless cannot ask, so agent/debug use auto_edit (shell denied)
 * unless autoRun is always; Allowlist and Auto let the allowlisted commands through.
 */
export function geminiModeArgs(o: ModeOpts & Partial<Pick<RunOptions, 'commandAllowlist'>>): string[] {
	const readonly = MODE_READONLY(o.mode);
	const args = ['--approval-mode', readonly ? 'plan' : o.autoRun === 'always' ? 'yolo' : 'auto_edit'];
	if (!readonly && (o.autoRun === 'allowlist' || o.autoRun === 'auto')) {
		const allowed = (o.commandAllowlist ?? []).map(e => e.trim()).filter(e => commandAllowed(e, [e]));
		if (allowed.length) { args.push('--allowed-tools', ...allowed.map(e => `run_shell_command(${e})`)); }
	}
	return args;
}

/** Text put in front of the user's prompt for CLIs without a system-prompt flag. */
export function cliPromptPrefix(mode: RunOptions['mode']): string {
	return cliModeGuidance(mode) + '\n\n---\n\n';
}
