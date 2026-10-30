/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import { anthropicBudget } from '../agent/effort';
import { ANTHROPIC_MODELS, guessModelInfo, isChatModelId } from './catalog';
import { guarded, joinUrl, missingKey, parseArgs, request, resolveBase, sseFromBody, verifyByListing, errorKind, type BaseUrl, type KeyGetter, type Rec, type SseEvent } from './http';
import { ProviderError, type ChatRequest, type LLMContent, type LLMMessage, type LLMProvider, type ModelInfo, type StreamEvent } from './types';

const VERSION = '2023-06-01';
const REDACTED = 'redacted:';
const CACHE = { type: 'ephemeral' } as const;

export interface AnthropicOptions {
	getKey: KeyGetter;
	baseUrl?: BaseUrl;
}

function toolResultBlock(c: Extract<LLMContent, { type: 'tool_result' }>): Rec {
	const text = c.content || (c.images?.length ? '' : '(no output)');
	let content: unknown = text;
	if (c.images?.length) {
		content = [
			...(text ? [{ type: 'text', text }] : []),
			...c.images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
		];
	}
	return { type: 'tool_result', tool_use_id: c.toolUseId, content, ...(c.isError ? { is_error: true } : {}) };
}

function block(c: LLMContent): Rec | undefined {
	switch (c.type) {
		case 'text': return c.text.trim() ? { type: 'text', text: c.text } : undefined;
		case 'image': return { type: 'image', source: { type: 'base64', media_type: c.mediaType, data: c.data } };
		case 'tool_use': return { type: 'tool_use', id: c.id, name: c.name, input: c.input && typeof c.input === 'object' ? c.input : {} };
		case 'tool_result': return toolResultBlock(c);
		case 'thinking':
			// unsigned reasoning, or a Gemini signature from earlier in the chat, is not Anthropic's to verify
			if (!c.signature || c.signature.startsWith('gsig:')) { return undefined; }
			if (c.signature.startsWith(REDACTED)) { return { type: 'redacted_thinking', data: c.signature.slice(REDACTED.length) }; }
			return { type: 'thinking', thinking: c.text, signature: c.signature };
	}
}

export function toAnthropicMessages(messages: LLMMessage[]): Rec[] {
	const out: Rec[] = [];
	for (const m of messages) {
		let blocks = m.content.map(block).filter((b): b is Rec => !!b);
		if (!blocks.length) { continue; }
		if (m.role === 'user') {
			// tool_result blocks must come first in a user turn
			blocks = [...blocks.filter(b => b.type === 'tool_result'), ...blocks.filter(b => b.type !== 'tool_result')];
		}
		out.push({ role: m.role, content: blocks });
	}
	return out;
}

/** Thinking requires every assistant turn of the current tool loop to start with a signed thinking block. */
function canThink(messages: LLMMessage[]): boolean {
	let i = messages.length - 1;
	while (i >= 0 && !(messages[i].role === 'user' && messages[i].content.some(c => c.type !== 'tool_result'))) { i--; }
	return messages.slice(i + 1).every(m => m.role !== 'assistant' || !m.content.some(c => c.type === 'tool_use') || m.content.some(c => c.type === 'thinking' && c.signature));
}

export function buildAnthropicBody(req: ChatRequest): Rec {
	const m = req.model;
	const max = req.maxTokens ?? m.maxOutputTokens;
	const messages = toAnthropicMessages(req.messages);
	// cache the two most recent user turns (system and tools take the other two breakpoints)
	let marked = 0;
	for (let i = messages.length - 1; i >= 0 && marked < 2; i--) {
		if (messages[i].role !== 'user') { continue; }
		const last = messages[i].content[messages[i].content.length - 1] as Rec;
		last.cache_control = CACHE;
		marked++;
	}
	const body: Rec = { model: m.model, max_tokens: max, stream: true, messages };
	if (req.system) { body.system = [{ type: 'text', text: req.system, cache_control: CACHE }]; }
	if (req.tools?.length) {
		body.tools = req.tools.map((t, i, a) => ({
			name: t.name, description: t.description, input_schema: t.parameters,
			...(i === a.length - 1 ? { cache_control: CACHE } : {}),
		}));
	}
	if (req.thinking && m.supportsThinking && max > 2048 && canThink(req.messages)) {
		body.thinking = { type: 'enabled', budget_tokens: anthropicBudget(req.effort, max) };
	} else if (req.temperature !== undefined) {
		body.temperature = req.temperature;
	}
	return body;
}

const STOP: Record<string, 'end_turn' | 'tool_use' | 'max_tokens' | 'stop'> = {
	end_turn: 'end_turn', tool_use: 'tool_use', max_tokens: 'max_tokens', stop_sequence: 'stop', refusal: 'stop', pause_turn: 'end_turn',
};

export async function* parseAnthropicStream(events: AsyncIterable<SseEvent>): AsyncGenerator<StreamEvent> {
	const blocks = new Map<number, { id: string; name: string; json: string }>();
	let input = 0, output = 0, read = 0, write = 0;
	let stop: StreamEvent & { type: 'done' } = { type: 'done', stopReason: 'error' };
	for await (const ev of events) {
		let j: Rec;
		try { j = JSON.parse(ev.data); } catch { continue; }
		switch (j.type) {
			case 'message_start': {
				const u = j.message?.usage ?? {};
				input = u.input_tokens ?? 0; read = u.cache_read_input_tokens ?? 0; write = u.cache_creation_input_tokens ?? 0; output = u.output_tokens ?? 0;
				break;
			}
			case 'content_block_start': {
				const b = j.content_block ?? {};
				if (b.type === 'tool_use') {
					blocks.set(j.index, { id: b.id, name: b.name, json: '' });
					yield { type: 'tool_call_start', id: b.id, name: b.name };
				} else if (b.type === 'redacted_thinking') {
					yield { type: 'thinking_signature', signature: REDACTED + b.data };
				}
				break;
			}
			case 'content_block_delta': {
				const d = j.delta ?? {};
				if (d.type === 'text_delta') { yield { type: 'text', text: d.text }; }
				else if (d.type === 'thinking_delta') { yield { type: 'thinking', text: d.thinking }; }
				else if (d.type === 'signature_delta') { yield { type: 'thinking_signature', signature: d.signature }; }
				else if (d.type === 'input_json_delta') {
					const b = blocks.get(j.index);
					if (b && d.partial_json) { b.json += d.partial_json; yield { type: 'tool_call_delta', id: b.id, argsDelta: d.partial_json }; }
				}
				break;
			}
			case 'content_block_stop': {
				const b = blocks.get(j.index);
				if (b) { blocks.delete(j.index); yield { type: 'tool_call', id: b.id, name: b.name, input: parseArgs(b.json) }; }
				break;
			}
			case 'message_delta': {
				if (j.delta?.stop_reason) { stop = { type: 'done', stopReason: STOP[j.delta.stop_reason] ?? 'end_turn' }; }
				const u = j.usage ?? {};
				if (u.output_tokens !== undefined) { output = u.output_tokens; }
				if (u.input_tokens) { input = u.input_tokens; }
				if (u.cache_read_input_tokens) { read = u.cache_read_input_tokens; }
				if (u.cache_creation_input_tokens) { write = u.cache_creation_input_tokens; }
				break;
			}
			case 'error': {
				const msg = String(j.error?.message ?? 'stream error');
				const t = String(j.error?.type ?? '');
				const kind = /overloaded|rate_limit/.test(t) ? 'rate' : /authentication|permission/.test(t) ? 'auth' : errorKind(t === 'invalid_request_error' ? 400 : 500, msg);
				throw new ProviderError(msg, 'anthropic', undefined, kind);
			}
		}
	}
	yield { type: 'usage', inputTokens: input + read + write, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write };
	yield stop;
}

export class AnthropicProvider implements LLMProvider {
	readonly id = 'anthropic';
	readonly label = 'Anthropic';
	constructor(private readonly o: AnthropicOptions) { }

	private base(model?: string): string { return resolveBase(this.o.baseUrl ?? 'https://api.anthropic.com', model); }

	private async headers(): Promise<Record<string, string>> {
		const key = await this.o.getKey();
		if (!key) { throw missingKey('anthropic', this.label); }
		return { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': VERSION };
	}

	stream(req: ChatRequest): AsyncIterable<StreamEvent> {
		return guarded('anthropic', req.signal, this.run(req));
	}

	private async* run(req: ChatRequest): AsyncGenerator<StreamEvent> {
		const res = await request('anthropic', joinUrl(this.base(req.model.id), '/v1/messages'), {
			method: 'POST', headers: { ...await this.headers(), accept: 'text/event-stream' }, body: JSON.stringify(buildAnthropicBody(req)),
		}, req.signal);
		yield* parseAnthropicStream(sseFromBody(res));
	}

	async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
		const res = await request('anthropic', joinUrl(this.base(), '/v1/models?limit=1000'), { headers: await this.headers() }, signal, 0);
		const j = await res.json() as Rec;
		const known = new Map(ANTHROPIC_MODELS.map(m => [m.model, m]));
		return (j.data as Rec[] ?? []).filter(m => isChatModelId('anthropic', m.id)).map(m =>
			known.get(m.id) ?? guessModelInfo('anthropic', m.id, { label: m.display_name ?? m.id, supportsThinking: !/claude-3-haiku|claude-3-5/.test(m.id), ...(/claude-3-(haiku|opus|sonnet)/.test(m.id) ? { maxOutputTokens: 4096 } : /claude-3-5/.test(m.id) ? { maxOutputTokens: 8192 } : {}) }));
	}

	verify(signal?: AbortSignal) { return verifyByListing(s => this.listModels(s), signal); }
}
