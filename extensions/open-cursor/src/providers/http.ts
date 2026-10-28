/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Shared HTTP plumbing for provider adapters: retrying fetch, error mapping, SSE and NDJSON readers.
 *  No vscode imports: adapters must run under plain node (see smoke.ts).
 *--------------------------------------------------------------------------------------------*/

import { ProviderError, type ProviderId, type StreamEvent } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Rec = Record<string, any>;

export interface SseEvent { event?: string; data: string }

export function isAbort(e: unknown, signal?: AbortSignal): boolean {
	return !!signal?.aborted || (e instanceof Error && e.name === 'AbortError');
}

const CONTEXT_RE = /context[ _]length|context window|maximum context|prompt is too long|too many tokens|token limit|exceeds? the (maximum|max|limit)|input (is )?too long|reduce the length|context_length_exceeded|request too large/i;
const AUTH_RE = /api key not valid|invalid api[ _-]?key|incorrect api key|invalid x-api-key|unauthorized/i;

export function errorKind(status: number, message: string): ProviderError['kind'] {
	if (status === 401 || status === 403 || AUTH_RE.test(message)) { return 'auth'; }
	if (status === 429 || status === 529) { return 'rate'; }
	if (status === 413 || (status >= 400 && status < 500 && CONTEXT_RE.test(message))) { return 'context'; }
	return 'other';
}

function messageOf(text: string): string {
	try {
		const j = JSON.parse(text) as Rec;
		const e = j.error ?? j;
		const m = typeof e === 'string' ? e : (e.message ?? e.detail ?? e.error);
		if (typeof m === 'string' && m) { return m; }
		if (Array.isArray(j) && j[0]?.error?.message) { return String(j[0].error.message); }
	} catch { /* not json */ }
	return text.slice(0, 500) || 'empty response';
}

export async function errorFromResponse(provider: ProviderId, res: Response): Promise<ProviderError> {
	const text = await res.text().catch(() => '');
	const msg = messageOf(text);
	return new ProviderError(`${res.status}: ${msg}`, provider, res.status, errorKind(res.status, msg));
}

function retryAfterMs(res: Response): number | undefined {
	const ms = res.headers.get('retry-after-ms');
	if (ms && !isNaN(+ms)) { return +ms; }
	const h = res.headers.get('retry-after');
	if (!h) { return undefined; }
	if (!isNaN(+h)) { return +h * 1000; }
	const d = Date.parse(h);
	return isNaN(d) ? undefined : Math.max(0, d - Date.now());
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) { return reject(new DOMException('Aborted', 'AbortError')); }
		const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
		const onAbort = () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); };
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/** fetch with ProviderError mapping and up to `retries` retries on 429/529 (Retry-After respected, capped at 30 s). */
export async function request(provider: ProviderId, url: string, init: { method?: string; headers?: Record<string, string>; body?: string }, signal?: AbortSignal, retries = 2): Promise<Response> {
	for (let attempt = 0; ; attempt++) {
		let res: Response;
		try {
			res = await fetch(url, { ...init, signal });
		} catch (e) {
			if (isAbort(e, signal)) { throw e; }
			const cause = (e as { cause?: { code?: string; message?: string } }).cause;
			throw new ProviderError(`Cannot reach ${new URL(url).host}: ${cause?.code ?? cause?.message ?? (e as Error).message}`, provider, undefined, 'network');
		}
		if (res.ok) { return res; }
		const err = await errorFromResponse(provider, res);
		if (err.kind === 'rate' && attempt < retries) {
			const wait = retryAfterMs(res) ?? 1000 * 2 ** attempt;
			if (wait <= 30000) { await sleep(wait, signal); continue; }
		}
		throw err;
	}
}

export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = body.getReader();
	const dec = new TextDecoder();
	let buf = '';
	try {
		for (; ;) {
			const { done, value } = await reader.read();
			if (done) { break; }
			buf += dec.decode(value, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				yield line.endsWith('\r') ? line.slice(0, -1) : line;
			}
		}
		buf += dec.decode();
		if (buf) { yield buf.endsWith('\r') ? buf.slice(0, -1) : buf; }
	} finally {
		reader.cancel().catch(() => undefined);
	}
}

export async function* parseSse(lines: AsyncIterable<string>): AsyncGenerator<SseEvent> {
	let event: string | undefined;
	let data: string[] = [];
	for await (const line of lines) {
		if (line === '') {
			if (data.length) { yield { event, data: data.join('\n') }; }
			event = undefined; data = [];
			continue;
		}
		if (line.startsWith(':')) { continue; }
		const c = line.indexOf(':');
		const field = c < 0 ? line : line.slice(0, c);
		let v = c < 0 ? '' : line.slice(c + 1);
		if (v.startsWith(' ')) { v = v.slice(1); }
		if (field === 'data') { data.push(v); } else if (field === 'event') { event = v; }
	}
	if (data.length) { yield { event, data: data.join('\n') }; }
}

export function sseFromBody(res: Response): AsyncGenerator<SseEvent> {
	if (!res.body) { throw new ProviderError('Empty response body', 'custom'); }
	return parseSse(readLines(res.body));
}

/** Test helper: SSE events from a literal string. */
export async function* linesOf(text: string): AsyncGenerator<string> {
	for (const l of text.split('\n')) { yield l.endsWith('\r') ? l.slice(0, -1) : l; }
}

/**
 * Wraps an adapter generator: abort becomes a clean `done: aborted`, stray errors become network ProviderErrors.
 */
export async function* guarded(provider: ProviderId, signal: AbortSignal, gen: AsyncGenerator<StreamEvent>): AsyncGenerator<StreamEvent> {
	try {
		yield* gen;
	} catch (e) {
		if (isAbort(e, signal)) { yield { type: 'done', stopReason: 'aborted' }; return; }
		if (e instanceof ProviderError) { throw e; }
		throw new ProviderError((e as Error).message ?? String(e), provider, undefined, 'network');
	}
}

export function parseArgs(json: string): unknown {
	if (!json.trim()) { return {}; }
	try { return JSON.parse(json); } catch { return {}; }
}

export function joinUrl(base: string, path: string): string {
	return base.replace(/\/+$/, '') + (path.startsWith('/') ? path : '/' + path);
}

export function missingKey(provider: ProviderId, label: string): ProviderError {
	return new ProviderError(`No API key for ${label}.`, provider, 401, 'auth');
}

export type KeyGetter = () => Promise<string | undefined> | string | undefined;
export type BaseUrl = string | ((modelId?: string) => string);
export function resolveBase(b: BaseUrl, modelId?: string): string {
	return (typeof b === 'function' ? b(modelId) : b).replace(/\/+$/, '');
}

export async function verifyByListing(fn: (signal?: AbortSignal) => Promise<unknown[]>, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
	try {
		const m = await fn(signal);
		return { ok: true, message: `Connected, ${m.length} model${m.length === 1 ? '' : 's'} available.` };
	} catch (e) {
		return { ok: false, message: (e as Error).message };
	}
}
