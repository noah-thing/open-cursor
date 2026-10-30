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

const CONTEXT_RE = /context[ _]length|context window|maximum context|prompt is too long|too many tokens|token limit|exceeds? the (maximum|max|limit)|input (is )?too long|reduce the length|context_length_exceeded|request too large|available context size|exceed_context_size|\bn_ctx\b/i;
const AUTH_RE = /api key not valid|invalid api[ _-]?key|incorrect api key|invalid x-api-key|unauthori[sz]ed/i;
// a 403 can also mean a blocked region or no credits, so it only counts as a refused key when the message says so
const AUTH_403_RE = /invalid|unauthori[sz]ed|authentication|api[ _-]?key|bad credentials|expired|revoked/i;

/** A 429 that waiting will not fix: the quota is spent, not just busy. */
export const QUOTA_RE = /insufficient_quota|daily (request |token )?limit|requests per day|per[ -]?day|billing (hard )?limit/i;

export function errorKind(status: number, message: string): ProviderError['kind'] {
	if (status === 401 || (status === 403 && AUTH_403_RE.test(message)) || AUTH_RE.test(message)) { return 'auth'; }
	if (status === 429 || status === 529) { return 'rate'; }
	if (status === 413 || (status >= 400 && status < 500 && CONTEXT_RE.test(message))) { return 'context'; }
	return 'other';
}

const GATEWAY: Record<number, string> = { 502: 'Bad gateway', 503: 'Service unavailable', 504: 'Gateway timeout', 520: 'Bad gateway', 521: 'Server is down', 522: 'Connection timed out', 524: 'Gateway timeout' };

/** Readable text for an error body: the provider's message plus OpenRouter's upstream detail; never a raw HTML page. */
export function messageOf(text: string, status = 0): string {
	if (/^\s*(<!doctype html|<html|<\?xml|<head|<body)/i.test(text)) {
		return `${GATEWAY[status] ?? 'The server returned an error page'} (the provider's server did not answer properly, try again in a moment)`;
	}
	try {
		const j = JSON.parse(text) as Rec;
		const e = j.error ?? j;
		let m = typeof e === 'string' ? e : (e.message ?? e.detail ?? e.error);
		if (typeof m === 'string' && m) {
			const md: Rec | undefined = typeof e === 'object' ? e.metadata : undefined;
			if (md) {
				let raw: unknown = md.raw;
				if (typeof raw === 'string') { try { const r = JSON.parse(raw) as Rec; raw = r.error?.message ?? r.message ?? raw; } catch { /* plain text */ } }
				const detail = typeof raw === 'string' && raw && !m.includes(raw) ? raw.slice(0, 400) : '';
				const who = typeof md.provider_name === 'string' ? md.provider_name : '';
				if (detail) { m += ` (${who ? who + ': ' : ''}${detail})`; } else if (who) { m += ` (${who})`; }
			}
			return m;
		}
		if (Array.isArray(j) && j[0]?.error?.message) { return String(j[0].error.message); }
	} catch { /* not json */ }
	return text.slice(0, 500) || 'empty response';
}

export async function errorFromResponse(provider: ProviderId, res: Response): Promise<ProviderError> {
	const text = await res.text().catch(() => '');
	const msg = messageOf(text, res.status);
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
	try { new URL(url); } catch { throw new ProviderError(`"${url}" is not a valid address. Include http:// or https://.`, provider, undefined, 'other'); }
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
		if (err.kind === 'rate' && attempt < retries && !QUOTA_RE.test(err.message)) {
			const wait = retryAfterMs(res) ?? 1000 * 2 ** attempt;
			if (wait <= 30000) { await sleep(wait, signal); continue; }
		}
		throw err;
	}
}

/** A stream that sends nothing for this long is a dead connection, not a slow model. */
const IDLE_MS = 180_000;
/** Before the first byte a local model may still be loading or reading a long prompt on the processor. */
const FIRST_BYTE_MS = 900_000;

export async function* readLines(body: ReadableStream<Uint8Array>, idleMs = IDLE_MS): AsyncGenerator<string> {
	const reader = body.getReader();
	const dec = new TextDecoder();
	let buf = '';
	try {
		let first = true;
		for (; ;) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const wait = first ? Math.max(idleMs, FIRST_BYTE_MS) : idleMs;
			first = false;
			const idle = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no data from the model for ${Math.round(wait / 1000)} seconds`)), wait); });
			const { done, value } = await Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
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

/** `onActivity` hears comment lines (": keep-alive", ": queued") that carry no event but show the server is alive. */
export async function* parseSse(lines: AsyncIterable<string>, onActivity?: () => void): AsyncGenerator<SseEvent> {
	let event: string | undefined;
	let data: string[] = [];
	for await (const line of lines) {
		if (line === '') {
			if (data.length) { yield { event, data: data.join('\n') }; }
			event = undefined; data = [];
			continue;
		}
		if (line.startsWith(':')) { onActivity?.(); continue; }
		const c = line.indexOf(':');
		const field = c < 0 ? line : line.slice(0, c);
		let v = c < 0 ? '' : line.slice(c + 1);
		if (v.startsWith(' ')) { v = v.slice(1); }
		if (field === 'data') { data.push(v); } else if (field === 'event') { event = v; }
	}
	if (data.length) { yield { event, data: data.join('\n') }; }
}

export function sseFromBody(res: Response, onActivity?: () => void): AsyncGenerator<SseEvent> {
	if (!res.body) { throw new ProviderError('Empty response body', 'custom'); }
	return parseSse(readLines(res.body), onActivity);
}

export async function* linesOf(text: string): AsyncGenerator<string> {
	for (const l of text.split('\n')) { yield l.endsWith('\r') ? l.slice(0, -1) : l; }
}

/** Abort becomes a clean `done: aborted`; stray errors become network ProviderErrors. */
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
	// cut off arguments stay a string, so the loop tells the model they were not valid instead of running the tool with none
	try { return JSON.parse(json); } catch { return json; }
}

function isLocalHost(h: string): boolean {
	h = h.toLowerCase();
	return h === 'localhost' || h === '[::1]' || /^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|\.local$|\.lan$/.test(h) || !h.includes('.');
}

/**
 * A base address as people type it: `localhost:1234/v1`, `http://host:8000/`. Adds the scheme when it is
 * missing (http for this machine and private networks, https otherwise), drops trailing slashes, adds `/v1`
 * to a local address with no path when `v1` is set, and removes a trailing `/v1` when `stripV1` is set.
 */
export function normalizeBase(raw: string, opts: { v1?: boolean; stripV1?: boolean } = {}): string {
	let v = raw.trim().replace(/\/+$/, '');
	if (!v) { return v; }
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
		const host = v.split(/[/?#]/)[0].replace(/:\d+$/, '').toLowerCase();
		const local = host === 'localhost' || host === '[::1]' || /^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|\.local$|\.lan$/.test(host) || !host.includes('.');
		v = (local ? 'http://' : 'https://') + v;
	}
	let u: URL;
	try { u = new URL(v); } catch { return v; }
	let path = u.pathname.replace(/\/+$/, '');
	if (opts.stripV1) { path = path.replace(/\/v1$/, ''); } else if (opts.v1 && !path && isLocalHost(u.hostname)) { path = '/v1'; }
	const auth = u.username ? u.username + (u.password ? ':' + u.password : '') + '@' : '';
	return u.protocol + '//' + auth + u.host + path + u.search;
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
