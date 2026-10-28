/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Private message protocol between the settings panel (extension host) and its webview.
 *  Types only: imported by both sides, never carries secrets back to the webview.
 *--------------------------------------------------------------------------------------------*/

export type SettingsSection = 'general' | 'models' | 'subscriptions' | 'tab' | 'rules' | 'commands' | 'mcp' | 'indexing';

export const SECTIONS: readonly { id: SettingsSection; label: string }[] = [
	{ id: 'general', label: 'General' },
	{ id: 'models', label: 'Models' },
	{ id: 'subscriptions', label: 'Subscriptions' },
	{ id: 'tab', label: 'Tab' },
	{ id: 'rules', label: 'Rules' },
	{ id: 'commands', label: 'Commands' },
	{ id: 'mcp', label: 'Tools and MCP' },
	{ id: 'indexing', label: 'Indexing' },
];

export type ProviderKey = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'deepseek' | 'xai' | 'mistral' | 'groq' | 'ollama' | 'lmstudio' | 'custom';

export interface CustomModel {
	provider: ProviderKey;
	model: string;
	label?: string;
	contextWindow?: number;
	baseUrl?: string;
}

/** Every `openCursor.*` value the panel reads or writes, keyed by the setting name without the prefix. */
export interface ConfigValues {
	'agent.autoRun': 'ask' | 'allowlist' | 'always';
	'agent.commandAllowlist': string[];
	'agent.commandDenylist': string[];
	'chat.defaultMode': 'agent' | 'plan' | 'debug' | 'ask';
	'chat.submitWithModEnter': boolean;
	'chat.showThinking': boolean;
	'chat.fontSize': number;
	'models.default': string;
	'models.inline': string;
	'models.tab': string;
	'models.enabled': string[];
	'models.custom': CustomModel[];
	'providers.ollama.baseUrl': string;
	'providers.ollama.numCtx': number;
	'providers.lmstudio.baseUrl': string;
	'providers.custom.baseUrl': string;
	'providers.openai.baseUrl': string;
	'cli.enabled': boolean;
	'tab.enabled': boolean;
	'tab.debounceMs': number;
	'rules.user': string;
	'index.enabled': boolean;
	'index.embeddingModel': string;
}

export type ConfigKey = keyof ConfigValues;

export const CONFIG_DEFAULTS: ConfigValues = {
	'agent.autoRun': 'ask',
	'agent.commandAllowlist': [],
	'agent.commandDenylist': [],
	'chat.defaultMode': 'agent',
	'chat.submitWithModEnter': false,
	'chat.showThinking': true,
	'chat.fontSize': 13,
	'models.default': '',
	'models.inline': '',
	'models.tab': '',
	'models.enabled': [],
	'models.custom': [],
	'providers.ollama.baseUrl': 'http://localhost:11434',
	'providers.ollama.numCtx': 16384,
	'providers.lmstudio.baseUrl': 'http://localhost:1234/v1',
	'providers.custom.baseUrl': '',
	'providers.openai.baseUrl': '',
	'cli.enabled': true,
	'tab.enabled': true,
	'tab.debounceMs': 120,
	'rules.user': '',
	'index.enabled': true,
	'index.embeddingModel': 'auto',
};

export interface ModelRow {
	id: string;
	label: string;
	provider: ProviderKey;
	/** Shown in the picker (not filtered out by models.enabled). */
	enabled: boolean;
	custom: boolean;
	contextWindow: number;
	supportsFim: boolean;
}

export interface ProviderRow {
	id: ProviderKey;
	label: string;
	/** A key is stored (or found in the environment). */
	hasKey: boolean;
	keyless: boolean;
}

export interface CliRow {
	id: 'claude-code' | 'codex' | 'grok' | 'gemini-cli';
	label: string;
	installed: boolean;
	binaryPath?: string;
	version?: string;
	loggedIn?: boolean;
	installHint: string;
	loginHint: string;
}

export interface McpRow {
	name: string;
	status: 'starting' | 'ready' | 'error' | 'disabled';
	error?: string;
	toolCount: number;
	source: string;
	transport: 'stdio' | 'http' | 'sse';
}

export interface IndexRow {
	state: 'disabled' | 'idle' | 'indexing' | 'ready' | 'error';
	files: number;
	chunks: number;
	progress?: number;
	error?: string;
}

export interface RuleRow {
	name: string;
	/** Where it came from: path relative to the workspace or home. */
	source: string;
	scope: 'workspace' | 'user' | 'legacy';
	uri: string;
	description?: string;
}

export interface CommandRow {
	name: string;
	description: string;
	source: string;
}

export interface SettingsState {
	config: ConfigValues;
	models: ModelRow[];
	providers: ProviderRow[];
	cli: CliRow[];
	mcp: McpRow[];
	index: IndexRow;
	rules: RuleRow[];
	commands: CommandRow[];
	hasWorkspace: boolean;
	platform: string;
}

export type SettingsHostMessage =
	| { readonly type: 'state'; readonly state: SettingsState; readonly section?: SettingsSection }
	| { readonly type: 'navigate'; readonly section: SettingsSection }
	| { readonly type: 'verify'; readonly provider: ProviderKey; readonly status: 'running' | 'ok' | 'error'; readonly message?: string }
	| { readonly type: 'toast'; readonly kind: 'info' | 'error'; readonly text: string };

export type SettingsWebviewMessage =
	| { readonly type: 'ready' }
	| { readonly type: 'setConfig'; readonly key: ConfigKey; readonly value: ConfigValues[ConfigKey] }
	| { readonly type: 'setKey'; readonly provider: ProviderKey; readonly key: string }
	| { readonly type: 'clearKey'; readonly provider: ProviderKey }
	| { readonly type: 'verify'; readonly provider: ProviderKey }
	| { readonly type: 'setModelEnabled'; readonly id: string; readonly enabled: boolean }
	| { readonly type: 'refreshModels' }
	| { readonly type: 'refreshCli' }
	| { readonly type: 'mcpSetEnabled'; readonly name: string; readonly enabled: boolean }
	| { readonly type: 'mcpReload' }
	| { readonly type: 'mcpOpenConfig'; readonly scope: 'user' | 'workspace' }
	| { readonly type: 'indexRebuild' }
	| { readonly type: 'indexClear' }
	| { readonly type: 'openRule'; readonly uri: string }
	| { readonly type: 'newRule'; readonly scope: 'workspace' | 'user' }
	| { readonly type: 'newCommand'; readonly scope: 'workspace' | 'user' }
	| { readonly type: 'openCommand'; readonly source: string }
	| { readonly type: 'openSettingsJson' };
