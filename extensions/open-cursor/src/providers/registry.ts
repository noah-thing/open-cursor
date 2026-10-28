/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { IProviderRegistry } from '../services';
import type { ModelOption } from '../shared/protocol';
import { CATALOG, ENV_KEYS, KEYLESS, LOCAL, PROVIDER_LABELS, guessModelInfo, modelId } from './catalog';
import { createAdapter } from './factory';
import { ProviderError, type ChatRequest, type FimRequest, type LLMProvider, type ModelInfo, type ProviderId, type StreamEvent } from './types';

const SECRET_PREFIX = 'openCursor.key.';
const CACHE_KEY = 'openCursor.models.discovery.v1';
const TTL_MS = 24 * 60 * 60 * 1000;

const PROVIDERS: readonly ProviderId[] = ['anthropic', 'openai', 'google', 'openrouter', 'deepseek', 'xai', 'mistral', 'groq', 'ollama', 'lmstudio', 'custom'];
const KEY_PROVIDERS: readonly ProviderId[] = PROVIDERS.filter(p => !KEYLESS.has(p));

const DEFAULT_BASE: Record<ProviderId, string> = {
	anthropic: 'https://api.anthropic.com',
	openai: 'https://api.openai.com/v1',
	google: 'https://generativelanguage.googleapis.com',
	openrouter: 'https://openrouter.ai/api/v1',
	deepseek: 'https://api.deepseek.com',
	xai: 'https://api.x.ai/v1',
	mistral: 'https://api.mistral.ai/v1',
	groq: 'https://api.groq.com/openai/v1',
	ollama: 'http://localhost:11434',
	lmstudio: 'http://localhost:1234/v1',
	custom: '',
};

/** Settings that carry a base URL, per provider. */
const BASE_SETTING: Partial<Record<ProviderId, string>> = {
	ollama: 'providers.ollama.baseUrl',
	lmstudio: 'providers.lmstudio.baseUrl',
	custom: 'providers.custom.baseUrl',
	openai: 'providers.openai.baseUrl',
};

interface CustomEntry { provider: string; model: string; label?: string; contextWindow?: number; baseUrl?: string }
type DiscoveryCache = Partial<Record<ProviderId, { ts: number; models: ModelInfo[] }>>;

type Pref = string | RegExp;
function pick(models: ModelInfo[], prefs: Pref[]): ModelInfo | undefined {
	for (const p of prefs) {
		const m = models.find(x => typeof p === 'string' ? x.id === p : p.test(x.id));
		if (m) { return m; }
	}
	return undefined;
}

const CHAT_PREFS: Pref[] = [
	'anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5',
	/^openai\/gpt-5(\.\d+)?$/, /^google\/gemini-[\d.]+-pro$/, 'deepseek/deepseek-chat', /^xai\/grok-4/, /^mistral\/mistral-large/,
	/^openrouter\/anthropic\/claude-sonnet/, /^ollama\/.*(qwen3|qwen2\.5-coder|llama3)/,
];
const INLINE_PREFS: Pref[] = [
	'anthropic/claude-haiku-5-5', /^google\/gemini-[\d.]+-flash$/, /^openai\/(gpt-5(\.\d+)?-mini|gpt-4\.1-mini|gpt-4o-mini)$/, 'deepseek/deepseek-chat',
	/^mistral\/(codestral|mistral-small)/, /^groq\//, /^xai\/.*(fast|mini)/, /^ollama\/.*coder/,
];

class ProviderRegistry implements IProviderRegistry, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeModels = this.emitter.event;
	private readonly adapters = new Map<ProviderId, LLMProvider>();
	private readonly keys = new Map<ProviderId, string | undefined>();
	private readonly discovered = new Map<ProviderId, ModelInfo[]>();
	private readonly inflight = new Map<ProviderId, Promise<void>>();
	private readonly overrides = new Map<string, string>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly keysLoaded: Promise<void>;
	private cache: DiscoveryCache;
	private started?: Promise<void>;
	private all?: ModelInfo[];

	constructor(private readonly ctx: vscode.ExtensionContext) {
		this.cache = ctx.globalState.get<DiscoveryCache>(CACHE_KEY, {});
		this.keysLoaded = Promise.all(KEY_PROVIDERS.map(p => this.readKey(p))).then(() => undefined);
		this.disposables.push(
			this.emitter,
			ctx.secrets.onDidChange(async e => {
				const id = KEY_PROVIDERS.find(p => SECRET_PREFIX + p === e.key);
				if (!id) { return; }
				const before = this.keys.get(id);
				await this.readKey(id);
				if (before !== this.keys.get(id)) { this.keyChanged(id); }
			}),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (!e.affectsConfiguration('openCursor.models') && !e.affectsConfiguration('openCursor.providers')) { return; }
				this.all = undefined;
				for (const p of PROVIDERS) {
					const s = BASE_SETTING[p];
					if ((s && e.affectsConfiguration('openCursor.' + s)) || (p === 'ollama' && e.affectsConfiguration('openCursor.providers.ollama'))) {
						this.discovered.delete(p);
						void this.discover(p, true);
					}
				}
				this.emitter.fire();
			}),
		);
	}

	dispose(): void { this.disposables.forEach(d => d.dispose()); }

	private cfg<T>(key: string, fallback: T): T { return vscode.workspace.getConfiguration('openCursor').get<T>(key, fallback); }

	private async readKey(id: ProviderId): Promise<string | undefined> {
		let key = (await this.ctx.secrets.get(SECRET_PREFIX + id))?.trim();
		if (!key) {
			for (const name of ENV_KEYS[id] ?? []) { const v = process.env[name]?.trim(); if (v) { key = v; break; } }
		}
		this.keys.set(id, key || undefined);
		return key || undefined;
	}

	private keyFor(id: ProviderId): Promise<string | undefined> | string | undefined {
		return this.keys.has(id) ? this.keys.get(id) : this.readKey(id);
	}

	private hasKeySync(id: ProviderId): boolean {
		if (KEYLESS.has(id)) { return true; }
		if (id === 'custom') { return !!this.cfg('providers.custom.baseUrl', ''); }
		return !!this.keys.get(id);
	}

	async hasKey(id: ProviderId): Promise<boolean> {
		await this.keysLoaded;
		return this.hasKeySync(id);
	}

	async setKey(id: ProviderId, key: string | undefined): Promise<void> {
		const k = key?.trim();
		if (k) { await this.ctx.secrets.store(SECRET_PREFIX + id, k); } else { await this.ctx.secrets.delete(SECRET_PREFIX + id); }
		await this.readKey(id);
		this.keyChanged(id);
	}

	private keyChanged(id: ProviderId): void {
		this.discovered.delete(id);
		delete this.cache[id];
		this.all = undefined;
		this.emitter.fire();
		if (this.keys.get(id)) { void this.discover(id, true); } else { void this.ctx.globalState.update(CACHE_KEY, this.cache); }
	}

	private baseUrl(id: ProviderId): (model?: string) => string {
		return model => {
			const o = model ? this.overrides.get(model) : undefined;
			const s = BASE_SETTING[id];
			const v = (o || (s ? this.cfg<string>(s, '') : '') || DEFAULT_BASE[id]).trim();
			if (!v) { throw new ProviderError('Set openCursor.providers.custom.baseUrl to your OpenAI-compatible endpoint.', id, undefined, 'other'); }
			return v;
		};
	}

	getProvider(id: ProviderId): LLMProvider {
		let a = this.adapters.get(id);
		if (!a) {
			a = createAdapter(id, { getKey: () => this.keyFor(id), baseUrl: this.baseUrl(id), numCtx: () => this.cfg('providers.ollama.numCtx', 16384) });
			this.adapters.set(id, a);
		}
		return a;
	}

	private ensureStarted(): void {
		this.started ??= (async () => {
			await this.keysLoaded;
			let any = false;
			for (const p of PROVIDERS) {
				const c = this.cache[p];
				if (c && this.hasKeySync(p) && !this.discovered.has(p)) { this.discovered.set(p, c.models); any = true; }
			}
			if (any) { this.all = undefined; this.emitter.fire(); }
			await Promise.all(PROVIDERS.map(p => this.discover(p, false)));
		})().catch(() => undefined);
	}

	refreshModels(): Promise<void> {
		this.started ??= Promise.resolve();
		return this.keysLoaded.then(() => Promise.all(PROVIDERS.map(p => this.discover(p, true)))).then(() => undefined);
	}

	private discover(id: ProviderId, force: boolean): Promise<void> {
		let p = this.inflight.get(id);
		if (!p) {
			p = this.doDiscover(id, force).catch(() => undefined).finally(() => this.inflight.delete(id));
			this.inflight.set(id, p);
		}
		return p;
	}

	private async doDiscover(id: ProviderId, force: boolean): Promise<void> {
		await this.keysLoaded;
		const adapter = this.getProvider(id);
		if (!adapter.listModels || !this.hasKeySync(id)) { return; }
		const c = this.cache[id];
		if (!force && !LOCAL.has(id) && c && Date.now() - c.ts < TTL_MS) { this.discovered.set(id, c.models); return; }
		const timeout = LOCAL.has(id) ? 1500 : id === 'custom' ? 4000 : 15000;
		let models: ModelInfo[] | undefined;
		try {
			models = await adapter.listModels(AbortSignal.timeout(timeout));
		} catch {
			if (LOCAL.has(id) && this.discovered.delete(id)) { this.all = undefined; this.emitter.fire(); }
			return; // hosted: keep whatever is cached
		}
		if (id !== 'anthropic') { models.sort((a, b) => a.label.localeCompare(b.label)); }
		const changed = JSON.stringify(this.discovered.get(id)) !== JSON.stringify(models);
		this.discovered.set(id, models);
		this.cache[id] = { ts: Date.now(), models };
		void this.ctx.globalState.update(CACHE_KEY, this.cache);
		if (changed) { this.all = undefined; this.emitter.fire(); }
	}

	private allModels(): ModelInfo[] {
		if (this.all) { return this.all; }
		const map = new Map<string, ModelInfo>();
		for (const m of CATALOG) { map.set(m.id, m); }
		for (const list of this.discovered.values()) { for (const m of list) { if (!map.has(m.id)) { map.set(m.id, m); } } }
		this.overrides.clear();
		for (const e of this.cfg<CustomEntry[]>('models.custom', [])) {
			if (!e || !(PROVIDERS as readonly string[]).includes(e.provider) || !e.model) { continue; }
			const provider = e.provider as ProviderId;
			const id = modelId(provider, e.model);
			const base = map.get(id) ?? guessModelInfo(provider, e.model, provider === 'custom' ? { supportsFim: undefined } : {});
			const ctx = e.contextWindow && e.contextWindow > 0 ? e.contextWindow : base.contextWindow;
			map.set(id, { ...base, label: e.label || base.label, contextWindow: ctx, maxOutputTokens: Math.min(base.maxOutputTokens, ctx), custom: true });
			if (e.baseUrl) { this.overrides.set(id, e.baseUrl); }
		}
		const rank = (m: ModelInfo) => PROVIDERS.indexOf(m.provider);
		this.all = [...map.values()].sort((a, b) => rank(a) - rank(b));
		return this.all;
	}

	getModels(): ModelInfo[] {
		this.ensureStarted();
		const enabled = this.cfg<string[]>('models.enabled', []);
		const all = this.allModels();
		if (!enabled.length) { return all; }
		const set = new Set(enabled);
		return all.filter(m => m.custom || set.has(m.id));
	}

	getModel(id: string): ModelInfo | undefined {
		if (id.startsWith('cli:')) { return undefined; }
		this.ensureStarted();
		const hit = this.allModels().find(m => m.id === id);
		if (hit) { return hit; }
		// A model from an old chat that is no longer listed: still usable if the provider is known.
		const slash = id.indexOf('/');
		const provider = id.slice(0, slash) as ProviderId;
		return slash > 0 && (PROVIDERS as readonly string[]).includes(provider) ? guessModelInfo(provider, id.slice(slash + 1)) : undefined;
	}

	getDefaultModel(purpose: 'chat' | 'inline' | 'tab'): ModelInfo | undefined {
		const setting = this.cfg<string>(purpose === 'chat' ? 'models.default' : purpose === 'inline' ? 'models.inline' : 'models.tab', '');
		if (setting) { const m = this.getModel(setting); if (m) { return m; } }
		const avail = this.getModels().filter(m => this.hasKeySync(m.provider));
		const tools = avail.filter(m => m.supportsTools);
		const chat = () => pick(tools, CHAT_PREFS) ?? tools[0] ?? this.allModels().find(m => m.id === 'anthropic/claude-sonnet-5-5');
		if (purpose === 'chat') { return chat(); }
		const inline = () => pick(tools, INLINE_PREFS) ?? chat();
		if (purpose === 'inline') { return inline(); }
		const fim = avail.filter(m => m.supportsFim);
		return pick(fim, [/^mistral\/codestral/, 'deepseek/deepseek-chat']) ?? fim.find(m => m.provider === 'ollama' && /coder/i.test(m.model)) ?? fim.find(m => m.provider === 'ollama') ?? fim[0] ?? inline();
	}

	async listOptions(): Promise<ModelOption[]> {
		await this.keysLoaded;
		return this.getModels().map(m => ({
			id: m.id, label: m.label, provider: m.provider, supportsImages: m.supportsImages, supportsThinking: m.supportsThinking, hasKey: this.hasKeySync(m.provider),
		}));
	}

	async* stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
		if (req.model.id.startsWith('cli:')) { throw new ProviderError('CLI agent models are not served by the provider registry.', 'custom'); }
		this.allModels(); // refresh per-model base URL overrides
		yield* this.getProvider(req.model.provider).stream(req);
	}

	async* fim(req: FimRequest): AsyncGenerator<string> {
		this.allModels();
		const p = this.getProvider(req.model.provider);
		if (p.fim && req.model.supportsFim) { yield* p.fim(req); return; }
		yield* this.chatFim(p, req);
	}

	/** FIM emulated with a chat model: ask for just the missing middle. */
	private async* chatFim(p: LLMProvider, req: FimRequest): AsyncGenerator<string> {
		const system = 'You are a code completion engine. The user gives text before and after the cursor. Reply with ONLY the code that belongs at the cursor. No explanation, no markdown fences, do not repeat the surrounding text.';
		const user = `<before_cursor>\n${req.prefix}</before_cursor>\n<after_cursor>\n${req.suffix}</after_cursor>`;
		let buf = '';
		let started = false;
		let emitted = '';
		const stops = req.stop ?? [];
		const cut = (s: string): number => stops.reduce((at, st) => { const i = (emitted + s).indexOf(st); return i >= 0 && (at < 0 || i - emitted.length < at) ? i - emitted.length : at; }, -1);
		for await (const ev of p.stream({ model: req.model, system, messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], maxTokens: req.maxTokens, temperature: req.temperature ?? 0, thinking: false, signal: req.signal })) {
			if (ev.type !== 'text') { continue; }
			buf += ev.text;
			if (!started) {
				if (buf.length < 3 && '```'.startsWith(buf)) { continue; }
				started = true;
				if (buf.startsWith('```')) { const nl = buf.indexOf('\n'); if (nl < 0) { started = false; continue; } buf = buf.slice(nl + 1); }
			}
			const fence = buf.indexOf('```');
			let hold = 0;
			while (hold < 2 && buf.endsWith('`'.repeat(hold + 1))) { hold++; }
			let out = fence >= 0 ? buf.slice(0, fence) : buf.slice(0, buf.length - hold);
			const stopAt = cut(out);
			if (stopAt >= 0) { out = out.slice(0, stopAt); }
			if (out) { yield out; emitted += out; }
			if (fence >= 0 || stopAt >= 0) { return; }
			buf = buf.slice(out.length);
		}
		if (buf && !buf.includes('```')) { yield buf; }
	}

	async verify(id: ProviderId): Promise<{ ok: boolean; message: string }> {
		await this.keysLoaded;
		if (!this.hasKeySync(id)) { return { ok: false, message: id === 'custom' ? 'Set openCursor.providers.custom.baseUrl first.' : `No API key for ${PROVIDER_LABELS[id]}.` }; }
		const p = this.getProvider(id);
		if (!p.verify) { return { ok: true, message: 'Nothing to verify.' }; }
		try { return await p.verify(AbortSignal.timeout(15000)); } catch (e) { return { ok: false, message: (e as Error).message }; }
	}

	private async pickProvider(placeHolder: string, only?: (p: ProviderId) => boolean): Promise<ProviderId | undefined> {
		await this.keysLoaded;
		const items = PROVIDERS.filter(p => !only || only(p)).map(p => ({
			label: PROVIDER_LABELS[p], description: KEYLESS.has(p) ? 'local' : this.keys.get(p) ? 'key set' : '', id: p,
		}));
		return (await vscode.window.showQuickPick(items, { placeHolder }))?.id;
	}

	async promptSetKey(provider?: ProviderId, key?: string): Promise<void> {
		if (provider && key !== undefined) { await this.setKey(provider, key); return; }
		const id = provider ?? await this.pickProvider('Choose a provider to set an API key for', p => !KEYLESS.has(p));
		if (!id) { return; }
		const value = await vscode.window.showInputBox({
			title: `${PROVIDER_LABELS[id]} API key`, prompt: this.keys.get(id) ? 'Enter a new key, or leave empty to remove the stored key.' : 'Paste your API key. It is stored in the OS keychain.',
			password: true, ignoreFocusOut: true,
		});
		if (value === undefined) { return; }
		await this.setKey(id, value);
		if (!value.trim()) { void vscode.window.showInformationMessage(`${PROVIDER_LABELS[id]} key removed.`); return; }
		const r = await this.verify(id);
		void (r.ok ? vscode.window.showInformationMessage(`${PROVIDER_LABELS[id]}: ${r.message}`) : vscode.window.showWarningMessage(`${PROVIDER_LABELS[id]} key saved, but verification failed: ${r.message}`));
	}

	async verifyCommand(provider?: ProviderId): Promise<{ ok: boolean; message: string } | undefined> {
		if (provider) { return this.verify(provider); }
		const id = await this.pickProvider('Choose a provider to verify');
		if (!id) { return undefined; }
		const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Verifying ${PROVIDER_LABELS[id]}` }, () => this.verify(id));
		void (r.ok ? vscode.window.showInformationMessage(`${PROVIDER_LABELS[id]}: ${r.message}`) : vscode.window.showWarningMessage(`${PROVIDER_LABELS[id]}: ${r.message}`));
		return r;
	}
}

export function createProviderRegistry(ctx: vscode.ExtensionContext): IProviderRegistry {
	const reg = new ProviderRegistry(ctx);
	ctx.subscriptions.push(
		reg,
		vscode.commands.registerCommand('openCursor.models.list', () => reg.listOptions()),
		vscode.commands.registerCommand('openCursor.models.getDefault', (purpose: 'chat' | 'inline' | 'tab' = 'chat') => reg.getDefaultModel(purpose)?.id ?? ''),
		vscode.commands.registerCommand('openCursor.providers.setKey', (provider?: ProviderId, key?: string) => reg.promptSetKey(provider, key)),
		vscode.commands.registerCommand('openCursor.providers.verify', (provider?: ProviderId) => reg.verifyCommand(provider)),
	);
	return reg;
}
