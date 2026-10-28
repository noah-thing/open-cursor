/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Settings editor panel: a webview that reads and writes `openCursor.*` configuration and drives
 *  the registry, CLI detection, MCP, index and rules services.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import type { Services } from '../services';
import type { ModelInfo } from '../providers/types';
import { cliHint } from '../shared/cliHints';
import {
	CONFIG_DEFAULTS, SECTIONS,
	type CliRow, type CommandRow, type ConfigKey, type ConfigValues, type ModelRow, type ProviderKey, type ProviderRow,
	type RuleRow, type SettingsHostMessage, type SettingsSection, type SettingsState, type SettingsWebviewMessage,
} from './protocol';

const PROVIDERS: { id: ProviderKey; label: string; keyless: boolean }[] = [
	{ id: 'anthropic', label: 'Anthropic', keyless: false },
	{ id: 'openai', label: 'OpenAI', keyless: false },
	{ id: 'google', label: 'Google Gemini', keyless: false },
	{ id: 'openrouter', label: 'OpenRouter', keyless: false },
	{ id: 'deepseek', label: 'DeepSeek', keyless: false },
	{ id: 'xai', label: 'xAI', keyless: false },
	{ id: 'mistral', label: 'Mistral', keyless: false },
	{ id: 'groq', label: 'Groq', keyless: false },
	{ id: 'ollama', label: 'Ollama', keyless: true },
	{ id: 'lmstudio', label: 'LM Studio', keyless: true },
	{ id: 'custom', label: 'Custom (OpenAI compatible)', keyless: false },
];



const MODELS_CACHE_KEY = 'openCursor.settings.allModels';
const RULE_EXTS = new Set(['.md', '.mdc']);

function homeDir(): string {
	return os.homedir();
}

function cfg(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration('openCursor');
}

function readConfig(): ConfigValues {
	const c = cfg();
	const out: Record<string, unknown> = {};
	for (const [key, def] of Object.entries(CONFIG_DEFAULTS)) {
		out[key] = c.get(key, def);
	}
	return out as unknown as ConfigValues;
}

function isValid(key: ConfigKey, value: unknown): boolean {
	const def = CONFIG_DEFAULTS[key];
	if (Array.isArray(def)) {
		return Array.isArray(value) && (key === 'models.custom' || value.every(v => typeof v === 'string'));
	}
	return typeof value === typeof def;
}

async function readDirSafe(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
	try {
		return await vscode.workspace.fs.readDirectory(uri);
	} catch {
		return [];
	}
}

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

async function scanRules(dir: vscode.Uri, label: string, scope: RuleRow['scope'], depth = 0): Promise<RuleRow[]> {
	const out: RuleRow[] = [];
	for (const [name, type] of await readDirSafe(dir)) {
		const child = vscode.Uri.joinPath(dir, name);
		if (type & vscode.FileType.Directory) {
			if (depth < 2) { out.push(...await scanRules(child, label + '/' + name, scope, depth + 1)); }
		} else if (RULE_EXTS.has(nodePath.extname(name).toLowerCase())) {
			let description: string | undefined;
			try {
				const text = Buffer.from(await vscode.workspace.fs.readFile(child)).toString('utf8').slice(0, 2000);
				description = /^---[\s\S]*?^description:\s*["']?(.+?)["']?\s*$/m.exec(text)?.[1];
			} catch { /* unreadable, list without description */ }
			out.push({ name: name.replace(/\.(mdc|md)$/i, ''), source: label + '/' + name, scope, uri: child.toString(), description: description || undefined });
		}
	}
	return out;
}

async function listRules(): Promise<RuleRow[]> {
	const out: RuleRow[] = [];
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		for (const d of ['.open-cursor/rules', '.cursor/rules']) {
			out.push(...await scanRules(vscode.Uri.joinPath(folder.uri, d), d, 'workspace'));
		}
		for (const f of ['AGENTS.md', 'CLAUDE.md', '.cursorrules']) {
			const u = vscode.Uri.joinPath(folder.uri, f);
			if (await exists(u)) { out.push({ name: f, source: f, scope: 'legacy', uri: u.toString() }); }
		}
	}
	out.push(...await scanRules(vscode.Uri.file(nodePath.join(homeDir(), '.open-cursor', 'rules')), '~/.open-cursor/rules', 'user'));
	return out;
}

function resolveSource(source: string): vscode.Uri | undefined {
	if (source.startsWith('~')) { return vscode.Uri.file(nodePath.join(homeDir(), source.slice(1))); }
	if (nodePath.isAbsolute(source)) { return vscode.Uri.file(source); }
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	return root ? vscode.Uri.joinPath(root, source) : undefined;
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let s = '';
	for (let i = 0; i < 32; i++) { s += chars.charAt(Math.floor(Math.random() * chars.length)); }
	return s;
}

class SettingsPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private pushTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingSection: SettingsSection | undefined;

	constructor(private readonly ctx: vscode.ExtensionContext, private readonly services: Services) {
		const push = () => this.schedulePush();
		this.disposables.push(
			services.registry.onDidChangeModels(push),
			services.mcp.onDidChange(push),
			services.index.onDidChange(push),
			services.cli.onDidChange(push),
			vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('openCursor')) { push(); } }),
			vscode.workspace.onDidChangeWorkspaceFolders(push),
		);
	}

	open(section?: SettingsSection): void {
		if (this.panel) {
			this.panel.reveal(undefined, false);
			if (section) { this.post({ type: 'navigate', section }); }
			return;
		}
		this.pendingSection = section;
		const distRoot = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview');
		const panel = vscode.window.createWebviewPanel('openCursor.settings', 'OpenCursor Settings', vscode.ViewColumn.Active, {
			enableScripts: true,
			localResourceRoots: [distRoot],
			retainContextWhenHidden: false,
		});
		this.panel = panel;
		panel.webview.html = this.html(panel.webview, distRoot);
		panel.webview.onDidReceiveMessage((m: SettingsWebviewMessage) => { void this.onMessage(m); }, undefined, this.disposables);
		panel.onDidDispose(() => { this.panel = undefined; }, undefined, this.disposables);
	}

	dispose(): void {
		if (this.pushTimer) { clearTimeout(this.pushTimer); }
		this.panel?.dispose();
		this.disposables.forEach(d => d.dispose());
	}

	private html(webview: vscode.Webview, distRoot: vscode.Uri): string {
		const nonce = getNonce();
		const script = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'settings.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'settings.css'));
		const csp = [
			`default-src 'none'`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src 'nonce-${nonce}'`,
			`img-src ${webview.cspSource} data:`,
			`font-src ${webview.cspSource}`,
		].join('; ');
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>OpenCursor Settings</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}

	private post(m: SettingsHostMessage): void {
		void this.panel?.webview.postMessage(m);
	}

	private schedulePush(): void {
		if (!this.panel) { return; }
		if (this.pushTimer) { clearTimeout(this.pushTimer); }
		this.pushTimer = setTimeout(() => { this.pushTimer = undefined; void this.pushState(); }, 150);
	}

	private async pushState(section?: SettingsSection): Promise<void> {
		if (!this.panel) { return; }
		try {
			const state = await this.buildState();
			this.post({ type: 'state', state, section });
		} catch (e) {
			this.post({ type: 'toast', kind: 'error', text: 'Could not load settings: ' + (e as Error).message });
		}
	}

	private toast(kind: 'info' | 'error', text: string): void {
		this.post({ type: 'toast', kind, text });
	}

	private async allModels(config: ConfigValues): Promise<ModelInfo[]> {
		const current = this.services.registry.getModels();
		if (!config['models.enabled'].length) {
			void this.ctx.globalState.update(MODELS_CACHE_KEY, current);
			return current;
		}
		const cached = this.ctx.globalState.get<ModelInfo[]>(MODELS_CACHE_KEY, []);
		const map = new Map<string, ModelInfo>();
		for (const m of cached) { map.set(m.id, m); }
		for (const m of current) { map.set(m.id, m); }
		return [...map.values()];
	}

	private async buildState(): Promise<SettingsState> {
		const config = readConfig();
		const { registry, cli, mcp, index, context } = this.services;
		const all = await this.allModels(config);
		const enabled = new Set(config['models.enabled']);
		const models: ModelRow[] = all.map(m => ({
			id: m.id,
			label: m.label,
			provider: m.provider,
			enabled: enabled.size === 0 || enabled.has(m.id),
			custom: !!m.custom,
			contextWindow: m.contextWindow,
			supportsFim: !!m.supportsFim,
		}));
		const providers: ProviderRow[] = await Promise.all(PROVIDERS.map(async p => ({
			id: p.id, label: p.label, keyless: p.keyless, hasKey: p.keyless ? true : await registry.hasKey(p.id).catch(() => false),
		})));
		let cliRows: CliRow[] = [];
		try {
			cliRows = (await cli.detect()).map(a => ({
				id: a.id,
				label: a.label,
				installed: !!a.binaryPath,
				binaryPath: a.binaryPath,
				version: a.version,
				loggedIn: a.loggedIn,
				installHint: cliHint(a.id).install,
				loginHint: cliHint(a.id).login,
			}));
		} catch { /* detection failed, show none */ }
		const commands: CommandRow[] = await context.getSlashCommands().then(list => list.map(c => ({ name: c.name, description: c.description, source: c.source }))).catch(() => []);
		return {
			config,
			models,
			providers,
			cli: cliRows,
			mcp: mcp.getServers().map(s => ({ name: s.name, status: s.status, error: s.error, toolCount: s.toolCount, source: s.source, transport: s.transport })),
			index: index.getStatus(),
			rules: await listRules(),
			commands,
			hasWorkspace: (vscode.workspace.workspaceFolders?.length ?? 0) > 0,
			platform: process.platform,
		};
	}

	private async setConfig(key: ConfigKey, value: unknown): Promise<void> {
		if (!(key in CONFIG_DEFAULTS) || !isValid(key, value)) { return; }
		const same = JSON.stringify(value) === JSON.stringify(CONFIG_DEFAULTS[key]);
		await cfg().update(key, same ? undefined : value, vscode.ConfigurationTarget.Global);
	}

	private async newFile(kind: 'rule' | 'command', scope: 'workspace' | 'user'): Promise<void> {
		const name = await vscode.window.showInputBox({
			title: kind === 'rule' ? 'New rule' : 'New slash command',
			prompt: 'File name without extension, for example ' + (kind === 'rule' ? 'typescript-style' : 'review'),
			validateInput: v => (/^[\w][\w.-]*$/.test(v) ? undefined : 'Use letters, digits, dash, dot or underscore.'),
		});
		if (!name) { return; }
		const sub = kind === 'rule' ? 'rules' : 'commands';
		const ext = kind === 'rule' ? '.mdc' : '.md';
		let base: vscode.Uri;
		if (scope === 'workspace') {
			const root = vscode.workspace.workspaceFolders?.[0]?.uri;
			if (!root) { this.toast('error', 'Open a folder first to add a workspace ' + kind + '.'); return; }
			base = vscode.Uri.joinPath(root, '.open-cursor', sub);
		} else {
			base = vscode.Uri.file(nodePath.join(homeDir(), '.open-cursor', sub));
		}
		const file = vscode.Uri.joinPath(base, name + ext);
		try {
			await vscode.workspace.fs.createDirectory(base);
			if (!(await exists(file))) {
				const template = kind === 'rule'
					? '---\ndescription: \nglobs: \nalwaysApply: false\n---\n\nWrite the rule here. Keep it short and specific.\n'
					: 'Describe what this command should do. Use $ARGUMENTS for anything typed after the command name.\n';
				await vscode.workspace.fs.writeFile(file, Buffer.from(template, 'utf8'));
			}
			await vscode.window.showTextDocument(file);
		} catch (e) {
			this.toast('error', 'Could not create the file: ' + (e as Error).message);
		}
	}

	private async onMessage(m: SettingsWebviewMessage): Promise<void> {
		const { registry, cli, mcp, index } = this.services;
		switch (m.type) {
			case 'ready': {
				const section = this.pendingSection;
				this.pendingSection = undefined;
				await this.pushState(section);
				return;
			}
			case 'setConfig':
				await this.setConfig(m.key, m.value);
				return;
			case 'setKey':
				try {
					await registry.setKey(m.provider, m.key.trim() || undefined);
					await registry.refreshModels();
					this.toast('info', 'Saved the key in the system keychain.');
				} catch (e) {
					this.toast('error', 'Could not save the key: ' + (e as Error).message);
				}
				this.schedulePush();
				return;
			case 'clearKey':
				await registry.setKey(m.provider, undefined);
				await registry.refreshModels().catch(() => undefined);
				this.schedulePush();
				return;
			case 'verify': {
				this.post({ type: 'verify', provider: m.provider, status: 'running' });
				try {
					const provider = registry.getProvider(m.provider);
					const res = provider.verify ? await provider.verify(AbortSignal.timeout(15000)) : { ok: true, message: 'Nothing to verify.' };
					this.post({ type: 'verify', provider: m.provider, status: res.ok ? 'ok' : 'error', message: res.message });
					if (res.ok) { void registry.refreshModels().catch(() => undefined); }
				} catch (e) {
					this.post({ type: 'verify', provider: m.provider, status: 'error', message: (e as Error).message });
				}
				return;
			}
			case 'setModelEnabled': {
				const config = readConfig();
				const all = await this.allModels(config);
				const ids = all.map(x => x.id);
				const current = config['models.enabled'];
				const set = new Set(current.length ? current : ids);
				if (m.enabled) { set.add(m.id); } else { set.delete(m.id); }
				const next = set.size >= ids.length && ids.every(id => set.has(id)) ? [] : [...set];
				await this.setConfig('models.enabled', next);
				return;
			}
			case 'refreshModels':
				await registry.refreshModels().catch(e => this.toast('error', (e as Error).message));
				this.schedulePush();
				return;
			case 'refreshCli':
				await cli.detect().catch(() => []);
				this.schedulePush();
				return;
			case 'mcpSetEnabled':
				await mcp.setEnabled(m.name, m.enabled).catch(e => this.toast('error', (e as Error).message));
				return;
			case 'mcpReload':
				await mcp.reload().catch(e => this.toast('error', (e as Error).message));
				return;
			case 'mcpOpenConfig':
				await mcp.openConfig(m.scope).catch(e => this.toast('error', (e as Error).message));
				return;
			case 'indexRebuild':
				void index.rebuild().catch(e => this.toast('error', (e as Error).message));
				return;
			case 'indexClear':
				await index.clear().catch(e => this.toast('error', (e as Error).message));
				return;
			case 'openRule':
				try { await vscode.window.showTextDocument(vscode.Uri.parse(m.uri)); } catch (e) { this.toast('error', (e as Error).message); }
				return;
			case 'newRule':
				await this.newFile('rule', m.scope);
				return;
			case 'newCommand':
				await this.newFile('command', m.scope);
				return;
			case 'openCommand': {
				const uri = resolveSource(m.source);
				if (uri) { try { await vscode.window.showTextDocument(uri); } catch (e) { this.toast('error', (e as Error).message); } }
				return;
			}
			case 'openSettingsJson':
				await vscode.commands.executeCommand('workbench.action.openSettings', 'openCursor');
				return;
		}
	}
}

export function registerSettings(ctx: vscode.ExtensionContext, services: Services): void {
	const panel = new SettingsPanel(ctx, services);
	const valid = new Set<string>(SECTIONS.map(s => s.id));
	ctx.subscriptions.push(
		panel,
		vscode.commands.registerCommand('openCursor.settings.open', (arg?: string | { section?: string }) => {
			const s = typeof arg === 'string' ? arg : arg?.section;
			panel.open(s && valid.has(s) ? (s as SettingsSection) : undefined);
		}),
	);
}
