/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { Services } from '../services';
import type { ProviderId } from '../providers/types';
import { FREE_PROVIDERS, looksLikeKey, verifyFreeKey, type FreeProviderSpec } from './freeProviders';
import type { FreeCard, FreeHostMessage, FreeWebviewMessage, LocalState, OpenCodeState } from './freeProtocol';
import { budget, needGB, pickModels, type Hardware } from './localModels';
import { detectHardware, installOllama, installedTags, ollamaState, pullModel, startOllama, within, type OllamaState } from './localSetup';
import { signInWithOpenRouter } from './openrouter';

export interface FreeModelsHooks {
	/** The model the chat is on now, so the page can mark it. */
	activeModel(): string;
	/** Switch the chat to this model and bring the chat forward. */
	useModel(modelId: string): Promise<void>;
}

export class FreeModelsPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private installing = false;
	private signIn: vscode.CancellationTokenSource | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private hardware: Promise<Hardware> | undefined;
	private localBusy: string | undefined;
	private pulling: LocalState['pulling'];
	private pullAbort: AbortController | undefined;
	private lastOllama: OllamaState | undefined;
	private ollamaAbort: AbortController | undefined;
	private poll: NodeJS.Timeout | undefined;
	private focusLocal = false;
	/** A model picked before Ollama was ready; it downloads as soon as Ollama runs. */
	private queued: string | undefined;

	constructor(private readonly ctx: vscode.ExtensionContext, private readonly services: Services, private readonly hooks: FreeModelsHooks) {
		this.disposables.push(
			services.registry.onDidChangeModels(() => { void this.pushState(); }),
			services.cli.onDidChange(() => { void this.pushState(); }),
		);
	}

	/** With `install`, OpenCode starts installing right away (the model menu's one click Get). */
	/** With `local`, the page opens at Run a model on this computer. */
	open(opts?: { install?: boolean; local?: boolean }): void {
		if (opts?.install) { void this.installIfMissing(); }
		if (opts?.local) { this.focusLocal = true; }
		if (this.panel) {
			this.panel.reveal(undefined, false);
			if (this.focusLocal) { this.focusLocal = false; this.post({ type: 'focus', section: 'local' }); }
			return;
		}
		const dist = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview');
		const panel = this.panel = vscode.window.createWebviewPanel('openCursor.freeModels', 'Free models', vscode.ViewColumn.Active, {
			enableScripts: true, localResourceRoots: [dist], retainContextWhenHidden: false,
		});
		panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'chat.svg');
		panel.webview.html = this.html(panel.webview, dist);
		panel.webview.onDidReceiveMessage((m: FreeWebviewMessage) => { void this.onMessage(m); }, undefined, this.disposables);
		panel.onDidDispose(() => { this.panel = undefined; this.signIn?.cancel(); this.ollamaAbort?.abort(); this.queued = undefined; if (this.poll) { clearInterval(this.poll); this.poll = undefined; } }, undefined, this.disposables);
		// Ollama can be opened, quit or installed outside the editor; follow it while the page is open.
		this.poll = setInterval(() => {
			if (this.localBusy || this.pulling) { return; }
			void ollamaState().then(s => {
				// a queued pull starts even when a pushState already recorded 'running'
				if (s === 'running' && this.queued) { const tag = this.queued; this.queued = undefined; void this.onMessage({ type: 'pullModel', tag }); return; }
				if (s === this.lastOllama) { return; }
				void this.pushState();
			});
		}, 4000);
	}

	private async installIfMissing(): Promise<void> {
		const agent = (await this.services.cli.detect().catch(() => [])).find(a => a.id === 'opencode');
		if (!agent?.binaryPath) { await this.onMessage({ type: 'installOpenCode' }); }
	}

	dispose(): void {
		this.panel?.dispose();
		this.disposables.forEach(d => d.dispose());
	}

	private post(m: FreeHostMessage): void {
		void this.panel?.webview.postMessage(m);
	}

	private spec(id: string): FreeProviderSpec | undefined {
		return FREE_PROVIDERS.find(p => p.id === id);
	}

	private async openCodeState(): Promise<OpenCodeState> {
		const agent = (await this.services.cli.detect().catch(() => [])).find(a => a.id === 'opencode');
		return {
			installed: !!agent?.binaryPath,
			installing: this.installing,
			models: (agent?.models ?? []).filter(m => m.id !== 'default').map(m => ({ id: `cli:opencode/${m.id}`, label: m.label })),
		};
	}

	private async localState(): Promise<LocalState> {
		this.hardware ??= detectHardware();
		const hw = await this.hardware;
		const b = budget(hw);
		const ollama = this.lastOllama = await ollamaState();
		const tags = ollama === 'running' ? await installedTags() : [];
		const has = (tag: string): boolean => tags.includes(tag) || tags.includes(tag + ':latest');
		const picks = pickModels(hw).map(p => ({ tag: p.model.tag, label: p.model.label, note: p.model.note, sizeGB: p.model.sizeGB, recommended: p.recommended, tight: p.tight, diskOk: p.diskOk, installed: has(p.model.tag), fill: Math.min(1, needGB(p.model) / b.gb) }));
		return {
			hardware: b.summary, speed: b.speed, ollama, picks,
			others: tags.filter(t => !picks.some(p => p.tag === t || p.tag + ':latest' === t)),
			...(this.localBusy ? { busy: this.localBusy } : {}),
			...(this.pulling ? { pulling: this.pulling } : {}),
		};
	}

	private async pushState(): Promise<void> {
		if (!this.panel) { return; }
		const cards: FreeCard[] = await Promise.all(FREE_PROVIDERS.map(async p => ({
			id: p.id, name: p.name, signupUrl: p.signupUrl, keyUrl: p.keyUrl, steps: p.steps, models: p.models, limits: p.limits,
			privacy: p.privacy, oauth: p.oauth, connected: await this.services.registry.hasKey(p.id).catch(() => false),
		})));
		// never let a slow probe hold up the rest of the page
		const local = await within(this.localState(), 6000, undefined);
		this.post({ type: 'state', cards, opencode: await this.openCodeState(), activeModel: this.hooks.activeModel(), ...(local ? { local } : {}) });
		if (this.focusLocal) { this.focusLocal = false; this.post({ type: 'focus', section: 'local' }); }
	}

	/** Gets Ollama installed and running. False when it is not running yet (failed, or finishing in a terminal). */
	private async ensureOllama(queue?: string): Promise<boolean> {
		// claim the slot before the first await, so a double click cannot start two installs
		if (this.localBusy) { return false; }
		this.localBusy = 'Checking Ollama';
		const say = (s: string): void => { this.localBusy = s; void this.pushState(); };
		const abort = this.ollamaAbort = new AbortController();
		try {
			const state = await ollamaState();
			if (state === 'running') { return true; }
			if (state === 'stopped') {
				say('Starting Ollama');
				if (await startOllama()) { return true; }
				throw new Error('it did not start. Open Ollama once from your apps, then try again.');
			}
			say('Downloading Ollama');
			const r = await installOllama(say, abort.signal);
			if (r === 'terminal') {
				this.queued = queue;
				this.post({ type: 'result', id: 'local', ok: true, message: 'Finish the install in the terminal below; it asks for your password.' + (queue ? ` ${queue} downloads as soon as Ollama runs.` : '') });
				return false;
			}
			return true;
		} catch (e) {
			this.post({ type: 'result', id: 'local', ok: false, message: `Could not get Ollama running: ${e instanceof Error ? e.message : String(e)}` });
			return false;
		} finally {
			if (this.ollamaAbort === abort) { this.ollamaAbort = undefined; }
			this.localBusy = undefined;
			await this.services.registry.refreshModels().catch(() => undefined);
		}
	}

	private async connect(spec: FreeProviderSpec, key: string): Promise<void> {
		const k = key.trim();
		const r = await verifyFreeKey(spec, k);
		if (r.ok) { await this.services.registry.setKey(spec.id as ProviderId, k); }
		this.post({ type: 'result', id: spec.id, ok: r.ok, message: r.message });
		await this.pushState();
	}

	private async onMessage(m: FreeWebviewMessage): Promise<void> {
		switch (m.type) {
			case 'ready': return this.pushState();
			case 'open':
				if (/^https:\/\//.test(m.url)) { await vscode.env.openExternal(vscode.Uri.parse(m.url, true)); }
				return;
			case 'paste': {
				const spec = this.spec(m.id);
				if (!spec) { return; }
				const text = (await vscode.env.clipboard.readText()).trim();
				if (!text) { this.post({ type: 'result', id: spec.id, ok: false, message: 'Your clipboard is empty. Copy the key first.' }); return; }
				if (!looksLikeKey(spec, text)) { this.post({ type: 'result', id: spec.id, ok: false, message: `That does not look like a ${spec.name} key. Copy the key itself.` }); return; }
				return this.connect(spec, text);
			}
			case 'key': {
				const spec = this.spec(m.id);
				if (!spec || !m.key.trim()) { return; }
				if (!looksLikeKey(spec, m.key.trim())) { this.post({ type: 'result', id: spec.id, ok: false, message: `That does not look like a ${spec.name} key. Copy the key itself.` }); return; }
				return this.connect(spec, m.key);
			}
			case 'oauth': {
				const spec = this.spec(m.id);
				if (!spec?.oauth) { return; }
				this.signIn?.cancel();
				const cts = this.signIn = new vscode.CancellationTokenSource();
				try {
					const key = await signInWithOpenRouter(cts.token);
					await this.services.registry.setKey(spec.id as ProviderId, key);
					this.post({ type: 'result', id: spec.id, ok: true, message: 'Connected' });
				} catch (e) {
					this.post({ type: 'result', id: spec.id, ok: false, message: e instanceof Error ? e.message : String(e) });
				} finally {
					if (this.signIn === cts) { this.signIn = undefined; }
					cts.dispose();
				}
				return this.pushState();
			}
			case 'cancelOauth':
				this.signIn?.cancel();
				return;
			case 'disconnect': {
				const spec = this.spec(m.id);
				if (spec) { await this.services.registry.setKey(spec.id as ProviderId, undefined); }
				return this.pushState();
			}
			case 'installOpenCode': {
				if (this.installing) { return; }
				this.installing = true;
				await this.pushState();
				const r = await this.services.cli.installOpenCode().catch(e => ({ ok: false, message: e instanceof Error ? e.message : String(e) }));
				this.installing = false;
				await this.services.cli.refresh().catch(() => undefined);
				this.post({ type: 'result', id: 'opencode', ok: r.ok, message: r.ok ? 'Installed' : r.message });
				return this.pushState();
			}
			case 'use':
				if (m.modelId.startsWith('ollama/')) { await this.services.registry.refreshModels().catch(() => undefined); }
				await this.hooks.useModel(m.modelId);
				return this.pushState();
			case 'installOllama':
				if (this.localBusy) { return; }
				await this.ensureOllama();
				return this.pushState();
			case 'startOllama':
				if (this.localBusy) { return; }
				await this.ensureOllama();
				return this.pushState();
			case 'pullModel': {
				if (this.pulling || this.localBusy) { return; }
				// one click: install and start Ollama first when needed
				if (!(await this.ensureOllama(m.tag))) { return this.pushState(); }
				const abort = this.pullAbort = new AbortController();
				this.pulling = { tag: m.tag, status: 'Starting' };
				await this.pushState();
				let last = 0;
				try {
					await pullModel(m.tag, (pct, status) => {
						this.pulling = { tag: m.tag, status, ...(pct !== undefined ? { pct } : {}) };
						if (Date.now() - last > 250) { last = Date.now(); void this.pushState(); }
					}, abort.signal);
					this.pulling = undefined;
					await this.services.registry.refreshModels().catch(() => undefined);
					await this.hooks.useModel(`ollama/${m.tag}`);
					this.post({ type: 'result', id: 'local', ok: true, message: `${m.tag} is ready and selected in the chat.` });
				} catch (e) {
					this.pulling = undefined;
					if (!abort.signal.aborted) { this.post({ type: 'result', id: 'local', ok: false, message: `The download stopped: ${e instanceof Error ? e.message : String(e)}` }); }
				} finally {
					if (this.pullAbort === abort) { this.pullAbort = undefined; }
				}
				return this.pushState();
			}
			case 'cancelPull':
				this.pullAbort?.abort();
				return;
		}
	}

	private html(webview: vscode.Webview, dist: vscode.Uri): string {
		const nonce = crypto.randomBytes(16).toString('base64');
		const js = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'free.js'));
		const css = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'free.css'));
		const csp = [`default-src 'none'`, `style-src ${webview.cspSource} 'unsafe-inline'`, `script-src 'nonce-${nonce}'`, `img-src ${webview.cspSource} data:`, `font-src ${webview.cspSource}`].join('; ');
		return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${css}"><title>Free models</title></head><body><div id="root"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
	}
}
