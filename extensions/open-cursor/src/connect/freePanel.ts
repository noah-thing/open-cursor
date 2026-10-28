/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { Services } from '../services';
import type { ProviderId } from '../providers/types';
import { FREE_PROVIDERS, looksLikeKey, verifyFreeKey, type FreeProviderSpec } from './freeProviders';
import type { FreeCard, FreeHostMessage, FreeWebviewMessage, OpenCodeState } from './freeProtocol';
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
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly ctx: vscode.ExtensionContext, private readonly services: Services, private readonly hooks: FreeModelsHooks) {
		this.disposables.push(
			services.registry.onDidChangeModels(() => { void this.pushState(); }),
			services.cli.onDidChange(() => { void this.pushState(); }),
		);
	}

	open(): void {
		if (this.panel) { this.panel.reveal(undefined, false); return; }
		const dist = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview');
		const panel = this.panel = vscode.window.createWebviewPanel('openCursor.freeModels', 'Free models', vscode.ViewColumn.Active, {
			enableScripts: true, localResourceRoots: [dist], retainContextWhenHidden: false,
		});
		panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'chat.svg');
		panel.webview.html = this.html(panel.webview, dist);
		panel.webview.onDidReceiveMessage((m: FreeWebviewMessage) => { void this.onMessage(m); }, undefined, this.disposables);
		panel.onDidDispose(() => { this.panel = undefined; }, undefined, this.disposables);
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

	private async pushState(): Promise<void> {
		if (!this.panel) { return; }
		const cards: FreeCard[] = await Promise.all(FREE_PROVIDERS.map(async p => ({
			id: p.id, name: p.name, signupUrl: p.signupUrl, keyUrl: p.keyUrl, steps: p.steps, models: p.models, limits: p.limits,
			privacy: p.privacy, oauth: p.oauth, connected: await this.services.registry.hasKey(p.id).catch(() => false),
		})));
		this.post({ type: 'state', cards, opencode: await this.openCodeState(), activeModel: this.hooks.activeModel() });
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
				if (spec && m.key.trim()) { await this.connect(spec, m.key); }
				return;
			}
			case 'oauth': {
				const spec = this.spec(m.id);
				if (!spec?.oauth) { return; }
				try {
					const key = await signInWithOpenRouter();
					await this.services.registry.setKey(spec.id as ProviderId, key);
					this.post({ type: 'result', id: spec.id, ok: true, message: 'Connected' });
				} catch (e) {
					this.post({ type: 'result', id: spec.id, ok: false, message: e instanceof Error ? e.message : String(e) });
				}
				return this.pushState();
			}
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
				await this.hooks.useModel(m.modelId);
				return this.pushState();
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
