/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Per provider thinking parameters. Plain node, no vscode, no network.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { buildAnthropicBody } from './anthropic';
import { guessModelInfo, isReasoningName } from './catalog';
import { buildOpenAIBody, createOpenAICompatible } from './openai';
import { hasThinkingControl, thinkingParams, thinkingRejected, thinkingUnverified } from './thinking';
import type { ApiEffort } from '../agent/effort';
import type { ChatRequest, ProviderId } from './types';

let failed = 0;
function test(name: string, fn: () => void): void {
	try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n' + (e as Error).stack); }
}

const DS = 'deepseek-flash';
test('DeepSeek API: Off disables, levels map to low/high/max, medium is high, Auto is low', () => {
	assert.deepEqual(thinkingParams('deepseek', DS, false, undefined), { thinking: { type: 'disabled' } });
	assert.deepEqual(thinkingParams('deepseek', DS, true, 'low'), { thinking: { type: 'enabled' }, reasoning_effort: 'low' });
	assert.deepEqual(thinkingParams('deepseek', DS, true, 'medium'), { thinking: { type: 'enabled' }, reasoning_effort: 'high' });
	assert.deepEqual(thinkingParams('deepseek', DS, true, 'high'), { thinking: { type: 'enabled' }, reasoning_effort: 'high' });
	assert.deepEqual(thinkingParams('deepseek', 'deepseek-v4-pro', true, 'max'), { thinking: { type: 'enabled' }, reasoning_effort: 'max' });
	assert.deepEqual(thinkingParams('deepseek', DS, true, 'auto'), { thinking: { type: 'enabled' }, reasoning_effort: 'low' });
});

test('NVIDIA DeepSeek V4: top level reasoning_effort none/high/max, Auto leaves the default', () => {
	const m = 'deepseek-ai/deepseek-v4-flash';
	assert.deepEqual(thinkingParams('nvidia', m, false, undefined), { reasoning_effort: 'none' });
	assert.deepEqual(thinkingParams('nvidia', m, true, 'low'), { reasoning_effort: 'high' });
	assert.deepEqual(thinkingParams('nvidia', m, true, 'max'), { reasoning_effort: 'max' });
	assert.deepEqual(thinkingParams('nvidia', m, true, 'auto'), {});
});

test('NVIDIA DeepSeek V4.1 Flash: undocumented, so tried with V4 fields and Auto sends nothing', () => {
	assert.equal(thinkingUnverified('nvidia', 'deepseek-ai/deepseek-v4.1-flash'), true);
	assert.equal(thinkingUnverified('nvidia', 'deepseek-ai/deepseek-v4-flash'), false);
	assert.equal(isReasoningName('nvidia', 'deepseek-ai/deepseek-v4.1-flash'), true);
});

test('NVIDIA Kimi K2.6 and Nemotron 3 Super use chat_template_kwargs', () => {
	const k = 'moonshotai/kimi-k2.6';
	assert.deepEqual(thinkingParams('nvidia', k, false, undefined), { chat_template_kwargs: { thinking: false } });
	assert.deepEqual(thinkingParams('nvidia', k, true, 'high'), { chat_template_kwargs: { thinking: true } });
	assert.deepEqual(thinkingParams('nvidia', k, true, 'auto'), {});
	const n = 'nvidia/nemotron-3-super-120b-a12b';
	assert.deepEqual(thinkingParams('nvidia', n, false, undefined), { chat_template_kwargs: { enable_thinking: false } });
	assert.deepEqual(thinkingParams('nvidia', n, true, 'low'), { chat_template_kwargs: { enable_thinking: true, low_effort: true } });
	assert.deepEqual(thinkingParams('nvidia', n, true, 'max'), { chat_template_kwargs: { enable_thinking: true } });
	assert.deepEqual(thinkingParams('nvidia', n, true, 'auto'), {});
});

test('Z.ai: thinking type for GLM 4.7 and 5 to 5.2, never for 5.3 (forced) or 4.5 (undocumented)', () => {
	assert.deepEqual(thinkingParams('zai', 'glm-4.7-flash', false, undefined), { thinking: { type: 'disabled' } });
	assert.deepEqual(thinkingParams('zai', 'glm-4.7', true, 'high'), { thinking: { type: 'enabled' } });
	assert.deepEqual(thinkingParams('zai', 'glm-5.1', true, 'auto'), {});
	assert.equal(hasThinkingControl('zai', 'glm-5.3-flash'), false);
	assert.equal(hasThinkingControl('zai', 'glm-5.3'), false);
	assert.equal(hasThinkingControl('zai', 'glm-4.5-flash'), false);
});

test('Groq: gpt-oss has no Off, Qwen 3.8 has none', () => {
	assert.deepEqual(thinkingParams('groq', 'openai/gpt-oss-120b', false, undefined), { reasoning_effort: 'low' });
	assert.deepEqual(thinkingParams('groq', 'openai/gpt-oss-120b', true, 'max'), { reasoning_effort: 'high' });
	assert.deepEqual(thinkingParams('groq', 'openai/gpt-oss-120b', true, 'auto'), { reasoning_effort: 'medium' });
	assert.deepEqual(thinkingParams('groq', 'qwen/qwen3.8-27b', false, undefined), { reasoning_effort: 'none' });
	assert.deepEqual(thinkingParams('groq', 'qwen/qwen3.8-27b', true, 'medium'), { reasoning_effort: 'medium' });
	assert.deepEqual(thinkingParams('groq', 'qwen/qwen3.8-27b', true, 'auto'), {});
	assert.equal(hasThinkingControl('groq', 'llama-3.3-70b-versatile'), false);
});

test('unconfirmed providers and a caller that never asked send nothing', () => {
	for (const p of ['sambanova', 'openrouter', 'xai', 'custom', 'lmstudio'] as ProviderId[]) { assert.deepEqual(thinkingParams(p, 'deepseek-flash', true, 'high'), {}); }
	assert.deepEqual(thinkingParams('deepseek', DS, undefined, 'auto'), {});
});

test('the effort picker shows for the models above', () => {
	assert.equal(guessModelInfo('deepseek', 'deepseek-flash').supportsThinking, true);
	assert.equal(guessModelInfo('nvidia', 'moonshotai/kimi-k2.6').supportsThinking, true);
	assert.equal(guessModelInfo('zai', 'glm-4.7-flash').supportsThinking, true);
	assert.equal(guessModelInfo('zai', 'glm-4.5-flash').supportsThinking, false);
});

test('request bodies carry the fields', () => {
	const req = (provider: ProviderId, id: string, thinking: boolean | undefined, effort?: ApiEffort): ChatRequest => ({
		model: guessModelInfo(provider, id), system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], thinking, effort, signal: new AbortController().signal,
	});
	const opts = (id: ProviderId) => (createOpenAICompatible(id as 'deepseek', { getKey: () => 'k' }) as unknown as { o: Parameters<typeof buildOpenAIBody>[1] }).o;
	const ds = buildOpenAIBody(req('deepseek', DS, true, 'auto'), opts('deepseek'));
	assert.equal(ds.reasoning_effort, 'low'); assert.deepEqual(ds.thinking, { type: 'enabled' });
	const z = buildOpenAIBody(req('zai', 'glm-4.7-flash', false), opts('zai'));
	assert.deepEqual(z.thinking, { type: 'disabled' });
	const free = buildOpenAIBody(req('zai', 'glm-4.7-flash', undefined, 'auto'), opts('zai'));
	assert.equal(free.thinking, undefined);
	const other = buildOpenAIBody(req('zai', 'glm-4.5-flash', false), opts('zai'));
	assert.equal(other.thinking, undefined);
});

test('Anthropic: Auto thinks at a moderate budget and keeps the cache breakpoints', () => {
	const m = guessModelInfo('anthropic', 'claude-sonnet-5-5', { supportsThinking: true });
	const b = buildAnthropicBody({
		model: m, system: 's', thinking: true, effort: 'auto', maxTokens: 32_000, signal: new AbortController().signal,
		tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
		messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }],
	});
	assert.equal(b.thinking.budget_tokens, 8_000);
	assert.ok(b.system[0].cache_control && b.tools[0].cache_control && b.messages[0].content[0].cache_control);
});

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

{
	// DeepSeek V4.1 on NVIDIA: V4's field only when a level is picked, and gone for the session once refused
	const tp = thinkingParams, has = hasThinkingControl, rej = thinkingRejected, unv = thinkingUnverified;
	const m = 'deepseek-ai/deepseek-v4.1-flash';
	assert.ok(unv('nvidia', m) && has('nvidia', m));
	assert.deepStrictEqual(tp('nvidia', m, true, 'auto' as never), {});
	assert.deepStrictEqual(tp('nvidia', m, false, undefined), { reasoning_effort: 'none' });
	assert.deepStrictEqual(tp('nvidia', m, undefined, undefined), {});
	rej('nvidia', m);
	assert.ok(!has('nvidia', m));
	assert.deepStrictEqual(tp('nvidia', m, false, undefined), {});
}
