/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import { guessModelInfo, isChatModelId } from './catalog';
import { guarded, joinUrl, missingKey, request, resolveBase, sseFromBody, verifyByListing, type BaseUrl, type KeyGetter, type Rec, type SseEvent } from './http';
import { ProviderError, type ChatRequest, type LLMMessage, type LLMProvider, type ModelInfo, type StreamEvent } from './types';

/** Gemini 3 insists on a thought signature per function call turn; this documented value skips validation. */
const SKIP_SIGNATURE = 'skip_thought_signature_validator';
const SIG = 'gsig:';

export interface GoogleOptions {
	getKey: KeyGetter;
	baseUrl?: BaseUrl;
}

const SCHEMA_KEYS = new Set(['type', 'description', 'properties', 'required', 'items', 'enum', 'format', 'nullable', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'anyOf', 'title']);

/** Reduce a JSON Schema to the OpenAPI subset Gemini accepts. */
export function sanitizeSchema(s: unknown): unknown {
	if (Array.isArray(s)) { return s.map(sanitizeSchema); }
	if (!s || typeof s !== 'object') { return s; }
	const src = s as Rec;
	const out: Rec = {};
	for (const [k, v] of Object.entries(src)) {
		if (!SCHEMA_KEYS.has(k)) { continue; }
		if (k === 'properties' && v && typeof v === 'object') {
			out.properties = Object.fromEntries(Object.entries(v as Rec).map(([n, p]) => [n, sanitizeSchema(p)]));
		} else if (k === 'type' && Array.isArray(v)) {
			const t = v.filter(x => x !== 'null');
			out.type = t[0] ?? 'string';
			if (v.includes('null')) { out.nullable = true; }
		} else if (k === 'enum' || k === 'required') {
			out[k] = v;
		} else if (k === 'items' || k === 'anyOf') {
			out[k] = sanitizeSchema(v);
		} else {
			out[k] = v;
		}
	}
	if (out.enum && out.type !== 'string') { out.enum = (out.enum as unknown[]).map(String); out.type = 'string'; }
	if (out.type === 'object' && out.properties && !Object.keys(out.properties).length) { delete out.properties; }
	return out;
}

export function toGeminiContents(messages: LLMMessage[], skipSig: boolean): Rec[] {
	const names = new Map<string, string>();
	for (const m of messages) { for (const c of m.content) { if (c.type === 'tool_use') { names.set(c.id, c.name); } } }
	const out: Rec[] = [];
	for (const m of messages) {
		const parts: Rec[] = [];
		let sig: string | undefined;
		const after: Rec[] = [];
		let firstCall = true;
		for (const c of m.content) {
			switch (c.type) {
				case 'text': if (c.text) { parts.push({ text: c.text }); } break;
				case 'image': parts.push({ inlineData: { mimeType: c.mediaType, data: c.data } }); break;
				case 'thinking': if (c.signature?.startsWith(SIG)) { sig = c.signature.slice(SIG.length); } break;
				case 'tool_use': {
					const p: Rec = { functionCall: { name: c.name, args: c.input && typeof c.input === 'object' ? c.input : {} } };
					if (sig) { p.thoughtSignature = sig; sig = undefined; }
					else if (skipSig && firstCall) { p.thoughtSignature = SKIP_SIGNATURE; }
					firstCall = false;
					parts.push(p);
					break;
				}
				case 'tool_result':
					parts.push({ functionResponse: { name: names.get(c.toolUseId) ?? 'tool', response: c.isError ? { error: c.content } : { output: c.content } } });
					for (const i of c.images ?? []) { after.push({ inlineData: { mimeType: i.mediaType, data: i.data } }); }
					break;
			}
		}
		// a signature that preceded plain text rides on the first text part
		if (sig && m.role === 'assistant') { const t = parts.find(p => p.text !== undefined); if (t) { t.thoughtSignature = sig; } }
		parts.push(...after);
		if (parts.length) { out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts }); }
	}
	return out;
}

export function buildGeminiBody(req: ChatRequest): Rec {
	const m = req.model;
	const gen: Rec = { maxOutputTokens: req.maxTokens ?? m.maxOutputTokens };
	if (req.temperature !== undefined) { gen.temperature = req.temperature; }
	if (m.supportsThinking) {
		if (req.thinking) { gen.thinkingConfig = { includeThoughts: true }; }
		else if (req.thinking === false && /2\.5-flash/.test(m.model)) { gen.thinkingConfig = { thinkingBudget: 0 }; }
	}
	const body: Rec = { contents: toGeminiContents(req.messages, /gemini-3/.test(m.model)), generationConfig: gen };
	if (req.system) { body.systemInstruction = { parts: [{ text: req.system }] }; }
	if (req.tools?.length) {
		body.tools = [{
			functionDeclarations: req.tools.map(t => {
				const params = sanitizeSchema(t.parameters) as Rec;
				return { name: t.name, description: t.description, ...(params.properties ? { parameters: params } : {}) };
			}),
		}];
	}
	return body;
}

export async function* parseGeminiStream(events: AsyncIterable<SseEvent>): AsyncGenerator<StreamEvent> {
	let usage: Rec | undefined;
	let finish: string | undefined;
	let calls = 0;
	for await (const ev of events) {
		let j: Rec;
		try { j = JSON.parse(ev.data); } catch { continue; }
		if (j.error) { throw new ProviderError(String(j.error.message ?? 'stream error'), 'google', j.error.code, j.error.code === 429 ? 'rate' : 'other'); }
		if (j.usageMetadata) { usage = j.usageMetadata; }
		const cand = j.candidates?.[0];
		if (!cand) { continue; }
		if (cand.finishReason) { finish = cand.finishReason; }
		for (const p of (cand.content?.parts as Rec[] | undefined) ?? []) {
			if (p.functionCall) {
				calls++;
				const id = p.functionCall.id ?? `gc_${Date.now().toString(36)}_${calls}`;
				const args = p.functionCall.args ?? {};
				if (p.thoughtSignature) { yield { type: 'thinking_signature', signature: SIG + p.thoughtSignature }; }
				yield { type: 'tool_call_start', id, name: p.functionCall.name };
				yield { type: 'tool_call_delta', id, argsDelta: JSON.stringify(args) };
				yield { type: 'tool_call', id, name: p.functionCall.name, input: args };
			} else if (typeof p.text === 'string') {
				if (p.thought) { if (p.text) { yield { type: 'thinking', text: p.text }; } }
				else {
					if (p.text) { yield { type: 'text', text: p.text }; }
					if (p.thoughtSignature) { yield { type: 'thinking_signature', signature: SIG + p.thoughtSignature }; }
				}
			}
		}
	}
	if (usage) {
		yield {
			type: 'usage', inputTokens: usage.promptTokenCount ?? 0, outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
			...(usage.cachedContentTokenCount ? { cacheReadTokens: usage.cachedContentTokenCount } : {}),
		};
	}
	yield { type: 'done', stopReason: calls ? 'tool_use' : finish === 'MAX_TOKENS' ? 'max_tokens' : finish && finish !== 'STOP' ? 'stop' : 'end_turn' };
}

export class GoogleProvider implements LLMProvider {
	readonly id = 'google';
	readonly label = 'Google Gemini';
	constructor(private readonly o: GoogleOptions) { }

	private base(model?: string): string { return resolveBase(this.o.baseUrl ?? 'https://generativelanguage.googleapis.com', model); }

	private async headers(): Promise<Record<string, string>> {
		const key = await this.o.getKey();
		if (!key) { throw missingKey('google', this.label); }
		return { 'content-type': 'application/json', 'x-goog-api-key': key };
	}

	stream(req: ChatRequest): AsyncIterable<StreamEvent> {
		return guarded('google', req.signal, this.run(req));
	}

	private async* run(req: ChatRequest): AsyncGenerator<StreamEvent> {
		const url = joinUrl(this.base(req.model.id), `/v1beta/models/${encodeURIComponent(req.model.model)}:streamGenerateContent?alt=sse`);
		const res = await request('google', url, { method: 'POST', headers: await this.headers(), body: JSON.stringify(buildGeminiBody(req)) }, req.signal);
		yield* parseGeminiStream(sseFromBody(res));
	}

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		const out: ModelInfo[] = [];
		let token = '';
		for (let page = 0; page < 5; page++) {
			const url = joinUrl(this.base(), `/v1beta/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
			const j = await (await request('google', url, { headers: await this.headers() }, signal, 0)).json() as Rec;
			for (const m of (j.models as Rec[] | undefined) ?? []) {
				const id = String(m.name ?? '').replace(/^models\//, '');
				if (!isChatModelId('google', id) || !(m.supportedGenerationMethods ?? []).includes('generateContent') || /native|live|gemma|learnlm|robotics|computer/i.test(id)) { continue; }
				out.push(guessModelInfo('google', id, {
					label: m.displayName ?? id,
					contextWindow: m.inputTokenLimit ?? 1_048_576,
					maxOutputTokens: m.outputTokenLimit ?? 65_536,
					supportsThinking: m.thinking ?? /gemini-(2\.5|3)/.test(id),
					supportsImages: true,
				}));
			}
			token = j.nextPageToken ?? '';
			if (!token) { break; }
		}
		return out;
	}

	verify(signal?: AbortSignal) { return verifyByListing(s => this.listModels(s), signal); }
}
