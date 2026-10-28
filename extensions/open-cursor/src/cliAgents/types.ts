/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  vscode-free types shared by the CLI agent runners and parsers, so they run in plain node tests.
 *--------------------------------------------------------------------------------------------*/

import type { ChatMode, ToolPart } from '../shared/protocol';

export type CliAgentId = 'claude-code' | 'codex' | 'gemini-cli';
export type AutoRun = 'ask' | 'allowlist' | 'always';
export type Approval = 'run' | 'skip' | 'allowAlways';

/** What a runner reports back. Mirrors CliTurnCallbacks but with plain file paths instead of vscode.Uri. */
export interface TurnHost {
	text(delta: string): void;
	thinking(delta: string): void;
	toolStart(part: ToolPart): void;
	toolUpdate(part: ToolPart): void;
	requestApproval(part: ToolPart): Promise<Approval>;
	/** Absolute path and its content before the CLI changed it (undefined = file did not exist). */
	fileOriginal(absPath: string, contentBefore: string | undefined): void;
	fileChanged(absPath: string): void;
	/** vscode.Uri.file(absPath).toString(), so edit parts line up with pending edits. */
	uri(absPath: string): string;
	usage(u: { inputTokens: number; outputTokens: number }): void;
}

export interface RunOptions {
	binary: string;
	version?: string;
	model: string;
	mode: ChatMode;
	prompt: string;
	images?: { mediaType: string; data: string }[];
	cwd: string;
	sessionId?: string;
	autoRun: AutoRun;
	commandAllowlist: string[];
	extraArgs: string[];
	/** Environment for the child (login shell PATH merged in). */
	env: NodeJS.ProcessEnv;
	signal: AbortSignal;
	host: TurnHost;
	/** Debug/test hook: every raw stdout line of the CLI. */
	rawLog?: (line: string) => void;
	/** Absolute path of dist/permissionServer.js; undefined when not bundled. */
	permissionServerPath?: string;
}

export interface RunResult {
	sessionId?: string;
	stopReason: 'done' | 'aborted' | 'error';
	error?: string;
}

export const MODE_READONLY = (mode: ChatMode): boolean => mode === 'ask' || mode === 'plan';
