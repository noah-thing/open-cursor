/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import type { FimRequest, LLMProvider, ModelInfo, ProviderId, StreamEvent, ChatRequest, ToolSchema } from './providers/types';
import type { PendingFileEdit, ContextItem } from './shared/protocol';

export interface IProviderRegistry {
	readonly onDidChangeModels: vscode.Event<void>;
	getModels(): ModelInfo[];
	getModel(id: string): ModelInfo | undefined;
	/** Falls back to the first model that has a key. */
	getDefaultModel(purpose: 'chat' | 'inline' | 'tab'): ModelInfo | undefined;
	getProvider(id: ProviderId): LLMProvider;
	hasKey(id: ProviderId): Promise<boolean>;
	setKey(id: ProviderId, key: string | undefined): Promise<void>;
	verify(id: ProviderId): Promise<{ ok: boolean; message: string }>;
	stream(req: ChatRequest): AsyncIterable<StreamEvent>;
	fim(req: FimRequest): AsyncIterable<string>;
	refreshModels(): Promise<void>;
}

/** One hunk of a pending AI edit, in current-document coordinates. */
export interface PendingHunk {
	readonly id: string;
	/** 0-based. */
	readonly startLine: number;
	/** 0 for a pure deletion. */
	readonly addedCount: number;
	/** Empty for a pure insertion. */
	readonly removedLines: string[];
}

/** AI edits that are written to files but not yet kept by the user. */
export interface IPendingEdits {
	readonly onDidChange: vscode.Event<void>;
	/**
	 * Writes the full new content through a WorkspaceEdit (so the buffer, undo stack and dirty
	 * state stay right) and saves. The first touch of a file in a review session snapshots its
	 * original, so Undo restores it exactly.
	 * `originalOverride`: when no session exists yet and someone else (a CLI agent) already changed
	 * the file on disk, the text the review should diff against (null = the file did not exist).
	 * Ignored if a session exists.
	 * `expectedBefore`: if given (null = file must not exist), throws when the live text differs,
	 * so a read, modify, write cycle cannot lose a concurrent change.
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
	openDiff(uri: vscode.Uri): Promise<void>;
}

/** Snapshots of every file the agent touched, per user message. */
export interface ICheckpoints {
	/** Returns the checkpoint id. Files are added later through `capture`. */
	begin(chatId: string, messageId: string): string;
	/** Every tool that writes files must call this before writing (contentBefore undefined = file did not exist). */
	capture(checkpointId: string, uri: vscode.Uri, contentBefore: string | undefined): void;
	/** Puts back every file touched since this checkpoint, including it, as it was before. */
	restore(chatId: string, checkpointId: string): Promise<{ files: number }>;
	dispose(chatId: string): void;
}

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
	/** Creates the file if it is missing. */
	openConfig(scope: 'user' | 'workspace'): Promise<void>;
}

/** Embedding index of the codebase, with a ripgrep fallback. */
export interface ICodebaseIndex {
	readonly onDidChange: vscode.Event<void>;
	getStatus(): { state: 'disabled' | 'idle' | 'indexing' | 'ready' | 'error'; files: number; chunks: number; progress?: number; error?: string };
	/** Falls back to keyword search when no embedding model or key is configured. */
	search(query: string, opts: { limit: number; includeGlob?: string; signal: AbortSignal }): Promise<{ uri: string; path: string; startLine: number; endLine: number; text: string; score: number }[]>;
	rebuild(): Promise<void>;
	clear(): Promise<void>;
}

export interface IContextService {
	/** Always-on rules, AGENTS.md, legacy .cursorrules, user rules, plus rules whose glob matches `files`. */
	getRules(files: string[]): Promise<{ name: string; source: string; content: string; description?: string; agentRequested?: boolean }[]>;
	/** From .cursor/commands/*.md and ~/.open-cursor/commands/*.md */
	getSlashCommands(): Promise<{ name: string; description: string; source: string; content: string }[]>;
	searchMentions(query: string, kind?: ContextItem['kind']): Promise<ContextItem[]>;
	resolve(item: ContextItem): Promise<string>;
}

/**
 * An installed agent CLI (claude, codex, grok, gemini, opencode) used as the agent backend for a chat, on the
 * user's own subscription. The CLI runs its own tools; we translate its JSON event stream into chat
 * parts, route its permission prompts to our approval UI where the CLI allows it, and capture file
 * originals so its edits go through the same Keep/Undo review and checkpoints as native agent edits.
 */
export interface CliAgentInfo {
	readonly id: 'claude-code' | 'codex' | 'grok' | 'gemini-cli' | 'opencode';
	readonly label: string; // "Claude Code"
	readonly binaryPath?: string; // resolved path, undefined = not installed
	readonly version?: string;
	readonly loggedIn?: boolean; // best effort
	/** Shown in the picker as `cli:<id>/<model>`, e.g. `cli:claude-code/sonnet`. `default` is the CLI's own default. */
	/** OpenCode models are `provider/model` ids; the ones that are free without an account carry `free`. */
	readonly models: { id: string; label: string; free?: boolean }[];
}

export interface CliTurnCallbacks {
	onText(delta: string): void;
	onThinking(delta: string): void;
	onToolStart(part: import('./shared/protocol').ToolPart): void;
	onToolUpdate(part: import('./shared/protocol').ToolPart): void;
	/** For a CLI permission prompt. */
	requestApproval(part: import('./shared/protocol').ToolPart): Promise<'run' | 'skip' | 'allowAlways'>;
	/** Called before the CLI writes a file when we can intercept it, otherwise right after with the captured original. */
	onFileOriginal(uri: vscode.Uri, contentBefore: string | undefined): void;
	onFileChanged(uri: vscode.Uri): void;
	onUsage(u: { inputTokens: number; outputTokens: number }): void;
}

export interface ICliAgents {
	readonly onDidChange: vscode.Event<void>;
	detect(): Promise<CliAgentInfo[]>;
	/** Ignores the cache. For after the user installs or signs in to a CLI. */
	refresh(): Promise<CliAgentInfo[]>;
	get(id: CliAgentInfo['id']): CliAgentInfo | undefined;
	/** Installs the OpenCode CLI without sudo (~/.opencode/bin), then re-detects. Works even when it is not installed yet. */
	installOpenCode(): Promise<{ ok: boolean; message: string }>;
	/**
	 * `sessionId` is the CLI's own session id from the previous turn of this chat; the returned one
	 * is passed back in so the next turn resumes the same CLI conversation.
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
