/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Embedding backends: OpenAI /v1/embeddings, Gemini batchEmbedContents, Ollama /api/embed.
 *  Keys follow the provider convention: ctx.secrets 'openCursor.key.<provider>' then environment.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { normalize } from './vectorStore';

export interface Embedder {
	/** `provider/model`, stored with the index so a change triggers a rebuild. */
	readonly id: string;
	embed(texts: string[], kind: 'doc' | 'query', signal: AbortSignal): Promise<Float32Array[]>;
	/** Max texts per call. */
	readonly batchSize: number;
}

const MAX_CHARS = 7000;

async function secretOrEnv(ctx: vscode.ExtensionContext, provider: string, envNames: string[]): Promise<string | undefined> {
	const s = await ctx.secrets.get(`openCursor.key.${provider}`);
	if (s) { return s; }
	for (const n of envNames) {
		if (process.env[n]) { return process.env[n]; }
	}
	return undefined;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<any> {
	let lastErr: unknown;
	for (let attempt = 0; attempt < 4; attempt++) {
		if (signal.aborted) { throw new Error('aborted'); }
		try {
			const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
			if (res.ok) { return await res.json(); }
			const text = (await res.text()).slice(0, 300);
			lastErr = new Error(`Embeddings request failed (${res.status}): ${text}`);
			if (res.status !== 429 && res.status < 500) { throw lastErr; }
		} catch (e) {
			if (signal.aborted) { throw e; }
			lastErr = e;
			if (e instanceof Error && /\(4\d\d\)/.test(e.message) && !/\(429\)/.test(e.message)) { throw e; }
		}
		await new Promise(r => setTimeout(r, 800 * 2 ** attempt));
	}
	throw lastErr instanceof Error ? lastErr : new Error('Embeddings request failed');
}

function openaiEmbedder(key: string, model: string): Embedder {
	const base = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
	return {
		id: `openai/${model}`,
		batchSize: 64,
		async embed(texts, _kind, signal) {
			const json = await postJson(`${base}/embeddings`, { authorization: `Bearer ${key}` }, { model, input: texts.map(t => t.slice(0, MAX_CHARS)) }, signal);
			const data = (json.data as { index: number; embedding: number[] }[]).slice().sort((a, b) => a.index - b.index);
			return data.map(d => normalize(Float32Array.from(d.embedding)));
		},
	};
}

function geminiEmbedder(key: string, model: string): Embedder {
	return {
		id: `google/${model}`,
		batchSize: 64,
		async embed(texts, kind, signal) {
			const json = await postJson(
				`https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`,
				{ 'x-goog-api-key': key },
				{
					requests: texts.map(t => ({
						model: `models/${model}`,
						content: { parts: [{ text: t.slice(0, MAX_CHARS) }] },
						taskType: kind === 'query' ? 'CODE_RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
						outputDimensionality: 768,
					})),
				},
				signal,
			);
			return (json.embeddings as { values: number[] }[]).map(e => normalize(Float32Array.from(e.values)));
		},
	};
}

function ollamaBase(): string {
	const cfg = vscode.workspace.getConfiguration('openCursor');
	const fromCfg = cfg.get<string>('providers.ollama.baseUrl') ?? cfg.get<string>('ollama.baseUrl');
	const env = process.env.OLLAMA_HOST;
	let base = fromCfg || (env ? (env.startsWith('http') ? env : `http://${env}`) : 'http://127.0.0.1:11434');
	base = base.replace(/\/+$/, '').replace(/\/v1$/, '');
	return base;
}

function ollamaEmbedder(base: string, model: string): Embedder {
	const nomic = /nomic/i.test(model);
	return {
		id: `ollama/${model}`,
		batchSize: 16,
		async embed(texts, kind, signal) {
			const prefix = nomic ? (kind === 'query' ? 'search_query: ' : 'search_document: ') : '';
			const json = await postJson(`${base}/api/embed`, {}, { model, input: texts.map(t => prefix + t.slice(0, 4000)) }, signal);
			return (json.embeddings as number[][]).map(e => normalize(Float32Array.from(e)));
		},
	};
}

async function findOllamaModel(base: string, wanted?: string): Promise<string | undefined> {
	try {
		const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
		if (!res.ok) { return undefined; }
		const names = ((await res.json()) as { models?: { name: string }[] }).models?.map(m => m.name) ?? [];
		if (wanted) { return names.find(n => n === wanted || n.split(':')[0] === wanted) ? wanted : undefined; }
		return names.find(n => n.startsWith('nomic-embed-text')) ?? names.find(n => /embed|bge-|minilm|mxbai|\bgte\b/i.test(n));
	} catch {
		return undefined;
	}
}

/** `setting` is "auto" or "provider/model" (openai | google | ollama). Returns undefined when nothing usable exists. */
export async function resolveEmbedder(ctx: vscode.ExtensionContext, setting: string): Promise<Embedder | undefined> {
	const slash = setting.indexOf('/');
	const wantProvider = setting === 'auto' || slash === -1 ? 'auto' : setting.slice(0, slash);
	const wantModel = setting === 'auto' || slash === -1 ? undefined : setting.slice(slash + 1);

	if (wantProvider === 'auto' || wantProvider === 'openai') {
		const key = await secretOrEnv(ctx, 'openai', ['OPENAI_API_KEY']);
		if (key) { return openaiEmbedder(key, wantModel ?? 'text-embedding-3-small'); }
	}
	if (wantProvider === 'auto' || wantProvider === 'google') {
		const key = await secretOrEnv(ctx, 'google', ['GEMINI_API_KEY', 'GOOGLE_API_KEY']);
		if (key) { return geminiEmbedder(key, wantModel ?? 'gemini-embedding-001'); }
	}
	if (wantProvider === 'auto' || wantProvider === 'ollama') {
		const base = ollamaBase();
		const model = await findOllamaModel(base, wantModel);
		if (model) { return ollamaEmbedder(base, model); }
	}
	return undefined;
}
