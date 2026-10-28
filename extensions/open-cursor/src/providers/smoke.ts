/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Smoke test for one adapter under plain node (no vscode). Example:
 *    OC_SMOKE_PROVIDER=ollama OC_SMOKE_MODEL=qwen3:8b node smoke.js
 *  Env: OC_SMOKE_PROVIDER, OC_SMOKE_MODEL, OC_SMOKE_BASEURL, OC_SMOKE_KEY (else the provider's
 *  usual env var), OC_SMOKE_THINK=1, OC_SMOKE_FIM=1, OC_SMOKE_LIST=1.
 *--------------------------------------------------------------------------------------------*/

import { ENV_KEYS, guessModelInfo } from './catalog';
import { createAdapter } from './factory';
import type { LLMMessage, ModelInfo, ProviderId, StreamEvent } from './types';

const env = process.env;
const provider = (env.OC_SMOKE_PROVIDER ?? 'ollama') as ProviderId;
const modelName = env.OC_SMOKE_MODEL ?? 'qwen3:8b';

const adapter = createAdapter(provider, {
	getKey: () => env.OC_SMOKE_KEY ?? (ENV_KEYS[provider] ?? []).map(n => env[n]).find(Boolean),
	baseUrl: env.OC_SMOKE_BASEURL ? () => env.OC_SMOKE_BASEURL! : undefined,
});

const tools = [{
	name: 'get_weather',
	description: 'Get the current weather for a city.',
	parameters: { type: 'object', properties: { city: { type: 'string', description: 'City name' } }, required: ['city'] },
}];

async function turn(model: ModelInfo, messages: LLMMessage[]): Promise<{ text: string; calls: { id: string; name: string; input: unknown }[] }> {
	let text = '';
	const calls: { id: string; name: string; input: unknown }[] = [];
	const started = new Set<string>();
	const t0 = Date.now();
	const ac = new AbortController();
	for await (const ev of adapter.stream({ model, system: 'You are a concise assistant. Use tools when they help.', messages, tools, thinking: env.OC_SMOKE_THINK ? true : undefined, maxTokens: 1024, signal: ac.signal }) as AsyncIterable<StreamEvent>) {
		switch (ev.type) {
			case 'text': text += ev.text; process.stdout.write(ev.text); break;
			case 'thinking': process.stdout.write(`\x1b[2m${ev.text}\x1b[0m`); break;
			case 'thinking_signature': console.log(`\n[signature ${ev.signature.slice(0, 16)}...]`); break;
			case 'tool_call_start': started.add(ev.id); console.log(`\n[tool_call_start ${ev.name} ${ev.id}]`); break;
			case 'tool_call_delta': break;
			case 'tool_call':
				if (!started.has(ev.id)) { console.log('!! tool_call without start'); }
				calls.push({ id: ev.id, name: ev.name, input: ev.input });
				console.log(`[tool_call ${ev.name} ${JSON.stringify(ev.input)}]`);
				break;
			case 'usage': console.log(`\n[usage in=${ev.inputTokens} out=${ev.outputTokens} cacheRead=${ev.cacheReadTokens ?? 0}]`); break;
			case 'done': console.log(`\n[done ${ev.stopReason} in ${Date.now() - t0} ms]`); break;
		}
	}
	return { text, calls };
}

async function main(): Promise<void> {
	let model = guessModelInfo(provider, modelName);
	if (adapter.listModels && (env.OC_SMOKE_LIST || provider === 'ollama')) {
		const list = await adapter.listModels(AbortSignal.timeout(5000));
		console.log(`discovered ${list.length} models:`);
		for (const m of list) { console.log(`  ${m.id} ctx=${m.contextWindow} tools=${m.supportsTools} img=${m.supportsImages} think=${m.supportsThinking} fim=${!!m.supportsFim}`); }
		model = list.find(m => m.model === modelName) ?? model;
	}
	console.log(`\n== turn 1: ${model.id} (tools=${model.supportsTools})`);
	const messages: LLMMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'What is the weather in Stockholm right now? Use the get_weather tool.' }] }];
	const r1 = await turn(model, messages);
	if (r1.calls.length) {
		console.log('\n== turn 2 (tool result round trip)');
		messages.push({ role: 'assistant', content: [...(r1.text ? [{ type: 'text' as const, text: r1.text }] : []), ...r1.calls.map(c => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.input }))] });
		messages.push({ role: 'user', content: r1.calls.map(c => ({ type: 'tool_result' as const, toolUseId: c.id, content: '{"tempC": 7, "sky": "overcast"}' })) });
		await turn(model, messages);
	} else {
		console.log('\n(no tool call was made)');
	}
	if (env.OC_SMOKE_FIM && adapter.fim) {
		console.log('\n== FIM');
		let out = '';
		for await (const s of adapter.fim({ model: { ...model, supportsFim: true }, prefix: 'def add(a, b):\n    ', suffix: '\n\nprint(add(1, 2))\n', maxTokens: 32, temperature: 0, signal: new AbortController().signal })) { out += s; }
		console.log(JSON.stringify(out));
	}
	// abort check
	const ac = new AbortController();
	const it = adapter.stream({ model, system: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'Count from 1 to 500.' }] }], signal: ac.signal, maxTokens: 800 })[Symbol.asyncIterator]();
	let last: StreamEvent | undefined;
	let n = 0;
	for (; ;) {
		const { value, done } = await it.next();
		if (done) { break; }
		last = value;
		if (++n === 3) { ac.abort(); }
	}
	console.log(`\nabort check: last event = ${JSON.stringify(last)}`);
}

main().catch(e => { console.error('SMOKE FAILED:', e); process.exit(1); });
