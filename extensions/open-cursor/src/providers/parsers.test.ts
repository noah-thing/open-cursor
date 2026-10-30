/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Parser and converter tests with hand written payloads. Plain node, no vscode, no network.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { buildAnthropicBody, parseAnthropicStream } from './anthropic';
import { errorKind, linesOf, messageOf, normalizeBase, parseSse, type SseEvent } from './http';
import { remapToolIds } from './toolIds';
import { FREE_CHAIN, FREE_MODELS } from './free';
import { buildGeminiBody, parseGeminiStream, sanitizeSchema } from './google';
import { OpenAICompatibleProvider, ThinkSplitter, buildOpenAIBody, parseOpenAIStream } from './openai';
import { buildOllamaBody, parseOllamaStream } from './ollama';
import { ANTHROPIC_MODELS, isChatModelId } from './catalog';
import { ProviderError, type ChatRequest, type StreamEvent } from './types';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> { const o: T[] = []; for await (const x of it) { o.push(x); } return o; }
const sse = (s: string): AsyncGenerator<SseEvent> => parseSse(linesOf(s));
const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const types = (e: StreamEvent[]) => e.map(x => x.type).join(',');

const model = ANTHROPIC_MODELS[1];
const baseReq = (over: Partial<ChatRequest> = {}): ChatRequest => ({ model, system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], signal: new AbortController().signal, ...over });

const tests: [string, () => Promise<void>][] = [];
const test = (n: string, f: () => Promise<void>) => tests.push([n, f]);

test('sse: multi-line data, comments, CRLF, trailing event without blank line', async () => {
	const e = await collect(parseSse(linesOf('event: a\r\ndata: x\r\ndata: y\r\n\r\n: ping\n\ndata: z')));
	assert.deepEqual(e, [{ event: 'a', data: 'x\ny' }, { event: undefined, data: 'z' }]);
});

test('anthropic: thinking + signature + text + tool call + usage', async () => {
	const body = [
		ev({ type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 1 } } }),
		ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
		ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }),
		ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } }),
		ev({ type: 'content_block_stop', index: 0 }),
		ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
		ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } }),
		ev({ type: 'content_block_stop', index: 1 }),
		ev({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } }),
		ev({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":' } }),
		ev({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"Oslo"}' } }),
		ev({ type: 'content_block_stop', index: 2 }),
		ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } }),
		ev({ type: 'message_stop' }),
	].join('');
	const e = await collect(parseAnthropicStream(sse(body)));
	assert.equal(types(e), 'thinking,thinking_signature,text,tool_call_start,tool_call_delta,tool_call_delta,tool_call,usage,done');
	assert.deepEqual(e[6], { type: 'tool_call', id: 'toolu_1', name: 'get_weather', input: { city: 'Oslo' } });
	assert.deepEqual(e[7], { type: 'usage', inputTokens: 105, outputTokens: 42, cacheReadTokens: 90, cacheWriteTokens: 5 });
	assert.deepEqual(e[8], { type: 'done', stopReason: 'tool_use' });
});

test('anthropic: error event maps to ProviderError', async () => {
	await assert.rejects(collect(parseAnthropicStream(sse(ev({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })))), (e: ProviderError) => e.kind === 'rate');
});

test('anthropic: request body caching, thinking round trip, tool_result ordering', async () => {
	const b = buildAnthropicBody(baseReq({
		thinking: true,
		tools: [{ name: 'a', description: 'a', parameters: { type: 'object' } }, { name: 'b', description: 'b', parameters: { type: 'object' } }],
		messages: [
			{ role: 'user', content: [{ type: 'text', text: 'go' }] },
			{ role: 'assistant', content: [{ type: 'thinking', text: 'plan', signature: 'S1' }, { type: 'tool_use', id: 't1', name: 'a', input: { x: 1 } }] },
			{ role: 'user', content: [{ type: 'text', text: 'also' }, { type: 'tool_result', toolUseId: 't1', content: 'ok' }] },
		],
	}));
	assert.equal(b.max_tokens, model.maxOutputTokens);
	assert.deepEqual(b.system[0].cache_control, { type: 'ephemeral' });
	assert.equal(b.tools[0].cache_control, undefined);
	assert.deepEqual(b.tools[1].cache_control, { type: 'ephemeral' });
	assert.equal(b.thinking.type, 'enabled');
	assert.deepEqual(b.messages[1].content[0], { type: 'thinking', thinking: 'plan', signature: 'S1' });
	assert.equal(b.messages[2].content[0].type, 'tool_result');
	assert.deepEqual(b.messages[2].content[1].cache_control, { type: 'ephemeral' });
	assert.deepEqual(b.messages[0].content[0].cache_control, { type: 'ephemeral' });
});

test('anthropic: thinking is skipped when a tool turn has no signed thinking block', async () => {
	const b = buildAnthropicBody(baseReq({
		thinking: true, temperature: 0.3,
		messages: [
			{ role: 'user', content: [{ type: 'text', text: 'go' }] },
			{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'a', input: {} }] },
			{ role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }] },
		],
	}));
	assert.equal(b.thinking, undefined);
	assert.equal(b.temperature, 0.3);
});

test('openai: text, interleaved tool call deltas by index, usage chunk, done', async () => {
	const body = [
		ev({ choices: [{ delta: { role: 'assistant', content: '' } }] }),
		ev({ choices: [{ delta: { content: 'Let me ' } }] }),
		ev({ choices: [{ delta: { content: 'check.' } }] }),
		ev({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] }),
		ev({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'get_time', arguments: '' } }] } }] }),
		ev({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] } }] }),
		ev({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"tz":"CET"}' } }] } }] }),
		ev({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"Rome"}' } }] } }] }),
		ev({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
		ev({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 64 } } }),
		'data: [DONE]\n\n',
	].join('');
	const e = await collect(parseOpenAIStream(sse(body), { provider: 'openai' }));
	const calls = e.filter(x => x.type === 'tool_call');
	assert.deepEqual(calls, [
		{ type: 'tool_call', id: 'call_a', name: 'get_weather', input: { city: 'Rome' } },
		{ type: 'tool_call', id: 'call_b', name: 'get_time', input: { tz: 'CET' } },
	]);
	assert.equal(e.filter(x => x.type === 'text').map(x => (x as { text: string }).text).join(''), 'Let me check.');
	assert.deepEqual(e.at(-2), { type: 'usage', inputTokens: 100, outputTokens: 20, cacheReadTokens: 64 });
	assert.deepEqual(e.at(-1), { type: 'done', stopReason: 'tool_use' });
	const startIdx = e.findIndex(x => x.type === 'tool_call_start');
	assert.ok(startIdx < e.findIndex(x => x.type === 'tool_call_delta'));
});

test('openai: reasoning_content as thinking, openrouter reasoning field, length stop', async () => {
	const body = [
		ev({ choices: [{ delta: { reasoning_content: 'think ' } }] }),
		ev({ choices: [{ delta: { reasoning: 'more' } }] }),
		ev({ choices: [{ delta: { content: 'A' }, finish_reason: 'length' }] }),
	].join('');
	const e = await collect(parseOpenAIStream(sse(body), { provider: 'deepseek' }));
	assert.equal(types(e), 'thinking,thinking,text,done');
	assert.deepEqual(e.at(-1), { type: 'done', stopReason: 'max_tokens' });
});

test('openai: tool call whose name arrives without id gets a generated id', async () => {
	const body = [
		ev({ choices: [{ delta: { tool_calls: [{ function: { name: 'f', arguments: '{"a":1}' } }] } }] }),
		ev({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
	].join('');
	const e = await collect(parseOpenAIStream(sse(body), { provider: 'custom' }));
	const c = e.find(x => x.type === 'tool_call') as Extract<StreamEvent, { type: 'tool_call' }>;
	assert.equal(c.name, 'f'); assert.deepEqual(c.input, { a: 1 }); assert.ok(c.id.startsWith('call_'));
	assert.deepEqual(e.at(-1), { type: 'done', stopReason: 'tool_use' });
});

test('think tags split across chunks', async () => {
	const s = new ThinkSplitter();
	const out = [...s.push('<thi'), ...s.push('nk>reason'), ...s.push('ing</th'), ...s.push('ink>\nAnswer'), ...s.flush()];
	assert.deepEqual(out, [{ type: 'thinking', text: 'reason' }, { type: 'thinking', text: 'ing' }, { type: 'text', text: 'Answer' }]);
	const plain = new ThinkSplitter();
	assert.deepEqual([...plain.push('Use <think> tags'), ...plain.flush()], [{ type: 'text', text: 'Use <think> tags' }]);
});

test('openai: request body (reasoning model, tools, images, tool results)', async () => {
	const m = { ...model, id: 'openai/o4', provider: 'openai' as const, model: 'o4', supportsThinking: true };
	const b = buildOpenAIBody(baseReq({
		model: m, thinking: true, temperature: 0.5, tools: [{ name: 'f', description: 'd', parameters: { type: 'object' } }],
		messages: [
			{ role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image', mediaType: 'image/png', data: 'AAA' }] },
			{ role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'c1', name: 'f', input: { q: 1 } }] },
			{ role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'res' }] },
		],
	}), { id: 'openai', baseUrl: '', getKey: () => 'k', maxTokensField: 'max_completion_tokens', reasoning: 'openai', reasoningSystemRole: 'developer' });
	assert.equal(b.reasoning_effort, 'high'); assert.equal(b.temperature, undefined);
	assert.equal(b.max_completion_tokens, model.maxOutputTokens); assert.equal(b.max_tokens, undefined);
	assert.equal(b.messages[0].role, 'developer');
	assert.equal(b.messages[1].content[1].image_url.url, 'data:image/png;base64,AAA');
	assert.equal(b.messages[2].tool_calls[0].function.arguments, '{"q":1}');
	assert.deepEqual(b.messages[3], { role: 'tool', tool_call_id: 'c1', content: 'res' });
	assert.deepEqual(b.stream_options, { include_usage: true });
});

test('openai-compatible: FIM streams text and delta formats; missing key is an auth error', async () => {
	const realFetch = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = (async (url: string) => {
		calls.push(String(url));
		if (String(url).includes('codestral')) { return new Response('nope', { status: 401 }); }
		const body = ev({ choices: [{ delta: { content: 'a + ' } }] }) + ev({ choices: [{ delta: { content: 'b' }, finish_reason: 'stop' }] });
		return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
	}) as typeof fetch;
	try {
		const p = new OpenAICompatibleProvider({ id: 'mistral', baseUrl: 'https://api.mistral.ai/v1', getKey: () => 'k', fimUrls: () => ['https://codestral.mistral.ai/v1/fim/completions', 'https://api.mistral.ai/v1/fim/completions'] });
		const out = (await collect(p.fim!({ model, prefix: 'return ', suffix: '', maxTokens: 8, signal: new AbortController().signal }))).join('');
		assert.equal(out, 'a + b'); assert.equal(calls.length, 2);
		const q = new OpenAICompatibleProvider({ id: 'xai', baseUrl: 'https://x', getKey: () => undefined });
		await assert.rejects(collect(q.stream(baseReq())), (e: ProviderError) => e.kind === 'auth');
	} finally { globalThis.fetch = realFetch; }
});

test('retry: 429 with retry-after retries twice then succeeds; abort ends cleanly', async () => {
	const realFetch = globalThis.fetch;
	let n = 0;
	globalThis.fetch = (async (_u: string, init: RequestInit) => {
		n++;
		if (n <= 2) { return new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { 'retry-after': '0' } }); }
		const body = ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
		void init;
		return new Response(body, { status: 200 });
	}) as typeof fetch;
	try {
		const { AnthropicProvider } = await import('./anthropic');
		const p = new AnthropicProvider({ getKey: () => 'k' });
		const e = await collect(p.stream(baseReq()));
		assert.equal(n, 3); assert.deepEqual(e.at(-1), { type: 'done', stopReason: 'end_turn' });
		n = -100; // always 429
		globalThis.fetch = (async () => { n++; return new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { 'retry-after': '0' } }); }) as typeof fetch;
		n = 0;
		await assert.rejects(collect(p.stream(baseReq())), (x: ProviderError) => x.kind === 'rate');
		assert.equal(n, 3);
		const ac = new AbortController(); ac.abort();
		globalThis.fetch = (async (_u: string, i: RequestInit) => { if (i.signal?.aborted) { throw new DOMException('Aborted', 'AbortError'); } return new Response(''); }) as typeof fetch;
		assert.deepEqual(await collect(p.stream(baseReq({ signal: ac.signal }))), [{ type: 'done', stopReason: 'aborted' }]);
	} finally { globalThis.fetch = realFetch; }
});

test('error kinds', async () => {
	assert.equal(errorKind(401, 'x'), 'auth');
	assert.equal(errorKind(400, 'API key not valid. Please pass a valid API key.'), 'auth');
	assert.equal(errorKind(400, 'prompt is too long: 250000 tokens > 200000 maximum'), 'context');
	assert.equal(errorKind(400, "This model's maximum context length is 128000 tokens"), 'context');
	assert.equal(errorKind(400, 'The input token count (1200000) exceeds the maximum number of tokens allowed'), 'context');
	assert.equal(errorKind(429, 'x'), 'rate');
	assert.equal(errorKind(500, 'x'), 'other');
});

test('gemini: function declarations, schema sanitising, signatures, tool results', async () => {
	const schema = sanitizeSchema({ type: 'object', additionalProperties: false, $schema: 'x', properties: { a: { type: ['string', 'null'], default: 'q' }, n: { type: 'integer', enum: [1, 2] }, o: { type: 'object', properties: {} } }, required: ['a'] }) as Record<string, any>;
	assert.deepEqual(schema, { type: 'object', properties: { a: { type: 'string', nullable: true }, n: { type: 'string', enum: ['1', '2'] }, o: { type: 'object' } }, required: ['a'] });
	const gm = { ...model, id: 'google/gemini-3-pro', provider: 'google' as const, model: 'gemini-3-pro', supportsThinking: true };
	const b = buildGeminiBody(baseReq({
		model: gm, thinking: true,
		tools: [{ name: 'f', description: 'd', parameters: { type: 'object', properties: { x: { type: 'string' } } } }, { name: 'g', description: 'no args', parameters: { type: 'object', properties: {} } }],
		messages: [
			{ role: 'user', content: [{ type: 'text', text: 'go' }, { type: 'image', mediaType: 'image/png', data: 'AA' }] },
			{ role: 'assistant', content: [{ type: 'thinking', text: '', signature: 'gsig:XYZ' }, { type: 'tool_use', id: 'c1', name: 'f', input: { x: 'y' } }, { type: 'tool_use', id: 'c2', name: 'g', input: {} }] },
			{ role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'r1' }, { type: 'tool_result', toolUseId: 'c2', content: 'bad', isError: true }] },
		],
	}));
	assert.equal(b.generationConfig.thinkingConfig.includeThoughts, true);
	assert.equal(b.tools[0].functionDeclarations[1].parameters, undefined);
	assert.equal(b.contents[0].parts[1].inlineData.data, 'AA');
	assert.equal(b.contents[1].role, 'model');
	assert.equal(b.contents[1].parts[0].thoughtSignature, 'XYZ');
	assert.equal(b.contents[1].parts[1].thoughtSignature, undefined);
	assert.deepEqual(b.contents[2].parts[0], { functionResponse: { name: 'f', response: { output: 'r1' } } });
	assert.deepEqual(b.contents[2].parts[1], { functionResponse: { name: 'g', response: { error: 'bad' } } });
});

test('gemini: stream with thought, text, function call, usage', async () => {
	const body = [
		ev({ candidates: [{ content: { role: 'model', parts: [{ text: 'pondering', thought: true }] } }] }),
		ev({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hi ' }] } }] }),
		ev({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'X' } }, thoughtSignature: 'SS' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, thoughtsTokenCount: 5 } }),
	].join('');
	const e = await collect(parseGeminiStream(sse(body)));
	assert.equal(types(e), 'thinking,text,thinking_signature,tool_call_start,tool_call_delta,tool_call,usage,done');
	assert.deepEqual(e[6], { type: 'usage', inputTokens: 50, outputTokens: 15 });
	assert.deepEqual(e[7], { type: 'done', stopReason: 'tool_use' });
	assert.deepEqual(e[2], { type: 'thinking_signature', signature: 'gsig:SS' });
});

test('ollama: ndjson with thinking, content, tool call, usage; request body', async () => {
	const lines = [
		{ message: { role: 'assistant', content: '', thinking: 'hm' }, done: false },
		{ message: { role: 'assistant', content: 'Hel' }, done: false },
		{ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Lund' } } }] }, done: false },
		{ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 30, eval_count: 7 },
	].map(o => JSON.stringify(o));
	const e = await collect(parseOllamaStream((async function* () { yield* lines; })()));
	assert.equal(types(e), 'thinking,text,tool_call_start,tool_call_delta,tool_call,usage,done');
	assert.deepEqual(e[5], { type: 'usage', inputTokens: 30, outputTokens: 7 });
	assert.deepEqual(e[6], { type: 'done', stopReason: 'tool_use' });
	const om = { ...model, id: 'ollama/qwen3:8b', provider: 'ollama' as const, model: 'qwen3:8b', contextWindow: 40960, maxOutputTokens: 8192, supportsThinking: true };
	const b = buildOllamaBody(baseReq({
		model: om, thinking: false, tools: [{ name: 'f', description: 'd', parameters: { type: 'object' } }],
		messages: [
			{ role: 'user', content: [{ type: 'text', text: 'go' }, { type: 'image', mediaType: 'image/png', data: 'AA' }] },
			{ role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'f', input: { a: 1 } }] },
			{ role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'r' }] },
		],
	}), 16384);
	assert.equal(b.think, false); assert.equal(b.options.num_ctx, 16384);
	assert.deepEqual(b.messages[1].images, ['AA']);
	assert.deepEqual(b.messages[2].tool_calls[0].function, { name: 'f', arguments: { a: 1 } });
	assert.deepEqual(b.messages[3], { role: 'tool', tool_name: 'f', content: 'r' });
});

test('catalog: chat filter keeps instruct models and drops batch, pro and search ids', async () => {
	for (const [p, id] of [['custom', 'meta-llama/Llama-3.3-70B-Instruct'], ['custom', 'Qwen2.5-Coder-32B-Instruct'], ['openrouter', 'deepseek/deepseek-research-1'], ['openai', 'gpt-5'], ['openai', 'o3']] as const) {
		assert.ok(isChatModelId(p, id), id);
	}
	for (const [p, id] of [['openrouter', 'anthropic/claude-sonnet-5-5:batch'], ['openai', 'gpt-3.5-turbo-instruct'], ['openai', 'o1-pro'], ['openai', 'o3-pro-2025-06-10'], ['openai', 'gpt-5-pro'], ['openai', 'gpt-5.2-pro'], ['openai', 'gpt-4o-search-preview']] as const) {
		assert.ok(!isChatModelId(p, id), id);
	}
});

test('openrouter: thinking off sends no reasoning field', async () => {
	const m = { ...model, supportsThinking: true };
	const o = { id: 'openrouter' as const, baseUrl: '', getKey: () => 'k', reasoning: 'openrouter' as const };
	assert.equal('reasoning' in buildOpenAIBody(baseReq({ model: m, thinking: false }), o), false);
	assert.ok('reasoning' in buildOpenAIBody(baseReq({ model: m, thinking: true }), o));
});

test('http: error text carries OpenRouter detail, hides HTML, and 403 is auth only when it says so', async () => {
	assert.equal(messageOf(JSON.stringify({ error: { message: 'Provider returned error', metadata: { raw: 'upstream overloaded', provider_name: 'Chutes' } } })), 'Provider returned error (Chutes: upstream overloaded)');
	assert.ok(!messageOf('<html><body>502 Bad Gateway</body></html>', 502).includes('<'));
	assert.ok(messageOf('<!DOCTYPE html><html>', 504).startsWith('Gateway timeout'));
	assert.equal(errorKind(403, 'Invalid API key'), 'auth');
	assert.equal(errorKind(403, 'Country, region, or territory not supported'), 'other');
	assert.equal(errorKind(403, 'Insufficient credits'), 'other');
	assert.equal(errorKind(401, 'x'), 'auth');
	assert.equal(errorKind(400, 'the request exceeds the available context size (n_ctx = 4096)'), 'context');
});

test('http: base addresses are normalized', async () => {
	assert.equal(normalizeBase('localhost:1234', { v1: true }), 'http://localhost:1234/v1');
	assert.equal(normalizeBase('localhost:1234/v1/', { v1: true }), 'http://localhost:1234/v1');
	assert.equal(normalizeBase('http://192.168.1.5:8000', { v1: true }), 'http://192.168.1.5:8000/v1');
	assert.equal(normalizeBase('api.example.com/openai', { v1: true }), 'https://api.example.com/openai');
	assert.equal(normalizeBase('localhost:11434/v1', { stripV1: true }), 'http://localhost:11434');
	assert.equal(normalizeBase('http://localhost:11434/', { stripV1: true }), 'http://localhost:11434');
});

test('http: SSE comment lines count as activity', async () => {
	let n = 0;
	await collect(parseSse(linesOf(': queued\n\n: queued\n\ndata: x\n\n'), () => { n++; }));
	assert.equal(n, 2);
});

test('openai: a stream that just stops is an error, a finished one is not', async () => {
	await assert.rejects(collect(parseOpenAIStream(sse(ev({ choices: [{ delta: { content: 'hi' } }] })), { provider: 'custom' })), /closed before the reply finished/);
	const ok = await collect(parseOpenAIStream(sse(ev({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] })), { provider: 'custom' }));
	assert.equal(ok[ok.length - 1].type, 'done');
});

test('tool call ids are mapped per provider, consistently', async () => {
	const msgs = [
		{ role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'call_abc.123|x', name: 'f', input: {} }, { type: 'tool_use' as const, id: 'call_abc.123_x', name: 'g', input: {} }] },
		{ role: 'user' as const, content: [{ type: 'tool_result' as const, toolUseId: 'call_abc.123|x', content: 'r' }] },
	];
	const m = remapToolIds(msgs, 'mistral');
	const use = (m[0].content[0] as { id: string }).id;
	assert.match(use, /^[a-zA-Z0-9]{9}$/);
	assert.equal((m[1].content[0] as { toolUseId: string }).toolUseId, use);
	assert.notEqual((m[0].content[1] as { id: string }).id, use);
	const a = remapToolIds(msgs, 'anthropic');
	assert.match((a[0].content[0] as { id: string }).id, /^[a-zA-Z0-9_-]+$/);
	assert.equal((a[1].content[0] as { toolUseId: string }).toolUseId, (a[0].content[0] as { id: string }).id);
	assert.notEqual((a[0].content[1] as { id: string }).id, (a[0].content[0] as { id: string }).id);
	assert.equal(remapToolIds([{ role: 'user', content: [{ type: 'tool_result', toolUseId: 'toolu_01', content: '' }] }], 'anthropic')[0].content[0].type, 'tool_result');
});

test('google: blocked prompts and unsafe stops are errors; odd formats are dropped from schemas', async () => {
	await assert.rejects(collect(parseGeminiStream(sse(ev({ promptFeedback: { blockReason: 'SAFETY' } })))), /refused/);
	await assert.rejects(collect(parseGeminiStream(sse(ev({ candidates: [{ finishReason: 'SAFETY' }] })))), /stopped the reply/);
	await assert.rejects(collect(parseGeminiStream(sse(ev({ candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] })))), /broken tool call/);
	const s = sanitizeSchema({ type: 'object', properties: { u: { type: 'string', format: 'uri' }, d: { type: 'string', format: 'date-time' } } }) as { properties: Record<string, { format?: string }> };
	assert.equal(s.properties.u.format, undefined); assert.equal(s.properties.d.format, 'date-time');
});

test('free chain lists all free models once', async () => {
	assert.equal(FREE_CHAIN.length, FREE_MODELS.length);
	assert.equal(new Set(FREE_CHAIN.map(m => m.provider + '/' + m.model)).size, FREE_MODELS.length);
});

(async () => {
	let failed = 0;
	for (const [name, fn] of tests) {
		try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n' + (e as Error).stack); }
	}
	console.log(`${tests.length - failed}/${tests.length} passed`);
	process.exit(failed ? 1 : 0);
})();
