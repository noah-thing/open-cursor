/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Fake extension host for the settings webview. Query: ?section=models&theme=light&w=980
 *--------------------------------------------------------------------------------------------*/

import { CONFIG_DEFAULTS, type SettingsHostMessage, type SettingsState, type SettingsWebviewMessage } from '../../src/settings/protocol';

const params = new URLSearchParams(location.search);

const state: SettingsState = {
	config: { ...CONFIG_DEFAULTS, 'agent.autoRun': 'allowlist', 'agent.commandAllowlist': ['npm test', 'git status', 'ls'], 'agent.commandDenylist': ['rm', 'git push'], 'rules.user': 'Reply briefly. Prefer TypeScript.\nNever touch generated files.', 'models.custom': [{ provider: 'ollama', model: 'qwen2.5-coder:7b', label: 'Qwen coder 7b', contextWindow: 32768 }] },
	models: [
		{ id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'anthropic', enabled: true, custom: false, contextWindow: 200000, supportsFim: false },
		{ id: 'anthropic/claude-opus-5', label: 'Claude Opus 5', provider: 'anthropic', enabled: true, custom: false, contextWindow: 200000, supportsFim: false },
		{ id: 'openai/gpt-5.2', label: 'GPT-5.2', provider: 'openai', enabled: false, custom: false, contextWindow: 400000, supportsFim: false },
		{ id: 'mistral/codestral-latest', label: 'Codestral', provider: 'mistral', enabled: true, custom: false, contextWindow: 256000, supportsFim: true },
		{ id: 'ollama/qwen2.5-coder:7b', label: 'Qwen coder 7b', provider: 'ollama', enabled: true, custom: true, contextWindow: 32768, supportsFim: true },
	],
	providers: [
		{ id: 'anthropic', label: 'Anthropic', hasKey: true, keyless: false }, { id: 'openai', label: 'OpenAI', hasKey: false, keyless: false },
		{ id: 'google', label: 'Google Gemini', hasKey: true, keyless: false }, { id: 'openrouter', label: 'OpenRouter', hasKey: false, keyless: false },
		{ id: 'deepseek', label: 'DeepSeek', hasKey: false, keyless: false }, { id: 'xai', label: 'xAI', hasKey: false, keyless: false },
		{ id: 'mistral', label: 'Mistral', hasKey: true, keyless: false }, { id: 'groq', label: 'Groq', hasKey: false, keyless: false },
		{ id: 'ollama', label: 'Ollama', hasKey: true, keyless: true }, { id: 'lmstudio', label: 'LM Studio', hasKey: true, keyless: true },
		{ id: 'custom', label: 'Custom (OpenAI compatible)', hasKey: false, keyless: false },
	],
	cli: [
		{ id: 'claude-code', label: 'Claude Code', installed: true, binaryPath: '/Users/dev/.local/bin/claude', version: '2.4.1', loggedIn: true, installHint: 'npm install -g @anthropic-ai/claude-code', loginHint: 'Run `claude` once in a terminal and sign in with your Claude account.' },
		{ id: 'codex', label: 'Codex', installed: true, binaryPath: '/opt/homebrew/bin/codex', version: '0.9.0', loggedIn: false, installHint: 'npm install -g @openai/codex', loginHint: 'Run `codex login` in a terminal and sign in with ChatGPT.' },
		{ id: 'gemini-cli', label: 'Gemini CLI', installed: false, installHint: 'npm install -g @google/gemini-cli', loginHint: 'Run `gemini` once in a terminal and sign in with Google.' },
	],
	mcp: [
		{ name: 'filesystem', status: 'ready', toolCount: 11, source: '~/.open-cursor/mcp.json', transport: 'stdio' },
		{ name: 'github', status: 'error', error: 'spawn npx ENOENT. Is Node on your PATH?', toolCount: 0, source: '.cursor/mcp.json', transport: 'stdio' },
		{ name: 'figma', status: 'disabled', toolCount: 0, source: '.cursor/mcp.json', transport: 'http' },
	],
	index: { state: 'indexing', files: 1284, chunks: 9120, progress: 0.62 },
	rules: [
		{ name: 'typescript-style', source: '.cursor/rules/typescript-style.mdc', scope: 'workspace', uri: 'file:///a', description: 'Strict TypeScript, tabs, no default exports' },
		{ name: 'testing', source: '.open-cursor/rules/testing.mdc', scope: 'workspace', uri: 'file:///b' },
		{ name: 'AGENTS.md', source: 'AGENTS.md', scope: 'legacy', uri: 'file:///c' },
	],
	commands: [
		{ name: 'review', description: 'Review the working tree for bugs', source: '.cursor/commands/review.md' },
		{ name: 'commit', description: 'Write a conventional commit message', source: '~/.open-cursor/commands/commit.md' },
	],
	hasWorkspace: true,
	platform: 'darwin',
};

function emit(m: SettingsHostMessage): void { window.postMessage(m, '*'); }

let saved: unknown;
(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
	getState: () => saved,
	setState: (s: unknown) => { saved = s; },
	postMessage: (m: SettingsWebviewMessage) => {
		setTimeout(() => {
			if (m.type === 'ready') {
				emit({ type: 'state', state, section: (params.get('section') as 'general') || undefined });
				if (params.get('verify')) { setTimeout(() => emit({ type: 'verify', provider: 'anthropic', status: 'ok', message: 'Connected, 14 models' }), 50); setTimeout(() => emit({ type: 'verify', provider: 'mistral', status: 'error', message: 'Invalid API key (401)' }), 60); }
			} else if (m.type === 'verify') {
				emit({ type: 'verify', provider: m.provider, status: 'running' });
				setTimeout(() => emit({ type: 'verify', provider: m.provider, status: 'ok', message: 'Connected' }), 800);
			} else if (m.type === 'setConfig') {
				(state.config as unknown as Record<string, unknown>)[m.key] = m.value;
			} else {
				console.info('[mock settings host]', m);
			}
		}, 0);
	},
});
