/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Shared between the extension host and the chat webview. Plain JSON data only.
 *--------------------------------------------------------------------------------------------*/

export type ChatMode = 'agent' | 'plan' | 'debug' | 'ask';

export type ContextKind =
	| 'file'
	| 'folder'
	| 'code' // a symbol or a line range of a file
	| 'selection' // editor selection sent with Cmd+L
	| 'terminal' // terminal selection or last output
	| 'git' // diff of working tree / a commit
	| 'web' // ask the agent to search / fetch the web
	| 'docs' // a URL to documentation
	| 'rule' // a .cursor/rules file
	| 'chat' // a past chat (summary is injected)
	| 'lints' // current diagnostics
	| 'image';

export interface ContextItem {
	readonly id: string;
	readonly kind: ContextKind;
	/** Short pill label, e.g. `extension.ts` or `extension.ts (12-40)`. */
	readonly label: string;
	/** Secondary text (relative folder path, symbol kind, url). */
	readonly detail?: string;
	readonly uri?: string;
	/** 1-based inclusive line range. */
	readonly range?: { startLine: number; endLine: number };
	/** Inline payload (selection text, terminal text, image data url, url for web/docs). */
	readonly content?: string;
	readonly languageId?: string;
}

export type ToolStatus = 'streaming' | 'awaiting-approval' | 'running' | 'done' | 'error' | 'rejected' | 'cancelled';

export interface ToolPart {
	readonly type: 'tool';
	readonly id: string;
	readonly name: string;
	/** May be partial while streaming. */
	readonly args?: Record<string, unknown>;
	readonly status: ToolStatus;
	/** One line, human readable: "Read extension.ts L1-120", "Searched `foo` · 12 results". */
	readonly title: string;
	/** Collapsed body: command output, search results, error text. */
	readonly output?: string;
	/** Set for file edits. */
	readonly edit?: { uri: string; path: string; added: number; removed: number; isNew?: boolean; deleted?: boolean };
	/** Set for run_terminal_cmd awaiting approval. */
	readonly command?: { text: string; cwd?: string; background?: boolean };
	readonly durationMs?: number;
}

export type MessagePart =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'thinking'; readonly text: string; readonly durationMs?: number; readonly done: boolean }
	| ToolPart
	| {
		readonly type: 'error'; readonly message: string; readonly action?: 'openSettings' | 'retry';
		/** A model the user can run right now, offered as a one-click retry. */
		readonly switchTo?: { readonly id: string; readonly label: string };
		/** What would make the chosen model work: signing in to its CLI, or adding an API key. */
		readonly fix?: { readonly kind: 'signIn'; readonly agentId: string; readonly label: string } | { readonly kind: 'addKey' };
	};

export interface UserMessage {
	readonly id: string;
	readonly role: 'user';
	readonly text: string;
	readonly context: ContextItem[];
	readonly createdAt: number;
	/** Checkpoint taken right before this message ran. Restoring reverts files to this point. */
	readonly checkpointId?: string;
}

export interface AssistantMessage {
	readonly id: string;
	readonly role: 'assistant';
	readonly parts: MessagePart[];
	readonly createdAt: number;
	readonly modelId?: string;
	readonly usage?: { inputTokens: number; outputTokens: number };
	readonly done: boolean;
}

export type ChatMessage = UserMessage | AssistantMessage;

export interface TodoItem {
	readonly id: string;
	readonly content: string;
	readonly status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

export interface Chat {
	readonly id: string;
	readonly title: string;
	readonly mode: ChatMode;
	readonly modelId: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly messages: ChatMessage[];
	readonly todos: TodoItem[];
	readonly status: 'idle' | 'running' | 'awaiting-approval' | 'error';
	/** Messages the user typed while the agent was running; sent in order after the turn. */
	readonly queued: { id: string; text: string; context: ContextItem[] }[];
	/** Approximate tokens in use, and the model's window. */
	readonly contextUsage?: { used: number; limit: number };
}

export interface ChatSummary {
	readonly id: string;
	readonly title: string;
	readonly updatedAt: number;
	readonly status: Chat['status'];
	readonly mode: ChatMode;
}

export interface ModelOption {
	readonly id: string;
	readonly label: string;
	readonly provider: string;
	readonly supportsImages: boolean;
	readonly supportsThinking: boolean;
	readonly hasKey: boolean;
}

export interface PendingFileEdit {
	readonly uri: string;
	readonly path: string;
	readonly added: number;
	readonly removed: number;
	readonly isNew?: boolean;
	readonly deleted?: boolean;
}

export interface UiSettings {
	readonly autoRun: 'ask' | 'allowlist' | 'always';
	readonly showThinking: boolean;
	readonly fontSize: number;
	readonly submitWithModEnter: boolean;
}

/** Extension host -> webview */
export type HostMessage =
	| {
		readonly type: 'init';
		readonly chats: ChatSummary[];
		/** Open tabs in the chat header, in order. */
		readonly openChatIds: string[];
		readonly activeChat: Chat;
		readonly models: ModelOption[];
		readonly settings: UiSettings;
		readonly pendingEdits: PendingFileEdit[];
		readonly workspaceName?: string;
	}
	| { readonly type: 'chat'; readonly chat: Chat } // full snapshot of one chat, sent throttled while streaming
	| { readonly type: 'chats'; readonly chats: ChatSummary[]; readonly openChatIds: string[] }
	| { readonly type: 'activeChat'; readonly chatId: string }
	| { readonly type: 'models'; readonly models: ModelOption[] }
	| { readonly type: 'settings'; readonly settings: UiSettings }
	| { readonly type: 'pendingEdits'; readonly files: PendingFileEdit[] }
	| { readonly type: 'mentionResults'; readonly requestId: number; readonly items: ContextItem[] }
	/** Adds a context pill to the composer (Cmd+L), optionally in a new chat. */
	| { readonly type: 'addContext'; readonly item: ContextItem; readonly newChat?: boolean }
	| { readonly type: 'focusInput'; readonly text?: string }
	| { readonly type: 'showHistory' };

/** Webview -> extension host */
export type WebviewMessage =
	| { readonly type: 'ready' }
	| { readonly type: 'send'; readonly chatId: string; readonly text: string; readonly context: ContextItem[]; readonly mode: ChatMode; readonly modelId: string }
	/** Edits an earlier user message and resends from there; reverts the checkpoint first if `revert`. */
	| { readonly type: 'resend'; readonly chatId: string; readonly messageId: string; readonly text: string; readonly context: ContextItem[]; readonly revert: boolean; readonly modelId?: string }
	| { readonly type: 'stop'; readonly chatId: string }
	| { readonly type: 'queue'; readonly chatId: string; readonly text: string; readonly context: ContextItem[] }
	| { readonly type: 'unqueue'; readonly chatId: string; readonly queuedId: string }
	| { readonly type: 'newChat' }
	| { readonly type: 'openChat'; readonly chatId: string }
	| { readonly type: 'closeChatTab'; readonly chatId: string }
	| { readonly type: 'deleteChat'; readonly chatId: string }
	| { readonly type: 'renameChat'; readonly chatId: string; readonly title: string }
	| { readonly type: 'setMode'; readonly chatId: string; readonly mode: ChatMode }
	| { readonly type: 'setModel'; readonly chatId: string; readonly modelId: string }
	| { readonly type: 'approveTool'; readonly chatId: string; readonly toolCallId: string; readonly decision: 'run' | 'skip' | 'allowAlways' }
	| { readonly type: 'restoreCheckpoint'; readonly chatId: string; readonly messageId: string }
	| { readonly type: 'searchMentions'; readonly requestId: number; readonly query: string; readonly kind?: ContextKind }
	| { readonly type: 'openFile'; readonly uri: string; readonly range?: { startLine: number; endLine: number } }
	| { readonly type: 'openDiff'; readonly uri: string }
	| { readonly type: 'acceptAll' }
	| { readonly type: 'rejectAll' }
	| { readonly type: 'acceptFile'; readonly uri: string }
	| { readonly type: 'rejectFile'; readonly uri: string }
	| { readonly type: 'openSettings'; readonly section?: string }
	| { readonly type: 'copy'; readonly text: string }
	| { readonly type: 'insertCode'; readonly code: string; readonly languageId?: string }
	| { readonly type: 'applyCode'; readonly code: string; readonly path?: string }
	| { readonly type: 'runInTerminal'; readonly command: string }
	| { readonly type: 'pasteImage'; readonly dataUrl: string; readonly name?: string };

export interface SlashCommandInfo {
	readonly name: string; // without the leading slash
	readonly description: string;
	readonly source: string;
}

export type HostMessageExt =
	| HostMessage
	/** Reply to `requestSlashCommands`; also pushed whenever commands change. */
	| { readonly type: 'slashCommands'; readonly commands: SlashCommandInfo[] }
	/** The file in the active editor, shown as a suggested context pill. `null` when there is none. */
	| { readonly type: 'activeEditor'; readonly item: ContextItem | null }
	/** Agent CLIs on this machine and whether they are signed in, for the start screen. */
	| { readonly type: 'agents'; readonly agents: AgentStatus[] }
	/** Local model servers and API providers, for the start screen's connect panel. */
	| { readonly type: 'connectState'; readonly local: LocalServerStatus[]; readonly providers: ApiProviderStatus[] }
	/** Outcome of the key or server the user just tried to connect. */
	| { readonly type: 'connectResult'; readonly target: string; readonly ok: boolean; readonly message: string };

export interface LocalServerStatus {
	readonly id: 'ollama' | 'lmstudio' | 'custom';
	readonly label: string;
	readonly baseUrl: string;
	/** Not this computer: a server elsewhere on the network. */
	readonly remote: boolean;
	/** The address was set by the user rather than the default. */
	readonly configured: boolean;
	readonly reachable: boolean;
	readonly models: number;
	readonly modelId?: string;
}

export interface ApiProviderStatus {
	readonly id: string;
	readonly label: string;
	readonly hasKey: boolean;
	readonly modelId?: string;
}

export interface AgentStatus {
	readonly id: string;
	readonly label: string;
	readonly installed: boolean;
	/** `undefined` when the CLI gives no way to tell. */
	readonly loggedIn?: boolean;
	/** The model id to pick when the user chooses this agent. */
	readonly modelId?: string;
}

export type WebviewMessageExt =
	| WebviewMessage
	| { readonly type: 'requestSlashCommands' }
	| { readonly type: 'requestActiveEditor' }
	/** Start screen actions that hand off to the workbench. */
	| { readonly type: 'workbench'; readonly action: 'openFolder' | 'openRecent' | 'cloneRepo' | 'showEditor' }
	/** Start screen: install or sign in to an agent CLI in a terminal, or look again after doing so. */
	| { readonly type: 'agentAction'; readonly id: string; readonly action: 'install' | 'signIn' | 'refresh' }
	| { readonly type: 'requestConnect' }
	| { readonly type: 'connectKey'; readonly provider: string; readonly key: string }
	| { readonly type: 'connectServer'; readonly address: string }
	| { readonly type: 'resetServer'; readonly id: LocalServerStatus['id'] }
	/** Start or download a local model app on this computer. */
	| { readonly type: 'localApp'; readonly id: 'ollama' | 'lmstudio' };
