/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Embedding backends for the codebase index and how the `index.embeddingModel` setting picks one.
 *  No VS Code imports: settings and keys come in through EmbedEnv, so this runs in plain Node tests.
 *--------------------------------------------------------------------------------------------*/

import { isLocalHost } from '../providers/http';
import { normalize } from './vectorStore';

export interface Embedder {
	/** Stored with the index; a different id rebuilds it. */
	readonly id: string;
	/** Max texts per call. */
	readonly batchSize: number;
	/** Set when file text leaves this computer and the local network: consent is stored under `key`, `label` names the receiver. */
	readonly remote?: { readonly key: string; readonly label: string };
	embed(texts: string[], kind: 'doc' | 'query', signal: AbortSignal): Promise<Float32Array[]>;
}

export type KeyedProvider = 'openai' | 'google' | 'custom';
export type ServerProvider = 'openai' | 'ollama' | 'lmstudio' | 'custom';

export interface EmbedEnv {
	key(provider: KeyedProvider): Promise<string | undefined>;
	/** Normalized base URL from settings, or '' when none is set. */
	base(provider: ServerProvider): string;
}

export type Resolution =
	| { readonly embedder: Embedder; readonly problem?: undefined; readonly isError?: undefined }
	/** `isError` is false when `auto` simply found nothing, true when an explicit choice cannot work. */
	| { readonly embedder?: undefined; readonly problem: string; readonly isError: boolean };

export const OPENAI_BASE = 'https://api.openai.com/v1';
const CLOUD_MAX_CHARS = 7000;
const LOCAL_MAX_CHARS = 4000;
const EMBED_NAME = /embed|bge-|\bbge\b|minilm|mxbai|\bgte\b|\be5\b|e5-|jina/i;

export const NO_EMBEDDER = 'No embedding model found, so codebase search uses plain text matching. Add an OpenAI or Gemini key, pull an Ollama embedding model (ollama pull nomic-embed-text), or set the embedding model to custom/<model> for an OpenAI-compatible server.';

function hostOf(url: string): string {
	try { return new URL(url).host; } catch { return url; }
}

function remoteFor(provider: string, base: string): Embedder['remote'] {
	let host: string;
	try { host = new URL(base).hostname; } catch { return { key: `${provider}@${base}`, label: base }; }
	return isLocalHost(host) ? undefined : { key: `${provider}@${host.toLowerCase()}`, label: host };
}

function causeOf(e: unknown): string {
	const c = (e as { cause?: { code?: string; message?: string } })?.cause;
	return c?.code ?? c?.message ?? (e instanceof Error ? e.message : String(e));
}

/** The message out of an error body: OpenAI's `{ error: { message } }`, `{ error: "..." }`, `{ detail }`, or plain text. */
export function serverMessage(body: string): string {
	let msg = body;
	try {
		const j = JSON.parse(body) as { error?: string | { message?: string }; message?: string; detail?: unknown };
		const found = typeof j.error === 'string' ? j.error : j.error?.message ?? j.message ?? (typeof j.detail === 'string' ? j.detail : undefined);
		if (found) { msg = found; }
	} catch { /* not JSON */ }
	msg = msg.replace(/\s+/g, ' ').trim();
	return msg.length > 300 ? msg.slice(0, 300) + '…' : msg;
}

function statusHint(status: number): string {
	if (status === 401 || status === 403) { return ' Check the API key.'; }
	if (status === 404) { return ' The server may not support /embeddings, or the model name is wrong.'; }
	return '';
}

export async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<unknown> {
	const where = hostOf(url);
	let last: Error | undefined;
	for (let attempt = 0; attempt < 4; attempt++) {
		if (attempt) { await new Promise(r => setTimeout(r, 800 * 2 ** (attempt - 1))); }
		if (signal.aborted) { throw new Error('aborted'); }
		let res: Response;
		try {
			res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
		} catch (e) {
			if (signal.aborted) { throw e; }
			last = new Error(`Could not reach the embedding server at ${where} (${causeOf(e)}).`);
			continue;
		}
		if (res.ok) {
			try { return await res.json(); } catch { throw new Error(`The embedding server at ${where} did not answer with JSON.`); }
		}
		const text = serverMessage(await res.text().catch(() => ''));
		last = new Error(`Embedding request to ${where} failed (${res.status})${text ? ': ' + text.replace(/[.\s]+$/, '') + '.' : '.'}${statusHint(res.status)}`);
		if (res.status !== 429 && res.status < 500) { throw last; }
	}
	throw last ?? new Error(`Embedding request to ${where} failed.`);
}

async function getJson(url: string, headers: Record<string, string> = {}, ms = 2500): Promise<unknown> {
	try {
		const res = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
		return res.ok ? await res.json() : undefined;
	} catch {
		return undefined;
	}
}

function toVector(v: unknown): Float32Array {
	if (Array.isArray(v) && v.length) { return normalize(Float32Array.from(v as number[])); }
	if (typeof v === 'string' && v) {
		const buf = Buffer.from(v, 'base64');
		return normalize(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength - (buf.byteLength % 4))));
	}
	throw new Error('empty embedding');
}

function noVectors(where: string, model: string): Error {
	return new Error(`The server at ${where} returned no embeddings for ${model}. Check that it is an embedding model.`);
}

function nomicPrefix(model: string, kind: 'doc' | 'query'): string {
	return /nomic/i.test(model) ? (kind === 'query' ? 'search_query: ' : 'search_document: ') : '';
}

/** POST {base}/embeddings, the OpenAI shape that LM Studio, llama.cpp, vLLM, LiteLLM, LocalAI and Ollama's /v1 also serve. */
export function compatEmbedder(o: { provider: 'openai' | 'lmstudio' | 'custom'; base: string; model: string; key?: string }): Embedder {
	const official = o.provider === 'openai' && o.base === OPENAI_BASE;
	const maxChars = official ? CLOUD_MAX_CHARS : LOCAL_MAX_CHARS;
	const where = hostOf(o.base);
	return {
		id: official ? `openai/${o.model}` : `${o.provider}/${o.model}@${o.base}`,
		batchSize: official ? 64 : 16,
		remote: official ? { key: 'openai', label: 'OpenAI' } : remoteFor(o.provider, o.base),
		async embed(texts, kind, signal) {
			const prefix = nomicPrefix(o.model, kind);
			const headers: Record<string, string> = o.key ? { authorization: `Bearer ${o.key}` } : {};
			const json = await postJson(`${o.base}/embeddings`, headers, { model: o.model, input: texts.map(t => prefix + t.slice(0, maxChars)) }, signal) as { data?: { index?: number; embedding?: unknown }[] };
			const data = Array.isArray(json?.data) ? json.data : [];
			if (!data.length) { throw noVectors(where, o.model); }
			const ordered = data.every(d => typeof d.index === 'number') ? data.slice().sort((a, b) => a.index! - b.index!) : data;
			try { return ordered.map(d => toVector(d.embedding)); } catch { throw noVectors(where, o.model); }
		},
	};
}

export function geminiEmbedder(key: string, model: string): Embedder {
	return {
		id: `google/${model}`,
		batchSize: 64,
		remote: { key: 'google', label: 'Google' },
		async embed(texts, kind, signal) {
			const json = await postJson(
				`https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`,
				{ 'x-goog-api-key': key },
				{
					requests: texts.map(t => ({
						model: `models/${model}`,
						content: { parts: [{ text: t.slice(0, CLOUD_MAX_CHARS) }] },
						taskType: kind === 'query' ? 'CODE_RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
						outputDimensionality: 768,
					})),
				},
				signal,
			) as { embeddings?: { values?: unknown }[] };
			if (!Array.isArray(json?.embeddings) || !json.embeddings.length) { throw noVectors('generativelanguage.googleapis.com', model); }
			return json.embeddings.map(e => toVector(e.values));
		},
	};
}

export function ollamaEmbedder(base: string, model: string): Embedder {
	return {
		id: `ollama/${model}`,
		batchSize: 16,
		remote: remoteFor('ollama', base),
		async embed(texts, kind, signal) {
			const prefix = nomicPrefix(model, kind);
			const json = await postJson(`${base}/api/embed`, {}, { model, input: texts.map(t => prefix + t.slice(0, LOCAL_MAX_CHARS)) }, signal) as { embeddings?: unknown[] };
			if (!Array.isArray(json?.embeddings) || !json.embeddings.length) { throw noVectors(hostOf(base), model); }
			return json.embeddings.map(toVector);
		},
	};
}

/** Model names on an Ollama server, or undefined when it does not answer. */
async function ollamaModels(base: string): Promise<string[] | undefined> {
	const json = await getJson(`${base}/api/tags`, {}, 1500) as { models?: { name?: string }[] } | undefined;
	return Array.isArray(json?.models) ? json.models.map(m => m.name ?? '').filter(Boolean) : undefined;
}

/** Model ids from an OpenAI-compatible /models list, or undefined when the server does not answer. */
async function compatModels(base: string, key: string | undefined, ms: number): Promise<string[] | undefined> {
	const json = await getJson(`${base}/models`, key ? { authorization: `Bearer ${key}` } : {}, ms) as { data?: { id?: string }[] } | undefined;
	return Array.isArray(json?.data) ? json.data.map(m => m.id ?? '').filter(Boolean) : undefined;
}

export function pickEmbeddingModel(names: string[]): string | undefined {
	return names.find(n => /^nomic-embed-text/i.test(n)) ?? names.find(n => EMBED_NAME.test(n));
}

const fail = (problem: string, isError = true): Resolution => ({ problem, isError });
const LABEL = { lmstudio: 'LM Studio', custom: 'Your OpenAI-compatible server' } as const;

async function openai(env: EmbedEnv, model: string | undefined): Promise<Resolution> {
	const key = await env.key('openai');
	if (!key) { return fail('No OpenAI key. Add one in Settings > Models, or choose another embedding model.'); }
	return { embedder: compatEmbedder({ provider: 'openai', base: env.base('openai') || OPENAI_BASE, key, model: model || 'text-embedding-3-small' }) };
}

async function google(env: EmbedEnv, model: string | undefined): Promise<Resolution> {
	const key = await env.key('google');
	if (!key) { return fail('No Gemini key. Add one in Settings > Models, or choose another embedding model.'); }
	return { embedder: geminiEmbedder(key, model || 'gemini-embedding-001') };
}

async function ollama(env: EmbedEnv, model: string | undefined): Promise<Resolution> {
	const base = env.base('ollama');
	const names = await ollamaModels(base);
	if (!names) { return fail(`Ollama is not answering at ${base}. Start it, or check its server address in Settings > Models.`); }
	if (model) {
		const found = names.find(n => n === model || n.split(':')[0] === model);
		return found ? { embedder: ollamaEmbedder(base, model) } : fail(`Ollama has no model named ${model}. Run: ollama pull ${model}`);
	}
	const picked = pickEmbeddingModel(names);
	return picked ? { embedder: ollamaEmbedder(base, picked) } : fail('Ollama has no embedding model. Run: ollama pull nomic-embed-text');
}

async function server(env: EmbedEnv, provider: 'lmstudio' | 'custom', model: string | undefined): Promise<Resolution> {
	const base = env.base(provider);
	if (!base) { return fail('Set the address of your OpenAI-compatible server first, in Settings > Models > Custom (openCursor.providers.custom.baseUrl).'); }
	const key = provider === 'custom' ? await env.key('custom') : undefined;
	if (model) { return { embedder: compatEmbedder({ provider, base, key, model }) }; }
	const names = await compatModels(base, key, 4000);
	if (!names) { return fail(`${LABEL[provider]} is not answering at ${base}. Start it, or check the address in Settings > Models.`); }
	const picked = pickEmbeddingModel(names);
	return picked
		? { embedder: compatEmbedder({ provider, base, key, model: picked }) }
		: fail(`${LABEL[provider]} at ${base} lists no model that looks like an embedding model. Set the embedding model to ${provider}/<model id>.`);
}

/** Cloud keys first, then local servers that list an embedding model. Never an error: nothing found means keyword search. */
async function auto(env: EmbedEnv): Promise<Resolution> {
	if (await env.key('openai')) { return openai(env, undefined); }
	if (await env.key('google')) { return google(env, undefined); }
	const local = await ollama(env, undefined);
	if (local.embedder) { return local; }
	const studio = await server(env, 'lmstudio', undefined);
	if (studio.embedder) { return studio; }
	if (env.base('custom')) {
		const custom = await server(env, 'custom', undefined);
		return custom.embedder ? custom : fail(`${custom.problem} Codebase search uses plain text matching until then.`, false);
	}
	return fail(NO_EMBEDDER, false);
}

/** `setting` is `auto`, `provider` (pick that provider's embedding model) or `provider/model`. */
export async function resolveEmbedder(env: EmbedEnv, setting: string): Promise<Resolution> {
	const s = setting.trim();
	if (!s || s === 'auto') { return auto(env); }
	const slash = s.indexOf('/');
	const provider = (slash === -1 ? s : s.slice(0, slash)).trim().toLowerCase();
	const model = slash === -1 ? undefined : s.slice(slash + 1).trim() || undefined;
	switch (provider) {
		case 'openai': return openai(env, model);
		case 'google': case 'gemini': return google(env, model);
		case 'ollama': return ollama(env, model);
		case 'lmstudio': case 'custom': return server(env, provider, model);
		default: return fail(`Unknown embedding provider "${provider}". Use auto, or openai, google, ollama, lmstudio or custom followed by /model.`);
	}
}
