/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import { isFimName, modelId } from './catalog';
import { guarded, isAbort, joinUrl, readLines, request, resolveBase, verifyByListing, type BaseUrl, type Rec } from './http';
import { ProviderError, type ChatRequest, type FimRequest, type LLMMessage, type LLMProvider, type ModelInfo, type StreamEvent } from './types';

export interface OllamaOptions {
	baseUrl?: BaseUrl;
	/** Context length passed as num_ctx (Ollama's own default is tiny). Return 0 to leave it to the server. */
	numCtx?: () => number;
	/** Optional bearer token (Ollama behind a proxy / Ollama cloud). */
	getKey?: () => Promise<string | undefined> | string | undefined;
}

const DEFAULT_CTX = 16_384;

export function toOllamaMessages(system: string, messages: LLMMessage[]): Rec[] {
	const names = new Map<string, string>();
	for (const m of messages) { for (const c of m.content) { if (c.type === 'tool_use') { names.set(c.id, c.name); } } }
	const out: Rec[] = [];
	if (system) { out.push({ role: 'system', content: system }); }
	for (const m of messages) {
		const text: string[] = [];
		const images: string[] = [];
		const calls: Rec[] = [];
		let thinking = '';
		for (const c of m.content) {
			switch (c.type) {
				case 'text': text.push(c.text); break;
				case 'image': images.push(c.data); break;
				case 'thinking': thinking += c.text; break;
				case 'tool_use': calls.push({ function: { name: c.name, arguments: c.input && typeof c.input === 'object' ? c.input : {} } }); break;
				case 'tool_result':
					out.push({ role: 'tool', tool_name: names.get(c.toolUseId), content: c.content || '(no output)' });
					for (const i of c.images ?? []) { images.push(i.data); }
					break;
			}
		}
		if (!text.length && !images.length && !calls.length) { continue; }
		const msg: Rec = { role: m.role, content: text.join('\n\n') };
		if (images.length) { msg.images = images; }
		if (calls.length) { msg.tool_calls = calls; }
		if (m.role === 'assistant' && thinking && calls.length) { msg.thinking = thinking; }
		out.push(msg);
	}
	return out;
}

export function buildOllamaBody(req: ChatRequest, numCtx: number): Rec {
	const m = req.model;
	const options: Rec = { num_predict: req.maxTokens ?? m.maxOutputTokens };
	if (req.temperature !== undefined) { options.temperature = req.temperature; }
	if (numCtx > 0) { options.num_ctx = Math.min(numCtx, m.contextWindow || numCtx); }
	const body: Rec = { model: m.model, messages: toOllamaMessages(req.system, req.messages), stream: true, options };
	if (req.tools?.length && m.supportsTools) {
		body.tools = req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
	}
	if (m.supportsThinking && req.thinking !== undefined) { body.think = req.thinking; }
	return body;
}

export async function* parseOllamaStream(lines: AsyncIterable<string>): AsyncGenerator<StreamEvent> {
	let calls = 0;
	let reason: string | undefined;
	let usage: { i: number; o: number } | undefined;
	for await (const line of lines) {
		if (!line.trim()) { continue; }
		let j: Rec;
		try { j = JSON.parse(line); } catch { continue; }
		if (j.error) { throw new ProviderError(String(j.error), 'ollama', undefined, /context|too long|exceeds/i.test(String(j.error)) ? 'context' : 'other'); }
		const msg: Rec = j.message ?? {};
		if (msg.thinking) { yield { type: 'thinking', text: msg.thinking }; }
		if (msg.content) { yield { type: 'text', text: msg.content }; }
		for (const tc of (msg.tool_calls as Rec[] | undefined) ?? []) {
			calls++;
			const id = tc.id ?? `ollama_${Date.now().toString(36)}_${calls}`;
			let args = tc.function?.arguments ?? {};
			if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
			yield { type: 'tool_call_start', id, name: tc.function?.name };
			yield { type: 'tool_call_delta', id, argsDelta: JSON.stringify(args) };
			yield { type: 'tool_call', id, name: tc.function?.name, input: args };
		}
		if (j.done) {
			reason = j.done_reason;
			usage = { i: j.prompt_eval_count ?? 0, o: j.eval_count ?? 0 };
		}
	}
	if (usage) { yield { type: 'usage', inputTokens: usage.i, outputTokens: usage.o }; }
	yield { type: 'done', stopReason: calls ? 'tool_use' : reason === 'length' ? 'max_tokens' : 'end_turn' };
}

/** Raw FIM tokens for families whose Ollama template lacks suffix support. */
function rawFim(model: string, prefix: string, suffix: string): { prompt: string; stop: string[] } | undefined {
	const m = model.toLowerCase();
	if (/qwen.*coder/.test(m)) { return { prompt: `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`, stop: ['<|endoftext|>', '<|fim_pad|>', '<|file_sep|>'] }; }
	if (/deepseek-coder/.test(m)) { return { prompt: `<｜fim▁begin｜>${prefix}<｜fim▁hole｜>${suffix}<｜fim▁end｜>`, stop: ['<｜end▁of▁sentence｜>'] }; }
	if (/starcoder/.test(m)) { return { prompt: `<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>`, stop: ['<|endoftext|>', '<file_sep>'] }; }
	if (/codellama/.test(m)) { return { prompt: `<PRE> ${prefix} <SUF>${suffix} <MID>`, stop: ['<EOT>'] }; }
	return undefined;
}

export class OllamaProvider implements LLMProvider {
	readonly id = 'ollama';
	readonly label = 'Ollama';
	constructor(private readonly o: OllamaOptions = {}) { }

	private base(model?: string): string { return resolveBase(this.o.baseUrl ?? 'http://localhost:11434', model); }

	private async headers(): Promise<Record<string, string>> {
		const key = await this.o.getKey?.();
		return { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
	}

	stream(req: ChatRequest): AsyncIterable<StreamEvent> {
		return guarded('ollama', req.signal, this.run(req));
	}

	private async* run(req: ChatRequest): AsyncGenerator<StreamEvent> {
		const numCtx = this.o.numCtx ? this.o.numCtx() : DEFAULT_CTX;
		const res = await request('ollama', joinUrl(this.base(req.model.id), '/api/chat'), {
			method: 'POST', headers: await this.headers(), body: JSON.stringify(buildOllamaBody(req, numCtx)),
		}, req.signal);
		yield* parseOllamaStream(readLines(res.body!));
	}

	async* fim(req: FimRequest): AsyncGenerator<string> {
		const call = async (raw: boolean) => {
			const f = rawFim(req.model.model, req.prefix, req.suffix);
			const options: Rec = { num_predict: req.maxTokens, stop: [...(req.stop ?? []), ...(raw && f ? f.stop : [])] };
			if (req.temperature !== undefined) { options.temperature = req.temperature; }
			const body = raw && f ? { model: req.model.model, prompt: f.prompt, raw: true, stream: true, options } : { model: req.model.model, prompt: req.prefix, suffix: req.suffix, stream: true, options };
			return request('ollama', joinUrl(this.base(req.model.id), '/api/generate'), { method: 'POST', headers: await this.headers(), body: JSON.stringify(body) }, req.signal);
		};
		try {
			let res: Response;
			try { res = await call(false); } catch (e) {
				if (e instanceof ProviderError && e.status === 400 && /insert|suffix/i.test(e.message) && rawFim(req.model.model, '', '')) { res = await call(true); } else { throw e; }
			}
			for await (const line of readLines(res.body!)) {
				if (!line.trim()) { continue; }
				let j: Rec;
				try { j = JSON.parse(line); } catch { continue; }
				if (j.error) { throw new ProviderError(String(j.error), 'ollama'); }
				if (j.response) { yield j.response as string; }
				if (j.done) { return; }
			}
		} catch (e) {
			if (isAbort(e, req.signal)) { return; }
			throw e;
		}
	}

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		const tags = await (await request('ollama', joinUrl(this.base(), '/api/tags'), { headers: await this.headers() }, signal, 0)).json() as Rec;
		const names: string[] = ((tags.models as Rec[] | undefined) ?? []).map(m => String(m.model ?? m.name));
		const numCtx = this.o.numCtx ? this.o.numCtx() : DEFAULT_CTX;
		const out: (ModelInfo | undefined)[] = new Array(names.length);
		let next = 0;
		const worker = async () => {
			while (next < names.length) {
				const i = next++;
				out[i] = await this.describe(names[i], numCtx, signal);
			}
		};
		await Promise.all([worker(), worker(), worker(), worker()]);
		return out.filter((m): m is ModelInfo => !!m);
	}

	private async describe(name: string, numCtx: number, signal?: AbortSignal): Promise<ModelInfo | undefined> {
		let show: Rec = {};
		try {
			const res = await request('ollama', joinUrl(this.base(), '/api/show'), { method: 'POST', headers: await this.headers(), body: JSON.stringify({ model: name }) }, signal, 0);
			show = await res.json() as Rec;
		} catch (e) { if (isAbort(e, signal)) { throw e; } }
		const caps: string[] | undefined = show.capabilities;
		if (caps && !caps.includes('completion')) { return undefined; } // embedding-only
		const info: Rec = show.model_info ?? {};
		const ctxKey = Object.keys(info).find(k => k.endsWith('.context_length'));
		const modelCtx: number = ctxKey ? info[ctxKey] : 32_768;
		const ctx = numCtx > 0 ? Math.min(modelCtx, numCtx) : modelCtx;
		const fim = !!caps?.includes('insert') || isFimName('ollama', name);
		return {
			id: modelId('ollama', name), provider: 'ollama', model: name, label: name,
			contextWindow: ctx, maxOutputTokens: Math.min(8_192, ctx),
			supportsTools: caps ? caps.includes('tools') : true,
			supportsImages: caps ? caps.includes('vision') : false,
			supportsThinking: caps ? caps.includes('thinking') : false,
			...(fim ? { supportsFim: true } : {}),
		};
	}

	verify(signal?: AbortSignal) { return verifyByListing(s => this.listModels(s), signal); }
}
