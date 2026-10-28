/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Service contracts between modules. Each module implements its interface; extension.ts wires them.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import type { FimRequest, LLMProvider, ModelInfo, ProviderId, StreamEvent, ChatRequest, ToolSchema } from './providers/types';
import type { PendingFileEdit, ContextItem } from './shared/protocol';

/** src/providers/registry.ts */
export interface IProviderRegistry {
	readonly onDidChangeModels: vscode.Event<void>;
	/** All usable models: built-in catalog + discovered + user-added, filtered by enabled state. */
	getModels(): ModelInfo[];
	getModel(id: string): ModelInfo | undefined;
	/** Default model for chat/agent, cmd-k, tab. Falls back to the first model with a key. */
	getDefaultModel(purpose: 'chat' | 'inline' | 'tab'): ModelInfo | undefined;
	getProvider(id: ProviderId): LLMProvider;
	hasKey(id: ProviderId): Promise<boolean>;
	setKey(id: ProviderId, key: string | undefined): Promise<void>;
	/** Calls the provider with the stored key to confirm it works. */
	verify(id: ProviderId): Promise<{ ok: boolean; message: string }>;
	/** Convenience: resolve provider for model and stream. */
	stream(req: ChatRequest): AsyncIterable<StreamEvent>;
	fim(req: FimRequest): AsyncIterable<string>;
	refreshModels(): Promise<void>;
}

/** One hunk of a pending (not yet accepted) AI edit, in current-document coordinates. */
export interface PendingHunk {
	readonly id: string;
	/** 0-based start line in the current document of the added lines. */
	readonly startLine: number;
	/** Number of added lines (may be 0 for pure deletions). */
	readonly addedCount: number;
	/** Original text lines that this hunk replaced (may be empty for pure insertions). */
	readonly removedLines: string[];
}

/** src/edits/pendingEdits.ts. Owns AI edits that are applied to files but not yet kept by the user. */
export interface IPendingEdits {
	readonly onDidChange: vscode.Event<void>;
	/**
	 * Apply new full content to a file as a pending edit. The first time a file is touched in a
	 * review session its original content is snapshotted, so later Undo restores it exactly.
	 * Writes through a WorkspaceEdit so the editor buffer, undo stack and dirty state are right,
	 * then saves the file. `source` is 'agent' or 'inline' (Cmd+K).
	 * `originalOverride`: when no session exists yet and the file was already changed on disk by someone else (a CLI agent),
	 * the text the review should diff against (null = the file did not exist). Ignored if a session exists.
	 * `expectedBefore`: if given (null = file must not exist), the write is refused with an Error when the live text differs,
	 * making read-modify-write atomic.
	 */
	applyContent(uri: vscode.Uri, newContent: string, source: 'agent' | 'inline', chatId?: string, originalOverride?: string | null, expectedBefore?: string | null): Promise<{ added: number; removed: number; isNew: boolean }>;
	deleteFile(uri: vscode.Uri, chatId?: string): Promise<void>;
	getFiles(): PendingFileEdit[];
	getHunks(uri: vscode.Uri): PendingHunk[];
	acceptHunk(uri: vscode.Uri, hunkId: string): Promise<void>;
	rejectHunk(uri: vscode.Uri, hunkId: string): Promise<void>;
	acceptFile(uri: vscode.Uri): Promise<void>;
	rejectFile(uri: vscode.Uri): Promise<void>;
	acceptAll(): Promise<void>;
	rejectAll(): Promise<void>;
	/** Opens VS Code's diff editor original <-> current for the file. */
	openDiff(uri: vscode.Uri): Promise<void>;
}

/** src/edits/checkpoints.ts. Snapshots of every file the agent touched, per user message. */
export interface ICheckpoints {
	/** Begin a checkpoint for a user message; returns its id. Files are captured lazily via `capture`. */
	begin(chatId: string, messageId: string): string;
	/** Must be called by every file mutating tool BEFORE it writes, with the file's current content (undefined = did not exist). */
	capture(checkpointId: string, uri: vscode.Uri, contentBefore: string | undefined): void;
	/** Restore every file touched since (and including) this checkpoint to its state before it. */
	restore(chatId: string, checkpointId: string): Promise<{ files: number }>;
	/** Drop checkpoints of a deleted chat. */
	dispose(chatId: string): void;
}

/** src/mcp/manager.ts */
export interface McpServerState {
	readonly name: string;
	readonly status: 'starting' | 'ready' | 'error' | 'disabled';
	readonly error?: string;
	readonly toolCount: number;
	readonly source: string; // path of the mcp.json it came from
	readonly transport: 'stdio' | 'http' | 'sse';
}
export interface IMcpManager {
	readonly onDidChange: vscode.Event<void>;
	getServers(): McpServerState[];
	/** Tools exposed to the model, names prefixed `mcp_<server>_<tool>` (sanitised to [a-zA-Z0-9_-], max 64 chars). */
	getTools(): ToolSchema[];
	callTool(prefixedName: string, args: unknown, signal: AbortSignal): Promise<{ content: string; isError: boolean; images?: { mediaType: string; data: string }[] }>;
	setEnabled(name: string, enabled: boolean): Promise<void>;
	reload(): Promise<void>;
	/** Opens (creating if needed) the user mcp.json. */
	openConfig(scope: 'user' | 'workspace'): Promise<void>;
}

/** src/indexing/index.ts. Semantic codebase index (embeddings) with ripgrep fallback. */
export interface ICodebaseIndex {
	readonly onDidChange: vscode.Event<void>;
	getStatus(): { state: 'disabled' | 'idle' | 'indexing' | 'ready' | 'error'; files: number; chunks: number; progress?: number; error?: string };
	/** Semantic search; when no embedding model/key is configured, falls back to keyword search. */
	search(query: string, opts: { limit: number; includeGlob?: string; signal: AbortSignal }): Promise<{ uri: string; path: string; startLine: number; endLine: number; text: string; score: number }[]>;
	rebuild(): Promise<void>;
	clear(): Promise<void>;
}

/** src/context/rules.ts + mentions.ts */
export interface IContextService {
	/** Rules that apply: always-apply rules, AGENTS.md, legacy .cursorrules, user rules, plus glob-matched rules for `files`. */
	getRules(files: string[]): Promise<{ name: string; source: string; content: string; description?: string; agentRequested?: boolean }[]>;
	/** Custom slash commands from .cursor/commands/*.md and ~/.open-cursor/commands/*.md */
	getSlashCommands(): Promise<{ name: string; description: string; source: string; content: string }[]>;
	searchMentions(query: string, kind?: ContextItem['kind']): Promise<ContextItem[]>;
	/** Resolves a pill into text for the prompt. */
	resolve(item: ContextItem): Promise<string>;
}

/**
 * src/cliAgents/*. "Bring your own CLI": run an installed agent CLI (Claude Code `claude`, Codex `codex`,
 * Grok `grok`, Gemini CLI `gemini`) on the user's existing subscription as the agent backend for a chat. The CLI runs
 * its own tools; we translate its JSON event stream into chat parts, route its permission prompts to our
 * approval UI where the CLI allows it, and capture file originals so its edits land in the same
 * Keep/Undo review and checkpoints as native agent edits.
 */
export interface CliAgentInfo {
	readonly id: 'claude-code' | 'codex' | 'grok' | 'gemini-cli';
	readonly label: string; // "Claude Code"
	readonly binaryPath?: string; // resolved path, undefined = not installed
	readonly version?: string;
	readonly loggedIn?: boolean; // best effort
	/** Model choices exposed in the picker as `cli:<id>/<model>` e.g. `cli:claude-code/sonnet`; `default` = CLI's own default. */
	readonly models: { id: string; label: string }[];
}

export interface CliTurnCallbacks {
	/** Same events the native agent loop produces, already in UI shape. */
	onText(delta: string): void;
	onThinking(delta: string): void;
	onToolStart(part: import('./shared/protocol').ToolPart): void;
	onToolUpdate(part: import('./shared/protocol').ToolPart): void;
	/** Ask the user to approve (CLI permission prompt). Resolves with the decision. */
	requestApproval(part: import('./shared/protocol').ToolPart): Promise<'run' | 'skip' | 'allowAlways'>;
	/** Called BEFORE the CLI writes a file when we can intercept it, or right after with the captured original. */
	onFileOriginal(uri: vscode.Uri, contentBefore: string | undefined): void;
	onFileChanged(uri: vscode.Uri): void;
	onUsage(u: { inputTokens: number; outputTokens: number }): void;
}

export interface ICliAgents {
	readonly onDidChange: vscode.Event<void>;
	detect(): Promise<CliAgentInfo[]>;
	/** Detect again now, ignoring the cache: after the user installs or signs in to a CLI. */
	refresh(): Promise<CliAgentInfo[]>;
	get(id: CliAgentInfo['id']): CliAgentInfo | undefined;
	/**
	 * Run one user turn. `sessionId` is the CLI's own session id from the previous turn of this chat
	 * (resume), returned so the next turn continues the same CLI conversation.
	 */
	runTurn(opts: {
		agent: CliAgentInfo['id'];
		model: string;
		mode: import('./shared/protocol').ChatMode;
		prompt: string; // already includes resolved @-context and rules
		images?: { mediaType: string; data: string }[];
		cwd: string;
		sessionId?: string;
		autoRun: 'ask' | 'allowlist' | 'always';
		signal: AbortSignal;
		callbacks: CliTurnCallbacks;
	}): Promise<{ sessionId?: string; stopReason: 'done' | 'aborted' | 'error'; error?: string }>;
}

export interface Services {
	readonly registry: IProviderRegistry;
	readonly pendingEdits: IPendingEdits;
	readonly checkpoints: ICheckpoints;
	readonly mcp: IMcpManager;
	readonly index: ICodebaseIndex;
	readonly context: IContextService;
	readonly cli: ICliAgents;
}
