/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import { openaiEffort } from '../agent/effort';
import { PROVIDER_LABELS, guessModelInfo, isChatModelId, isFimName, isReasoningName, modelId } from './catalog';
import { guarded, joinUrl, missingKey, parseArgs, request, resolveBase, sseFromBody, verifyByListing, errorKind, type BaseUrl, type KeyGetter, type Rec, type SseEvent } from './http';
import { thinkingParams, thinkingRejected, thinkingUnverified } from './thinking';
import { remapToolIds } from './toolIds';
import { ProviderError, type ChatRequest, type FimRequest, type LLMContent, type LLMMessage, type LLMProvider, type ModelInfo, type ProviderId, type StreamEvent } from './types';

export interface CompatOptions {
	id: ProviderId;
	label?: string;
	/** May depend on the model id (per-model base URL overrides). */
	baseUrl: BaseUrl;
	getKey: KeyGetter;
	/** Default true. Local servers set false and send the key only if one exists. */
	requiresKey?: boolean;
	headers?: Record<string, string>;
	/** OpenAI proper wants max_completion_tokens; most compatible servers still use max_tokens. */
	maxTokensField?: 'max_tokens' | 'max_completion_tokens';
	/** `openai`: reasoning_effort; `openrouter`: reasoning:{effort}; `none`: nothing. */
	reasoning?: 'openai' | 'openrouter' | 'none';
	/** Role used for the system prompt on reasoning models. */
	reasoningSystemRole?: 'system' | 'developer';
	/** Send reasoning_content back on assistant turns with tool calls (DeepSeek). */
	echoReasoning?: boolean;
	/** Split a leading <think>...</think> out of content (R1 style servers). */
	thinkTags?: boolean;
	/** FIM endpoint candidates tried in order. */
	fimUrls?: (base: string) => string[];
	/** Turn an entry of the /models listing into a ModelInfo, or undefined to drop it. */
	parseModel?: (raw: Rec) => ModelInfo | undefined;
}

type OAMessage = Rec;

function dataUrl(mediaType: string, data: string): string { return `data:${mediaType};base64,${data}`; }

export function toOpenAIMessages(req: ChatRequest, o: Pick<CompatOptions, 'echoReasoning' | 'reasoningSystemRole'> & { id?: ProviderId }): OAMessage[] {
	const out: OAMessage[] = [];
	if (req.system) { out.push({ role: req.model.supportsThinking && o.reasoningSystemRole === 'developer' ? 'developer' : 'system', content: req.system }); }
	// Mistral only takes 9 character ids; ids from other providers are mapped, call and result alike
	const history = o.id === 'mistral' ? remapToolIds(req.messages, 'mistral') : req.messages;
	for (const m of history) {
		if (m.role === 'assistant') { out.push(assistantMessage(m, !!o.echoReasoning)); continue; }
		const parts: Rec[] = [];
		const later: Rec[] = [];
		for (const c of m.content) {
			if (c.type === 'tool_result') {
				out.push({ role: 'tool', tool_call_id: c.toolUseId, content: c.content || '(no output)' });
				if (c.images?.length) {
					later.push({ type: 'text', text: `Images returned by tool call ${c.toolUseId}:` }, ...c.images.map(i => ({ type: 'image_url', image_url: { url: dataUrl(i.mediaType, i.data) } })));
				}
			} else if (c.type === 'text') {
				if (c.text) { parts.push({ type: 'text', text: c.text }); }
			} else if (c.type === 'image') {
				parts.push({ type: 'image_url', image_url: { url: dataUrl(c.mediaType, c.data) } });
			}
		}
		const all = [...later, ...parts];
		if (!all.length) { continue; }
		out.push({ role: 'user', content: all.every(p => p.type === 'text') ? all.map(p => p.text).join('\n\n') : all });
	}
	return out;
}

function assistantMessage(m: LLMMessage, echoReasoning: boolean): OAMessage {
	const text = m.content.filter((c): c is Extract<LLMContent, { type: 'text' }> => c.type === 'text').map(c => c.text).join('');
	const calls = m.content.filter((c): c is Extract<LLMContent, { type: 'tool_use' }> => c.type === 'tool_use');
	const msg: OAMessage = { role: 'assistant', content: text || (calls.length ? null : '') };
	if (calls.length) {
		msg.tool_calls = calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }));
		if (echoReasoning) {
			const r = m.content.filter((c): c is Extract<LLMContent, { type: 'thinking' }> => c.type === 'thinking').map(c => c.text).join('');
			if (r) { msg.reasoning_content = r; }
		}
	}
	return msg;
}

export function buildOpenAIBody(req: ChatRequest, o: CompatOptions): Rec {
	const m = req.model;
	const body: Rec = { model: m.model, messages: toOpenAIMessages(req, o), stream: true, stream_options: { include_usage: true } };
	const reasoningModel = m.supportsThinking && o.reasoning === 'openai';
	const max = req.maxTokens ?? m.maxOutputTokens;
	body[o.maxTokensField ?? 'max_tokens'] = max;
	if (req.temperature !== undefined && !reasoningModel) { body.temperature = req.temperature; }
	if (req.tools?.length) {
		body.tools = req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
	}
	if (m.supportsThinking && req.thinking !== undefined) {
		if (o.reasoning === 'openai') { body.reasoning_effort = req.thinking ? openaiEffort(req.effort) : 'low'; }
		else if (o.reasoning === 'openrouter' && req.thinking) { body.reasoning = { effort: openaiEffort(req.effort) }; }
		else if (!o.reasoning || o.reasoning === 'none') { Object.assign(body, thinkingParams(o.id, m.model, req.thinking, req.effort)); }
	}
	return body;
}

// splits a leading <think>...</think> block of streamed content into thinking events
export class ThinkSplitter {
	private mode: 'start' | 'think' | 'text' = 'start';
	private buf = '';
	push(s: string): StreamEvent[] {
		this.buf += s;
		const out: StreamEvent[] = [];
		for (; ;) {
			if (this.mode === 'start') {
				const t = this.buf.trimStart();
				if (!t) { return out; }
				if ('<think>'.startsWith(t) && t.length < 7) { return out; }
				if (t.startsWith('<think>')) { this.buf = t.slice(7); this.mode = 'think'; continue; }
				this.mode = 'text';
			} else if (this.mode === 'think') {
				const i = this.buf.indexOf('</think>');
				if (i >= 0) {
					if (i > 0) { out.push({ type: 'thinking', text: this.buf.slice(0, i) }); }
					this.buf = this.buf.slice(i + 8).replace(/^\n+/, '');
					this.mode = 'text';
					continue;
				}
				let keep = 0;
				for (let k = Math.min(7, this.buf.length); k > 0; k--) { if ('</think>'.startsWith(this.buf.slice(-k))) { keep = k; break; } }
				const emit = this.buf.slice(0, this.buf.length - keep);
				if (emit) { out.push({ type: 'thinking', text: emit }); }
				this.buf = this.buf.slice(this.buf.length - keep);
				return out;
			} else {
				if (this.buf) { out.push({ type: 'text', text: this.buf }); this.buf = ''; }
				return out;
			}
		}
	}
	flush(): StreamEvent[] {
		const b = this.buf; this.buf = '';
		if (!b) { return []; }
		return [{ type: this.mode === 'think' ? 'thinking' : 'text', text: b }];
	}
}

interface Call { id: string; name: string; args: string; pending: string; started: boolean }

export async function* parseOpenAIStream(events: AsyncIterable<SseEvent>, opts: { provider: ProviderId; thinkTags?: boolean }): AsyncGenerator<StreamEvent> {
	const calls = new Map<number, Call>();
	let last = -1;
	let finish: string | undefined;
	let done = false;
	let usage: Rec | undefined;
	const split = opts.thinkTags ? new ThinkSplitter() : undefined;
	for await (const ev of events) {
		if (ev.data === '[DONE]') { done = true; break; }
		let j: Rec;
		try { j = JSON.parse(ev.data); } catch { continue; }
		if (j.error) {
			const msg = String(j.error.message ?? JSON.stringify(j.error));
			const status = typeof j.error.code === 'number' ? j.error.code : 500;
			throw new ProviderError(msg, opts.provider, status, errorKind(status, msg));
		}
		if (j.usage) { usage = j.usage; }
		const ch = j.choices?.[0];
		if (!ch) { continue; }
		const d: Rec = ch.delta ?? {};
		const r = d.reasoning_content ?? d.reasoning;
		if (typeof r === 'string' && r) { yield { type: 'thinking', text: r }; }
		if (typeof d.content === 'string' && d.content) {
			if (split) { yield* split.push(d.content); } else { yield { type: 'text', text: d.content }; }
		}
		for (const tc of (d.tool_calls as Rec[] | undefined) ?? []) {
			let idx: number;
			if (tc.index !== undefined) { idx = tc.index; }
			else if (tc.id) { idx = [...calls.entries()].find(([, x]) => x.id === tc.id)?.[0] ?? calls.size; }
			else { idx = Math.max(last, 0); }
			last = idx;
			let c = calls.get(idx);
			if (!c) { c = { id: '', name: '', args: '', pending: '', started: false }; calls.set(idx, c); }
			if (tc.id && !c.id) { c.id = tc.id; }
			if (tc.function?.name && !c.started) { c.name += tc.function.name; }
			const a = tc.function?.arguments;
			const frag = typeof a === 'string' ? a : a && typeof a === 'object' ? JSON.stringify(a) : '';
			if (c.name && !c.started) {
				c.started = true;
				c.id ||= `call_${idx}_${Math.random().toString(36).slice(2, 8)}`;
				yield { type: 'tool_call_start', id: c.id, name: c.name };
				if (c.pending) { c.args += c.pending; yield { type: 'tool_call_delta', id: c.id, argsDelta: c.pending }; c.pending = ''; }
			}
			if (frag) {
				if (c.started) { c.args += frag; yield { type: 'tool_call_delta', id: c.id, argsDelta: frag }; } else { c.pending += frag; }
			}
		}
		if (ch.finish_reason) { finish = ch.finish_reason; }
	}
	// a stream that just stops is a dropped connection, and cut off tool calls must not run
	if (!done && !finish) { throw new ProviderError('The connection closed before the reply finished.', opts.provider, undefined, 'network'); }
	if (split) { yield* split.flush(); }
	let sawCalls = false;
	for (const [idx, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
		if (!c.name) { continue; }
		if (!c.started) {
			c.id ||= `call_${idx}_${Math.random().toString(36).slice(2, 8)}`;
			yield { type: 'tool_call_start', id: c.id, name: c.name };
			if (c.pending) { c.args += c.pending; yield { type: 'tool_call_delta', id: c.id, argsDelta: c.pending }; }
		}
		sawCalls = true;
		yield { type: 'tool_call', id: c.id, name: c.name, input: parseArgs(c.args) };
	}
	if (usage) {
		const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
		yield { type: 'usage', inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0, ...(cached ? { cacheReadTokens: cached } : {}) };
	}
	yield { type: 'done', stopReason: sawCalls || finish === 'tool_calls' ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'stop' : 'end_turn' };
}

export class OpenAICompatibleProvider implements LLMProvider {
	readonly id: ProviderId;
	readonly label: string;
	constructor(protected readonly o: CompatOptions) {
		this.id = o.id;
		this.label = o.label ?? PROVIDER_LABELS[o.id];
	}

	protected base(model?: string): string { return resolveBase(this.o.baseUrl, model); }

	protected async headers(): Promise<Record<string, string>> {
		const key = await this.o.getKey();
		if (!key && this.o.requiresKey !== false) { throw missingKey(this.id, this.label); }
		const h: Record<string, string> = { 'content-type': 'application/json', ...this.o.headers };
		if (key) {
			h.authorization = `Bearer ${key}`;
			if (/\.azure\.com|\.azure-api\.net/.test(this.base())) { h['api-key'] = key; }
		}
		return h;
	}

	stream(req: ChatRequest): AsyncIterable<StreamEvent> {
		return guarded(this.id, req.signal, this.run(req));
	}

	private async* run(req: ChatRequest): AsyncGenerator<StreamEvent> {
		const send = async (): Promise<Response> => request(this.id, joinUrl(this.base(req.model.id), '/chat/completions'), {
			method: 'POST', headers: { ...await this.headers(), accept: 'text/event-stream' }, body: JSON.stringify(buildOpenAIBody(req, this.o)),
		}, req.signal, req.retries);
		let res: Response;
		try {
			res = await send();
		} catch (e) {
			// an undocumented thinking field the provider refuses: drop it for this model and ask again at its default
			if (!(e instanceof ProviderError) || e.status !== 400 || !thinkingUnverified(this.id, req.model.model) || req.thinking === undefined) { throw e; }
			thinkingRejected(this.id, req.model.model);
			res = await send();
		}
		yield* parseOpenAIStream(sseFromBody(res, req.onActivity), { provider: this.id, thinkTags: this.o.thinkTags });
	}

	async* fim(req: FimRequest): AsyncGenerator<string> {
		const urls = this.o.fimUrls?.(this.base(req.model.id));
		if (!urls?.length) { throw new ProviderError(`${this.label} has no FIM endpoint`, this.id); }
		const body = JSON.stringify({
			model: req.model.model, prompt: req.prefix, suffix: req.suffix, max_tokens: req.maxTokens, stream: true,
			...(req.stop?.length ? { stop: req.stop } : {}), ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
		});
		try {
			let res: Response | undefined;
			for (let i = 0; i < urls.length; i++) {
				try {
					res = await request(this.id, urls[i], { method: 'POST', headers: { ...await this.headers(), accept: 'text/event-stream' }, body }, req.signal);
					break;
				} catch (e) {
					if (i === urls.length - 1 || !(e instanceof ProviderError) || (e.kind !== 'auth' && e.kind !== 'network')) { throw e; }
				}
			}
			for await (const ev of sseFromBody(res!)) {
				if (ev.data === '[DONE]') { return; }
				let j: Rec;
				try { j = JSON.parse(ev.data); } catch { continue; }
				const c = j.choices?.[0];
				const t = c?.text ?? c?.delta?.content;
				if (typeof t === 'string' && t) { yield t; }
				if (c?.finish_reason) { return; }
			}
		} catch (e) {
			if (req.signal.aborted || (e instanceof Error && e.name === 'AbortError')) { return; }
			throw e;
		}
	}

	protected async fetchModelList(signal?: AbortSignal, path = '/models'): Promise<Rec[]> {
		const res = await request(this.id, joinUrl(this.base(), path), { headers: await this.headers() }, signal, 0);
		const j = await res.json() as Rec;
		return (Array.isArray(j) ? j : j.data ?? j.models ?? []) as Rec[];
	}

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		const parse = this.o.parseModel ?? ((r: Rec) => defaultParse(this.id, r));
		const seen = new Set<string>();
		const out: ModelInfo[] = [];
		for (const raw of await this.fetchModelList(signal)) {
			const m = parse(raw);
			if (m && !seen.has(m.id)) { seen.add(m.id); out.push(m); }
		}
		return out;
	}

	verify(signal?: AbortSignal) { return verifyByListing(s => this.listModels(s), signal); }
}

function defaultParse(provider: ProviderId, raw: Rec): ModelInfo | undefined {
	const id = String(raw.id ?? raw.name ?? '');
	if (!id || !isChatModelId(provider, id)) { return undefined; }
	const ctx = raw.context_window ?? raw.context_length ?? raw.max_context_length ?? raw.max_model_len;
	return guessModelInfo(provider, id, {
		...(ctx ? { contextWindow: ctx } : {}),
		...(raw.max_completion_tokens ? { maxOutputTokens: raw.max_completion_tokens } : {}),
	});
}

function parseOpenRouter(raw: Rec): ModelInfo | undefined {
	const id = String(raw.id ?? '');
	const sp: string[] = raw.supported_parameters ?? [];
	const outMods: string[] = raw.architecture?.output_modalities ?? ['text'];
	if (!id || !isChatModelId('openrouter', id) || !sp.includes('tools') || !outMods.includes('text') || outMods.includes('image')) { return undefined; }
	const ctx = raw.context_length ?? 128_000;
	return {
		id: modelId('openrouter', id), provider: 'openrouter', model: id, label: raw.name ?? id,
		contextWindow: ctx,
		maxOutputTokens: Math.min(raw.top_provider?.max_completion_tokens ?? 16_384, ctx),
		supportsTools: true,
		supportsImages: (raw.architecture?.input_modalities ?? []).includes('image'),
		supportsThinking: sp.includes('reasoning'),
	};
}

function parseMistral(raw: Rec): ModelInfo | undefined {
	const id = String(raw.id ?? '');
	const cap: Rec = raw.capabilities ?? {};
	if (!id || !isChatModelId('mistral', id) || raw.deprecation || /embed|moderation|ocr|voxtral|transcribe/i.test(id) || (cap.completion_chat === false && !cap.completion_fim)) { return undefined; }
	const fim = !!cap.completion_fim || isFimName('mistral', id);
	const ctx = raw.max_context_length ?? 128_000;
	return {
		id: modelId('mistral', id), provider: 'mistral', model: id, label: raw.name && raw.name !== id ? `${raw.name}` : id,
		contextWindow: ctx, maxOutputTokens: Math.min(16_384, ctx),
		supportsTools: cap.function_calling !== false, supportsImages: !!cap.vision,
		supportsThinking: /magistral/i.test(id), ...(fim ? { supportsFim: true } : {}),
	};
}

function parseGroq(raw: Rec): ModelInfo | undefined {
	const id = String(raw.id ?? '');
	if (!id || raw.active === false || !isChatModelId('groq', id) || /allam|compound-mini-x/i.test(id)) { return undefined; }
	return guessModelInfo('groq', id, {
		contextWindow: raw.context_window ?? 131_072,
		maxOutputTokens: Math.min(raw.max_completion_tokens ?? 8_192, raw.context_window ?? 131_072),
		supportsThinking: /gpt-oss|qwen3|deepseek-r1|kimi-k2-thinking/i.test(id),
	});
}

function parseLmStudio(raw: Rec, fallback = false): ModelInfo | undefined {
	const id = String(raw.id ?? '');
	if (!id || /embed/i.test(id) || raw.type === 'embeddings') { return undefined; }
	// a model that is not loaded reports its trained maximum but loads with a small default window
	const ctx = raw.loaded_context_length ?? (raw.state === 'loaded' ? raw.max_context_length : undefined) ?? (fallback && raw.max_context_length === undefined ? 32_768 : Math.min(raw.max_context_length ?? 8_192, 8_192));
	return {
		id: modelId('lmstudio', id), provider: 'lmstudio', model: id, label: id,
		contextWindow: ctx, maxOutputTokens: Math.min(8_192, ctx),
		supportsTools: Array.isArray(raw.capabilities) ? raw.capabilities.includes('tool_use') : true,
		supportsImages: raw.type === 'vlm',
		supportsThinking: isReasoningName('lmstudio', id),
		...(isFimName('lmstudio', id) ? { supportsFim: true } : {}),
	};
}

class LmStudioProvider extends OpenAICompatibleProvider {
	/** Prefers LM Studio's richer /api/v0/models (context length, vision, tool use); falls back to /v1/models. */
	override async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		let raws: Rec[];
		let fallback = false;
		try {
			const root = this.base().replace(/\/v1$/, '');
			const res = await request(this.id, joinUrl(root, '/api/v0/models'), { headers: await this.headers() }, signal, 0);
			raws = ((await res.json()) as Rec).data ?? [];
		} catch (e) {
			if (e instanceof ProviderError && e.kind === 'network') { throw e; }
			raws = await this.fetchModelList(signal);
			fallback = true;
		}
		return raws.map(r => parseLmStudio(r, fallback)).filter((m): m is ModelInfo => !!m);
	}
}

export interface CompatDeps {
	getKey: KeyGetter;
	baseUrl?: BaseUrl;
}

export class OpenAIProvider extends OpenAICompatibleProvider {
	constructor(d: CompatDeps) {
		super({
			id: 'openai', baseUrl: d.baseUrl ?? 'https://api.openai.com/v1', getKey: d.getKey,
			maxTokensField: 'max_completion_tokens', reasoning: 'openai', reasoningSystemRole: 'developer',
		});
	}
}

export function createOpenAICompatible(id: Exclude<ProviderId, 'anthropic' | 'google' | 'ollama' | 'openai'>, d: CompatDeps): OpenAICompatibleProvider {
	const key = d.getKey;
	switch (id) {
		case 'openrouter':
			return new OpenAICompatibleProvider({
				id, baseUrl: d.baseUrl ?? 'https://openrouter.ai/api/v1', getKey: key, reasoning: 'openrouter', thinkTags: true,
				headers: { 'HTTP-Referer': 'https://github.com/noah-thing/open-cursor', 'X-Title': 'OpenCursor' }, parseModel: parseOpenRouter,
			});
		case 'deepseek':
			return new OpenAICompatibleProvider({
				id, baseUrl: d.baseUrl ?? 'https://api.deepseek.com', getKey: key, echoReasoning: true, fimUrls: b => [joinUrl(b, '/beta/completions')],
			});
		case 'xai':
			return new OpenAICompatibleProvider({ id, baseUrl: d.baseUrl ?? 'https://api.x.ai/v1', getKey: key });
		case 'mistral':
			return new OpenAICompatibleProvider({
				id, baseUrl: d.baseUrl ?? 'https://api.mistral.ai/v1', getKey: key, parseModel: parseMistral,
				fimUrls: () => ['https://codestral.mistral.ai/v1/fim/completions', 'https://api.mistral.ai/v1/fim/completions'],
			});
		case 'groq':
			return new OpenAICompatibleProvider({ id, baseUrl: d.baseUrl ?? 'https://api.groq.com/openai/v1', getKey: key, thinkTags: true, parseModel: parseGroq });
		case 'nvidia':
		case 'zai':
		case 'sambanova':
			return new OpenAICompatibleProvider({ id, baseUrl: d.baseUrl ?? { nvidia: 'https://integrate.api.nvidia.com/v1', zai: 'https://api.z.ai/api/paas/v4', sambanova: 'https://api.sambanova.ai/v1' }[id], getKey: key, thinkTags: true });
		case 'free':
			throw new Error('Free (auto) is routed by the registry, not by an adapter.');
		case 'lmstudio':
			return new LmStudioProvider({ id, baseUrl: d.baseUrl ?? 'http://localhost:1234/v1', getKey: key, requiresKey: false, thinkTags: true });
		case 'custom':
			return new OpenAICompatibleProvider({ id, baseUrl: d.baseUrl ?? 'http://localhost:8000/v1', getKey: key, requiresKey: false, thinkTags: true });
	}
}
