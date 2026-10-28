/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Everything the start screen needs to connect a model: local model servers on this computer or
 *  another one on the network, and API keys typed in place. Subscriptions (agent CLIs) live in
 *  cliAgents; this covers the rest.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Services } from '../services';
import type { ProviderId } from '../providers/types';
import { PROVIDER_LABELS } from '../providers/catalog';
import type { ApiProviderStatus, LocalServerStatus, ModelOption } from '../shared/protocol';

const LOCAL_DEFAULT: Record<LocalServerStatus['id'], string> = {
	ollama: 'http://localhost:11434',
	lmstudio: 'http://localhost:1234/v1',
	custom: '',
};
const BASE_SETTING: Record<LocalServerStatus['id'], string> = {
	ollama: 'providers.ollama.baseUrl',
	lmstudio: 'providers.lmstudio.baseUrl',
	custom: 'providers.custom.baseUrl',
};
const LABEL: Record<LocalServerStatus['id'], string> = { ollama: 'Ollama', lmstudio: 'LM Studio', custom: 'Model server' };
/** API providers in the order people most often have keys for. */
const KEY_PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'google', 'openrouter', 'xai', 'deepseek', 'mistral', 'groq'];

function cfg<T>(key: string, fallback: T): T {
	return vscode.workspace.getConfiguration('openCursor').get<T>(key, fallback);
}

function isLoopback(url: string): boolean {
	try {
		const h = new URL(url).hostname;
		return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
	} catch {
		return false;
	}
}

async function getJson(url: string, ms: number): Promise<unknown> {
	const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
	if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
	return res.json();
}

/** Models served at an address, and which kind of server answered. */
async function probe(base: string, ms = 1500): Promise<{ kind: 'ollama' | 'openai'; models: number } | undefined> {
	const root = base.replace(/\/+$/, '');
	try {
		const tags = await getJson(root.replace(/\/v1$/, '') + '/api/tags', ms) as { models?: unknown[] };
		if (Array.isArray(tags.models)) { return { kind: 'ollama', models: tags.models.length }; }
	} catch { /* not Ollama */ }
	for (const url of [root + '/models', root + '/v1/models']) {
		try {
			const list = await getJson(url, ms) as { data?: unknown[] };
			if (Array.isArray(list.data)) { return { kind: 'openai', models: list.data.length }; }
		} catch { /* try the next path */ }
	}
	return undefined;
}

/** `mac-mini.local`, `100.64.0.7:11434`, `http://box:1234/v1` -> candidate base URLs to try, most likely first. */
export function candidates(address: string): string[] {
	const a = address.trim().replace(/\/+$/, '');
	if (!a) { return []; }
	const withScheme = /^[a-z]+:\/\//i.test(a) ? a : 'http://' + a;
	let u: URL;
	try { u = new URL(withScheme); } catch { return []; }
	if (u.port || u.pathname.length > 1) { return [withScheme]; }
	const host = `${u.protocol}//${u.hostname}`;
	return [`${host}:11434`, `${host}:1234/v1`, `${host}:8080/v1`, `${host}:8000/v1`];
}

export class ConnectService {
	constructor(
		private readonly services: Services,
		private readonly options: () => readonly ModelOption[],
		private readonly refreshModels: () => Promise<void>,
	) { }

	async localServers(): Promise<LocalServerStatus[]> {
		const ids: LocalServerStatus['id'][] = ['ollama', 'lmstudio', 'custom'];
		const rows = await Promise.all(ids.map(async id => {
			const configured = cfg<string>(BASE_SETTING[id], '').trim();
			const baseUrl = configured || LOCAL_DEFAULT[id];
			if (!baseUrl) { return undefined; }
			const found = await probe(baseUrl).catch(() => undefined);
			const provider = id as ProviderId;
			const first = this.options().find(m => m.provider === provider && m.hasKey);
			const row: LocalServerStatus = {
				id, label: LABEL[id], baseUrl, remote: !isLoopback(baseUrl), configured: !!configured && configured.replace(/\/+$/, '') !== LOCAL_DEFAULT[id],
				reachable: !!found, models: found?.models ?? 0, ...(first ? { modelId: first.id } : {}),
			};
			return row;
		}));
		return rows.filter((r): r is LocalServerStatus => r !== undefined);
	}

	async apiProviders(): Promise<ApiProviderStatus[]> {
		return Promise.all(KEY_PROVIDERS.map(async id => {
			const hasKey = await this.services.registry.hasKey(id).catch(() => false);
			const first = hasKey ? (this.options().find(m => m.provider === id && m.hasKey)?.id) : undefined;
			const row: ApiProviderStatus = { id, label: PROVIDER_LABELS[id], hasKey, ...(first ? { modelId: first } : {}) };
			return row;
		}));
	}

	/** Saves a key in the OS keychain and checks it against the provider before saying it works. */
	async setKey(provider: string, key: string): Promise<{ ok: boolean; message: string }> {
		const id = provider as ProviderId;
		if (!KEY_PROVIDERS.includes(id)) { return { ok: false, message: 'Unknown provider.' }; }
		await this.services.registry.setKey(id, key);
		if (!key.trim()) { await this.reload(); return { ok: true, message: 'Key removed.' }; }
		const r = await this.services.registry.verify(id);
		await this.reload();
		return r.ok ? { ok: true, message: 'Connected.' } : { ok: false, message: `Saved, but ${PROVIDER_LABELS[id]} refused it: ${r.message}` };
	}

	/**
	 * Connects to a model server on another computer (or this one on a port other than the default). Ollama
	 * answers on /api/tags; LM Studio, llama.cpp, vLLM and friends answer the OpenAI /v1/models list.
	 */
	async connectServer(address: string): Promise<{ ok: boolean; message: string }> {
		const tries = candidates(address);
		if (!tries.length) { return { ok: false, message: 'Type an address such as mac-mini.local or 192.168.1.20:11434.' }; }
		for (const base of tries) {
			const found = await probe(base, 3000).catch(() => undefined);
			if (!found) { continue; }
			const id: LocalServerStatus['id'] = found.kind === 'ollama' ? 'ollama' : /:1234\b/.test(base) ? 'lmstudio' : 'custom';
			const url = found.kind === 'ollama' ? base.replace(/\/v1$/, '') : /\/v1$/.test(base) ? base : base + '/v1';
			await vscode.workspace.getConfiguration('openCursor').update(BASE_SETTING[id], url, vscode.ConfigurationTarget.Global);
			await this.reload();
			const host = (() => { try { return new URL(url).host; } catch { return url; } })();
			return { ok: true, message: `Connected to ${LABEL[id]} on ${host}, ${found.models} ${found.models === 1 ? 'model' : 'models'}.` };
		}
		return {
			ok: false,
			message: 'Nothing answered there. On the other computer the server must listen on the network: for Ollama, turn on "Expose Ollama to the network" or run OLLAMA_HOST=0.0.0.0 ollama serve; for LM Studio, enable "Serve on local network".',
		};
	}

	async resetServer(id: LocalServerStatus['id']): Promise<void> {
		await vscode.workspace.getConfiguration('openCursor').update(BASE_SETTING[id], undefined, vscode.ConfigurationTarget.Global);
		await this.reload();
	}

	/** Model lists come from the providers themselves; ask again before telling the chat what it can use. */
	private async reload(): Promise<void> {
		await this.services.registry.refreshModels().catch(() => undefined);
		await this.refreshModels();
	}
}
