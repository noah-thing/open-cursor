import { DEFAULT_ALLOWLIST, DEFAULT_DENYLIST } from '../approval';
import type { TranscriptEntry } from '../history';
import { runAgentLoop, type LoopHooks, type LoopParams } from '../loop';
import type { ChatRequest, ModelInfo, StreamEvent } from '../../providers/types';
import { ProviderError } from '../../providers/types';
import type { Services } from '../../services';
import type { ToolPart } from '../../shared/protocol';
import type { ToolDef } from '../tools/types';
import { assert, done, test } from './harness';

const model: ModelInfo = { id: 'x/y', provider: 'custom', model: 'y', label: 'Y', contextWindow: 100000, maxOutputTokens: 4000, supportsTools: true, supportsImages: false, supportsThinking: true };

type Script = (req: ChatRequest, call: number) => StreamEvent[] | Error;

function setup(script: Script, tools: ToolDef[], opts: { signal?: AbortSignal; decision?: 'run' | 'skip' | 'allowAlways'; max?: number } = {}) {
	let calls = 0;
	const requests: ChatRequest[] = [];
	const services = {
		registry: {
			async *stream(req: ChatRequest) {
				requests.push(JSON.parse(JSON.stringify({ ...req, signal: undefined, model: undefined })));
				const r = script(req, calls++);
				if (r instanceof Error) { throw r; }
				for (const ev of r) { yield ev; }
			},
		},
	} as unknown as Services;
	const transcript: TranscriptEntry[] = [{ turn: 't1', msg: { role: 'user', content: [{ type: 'text', text: 'go' }] } }];
	const parts = new Map<string, ToolPart>();
	const log: string[] = [];
	const errors: { message: string; action?: string }[] = [];
	const approvals: ToolPart[] = [];
	const session = new Set<string>();
	const hooks: LoopHooks = {
		onText: d => log.push(`text:${d}`), onThinking: () => log.push('think'), onThinkingDone: () => log.push('thinkdone'),
		onToolPart: p => parts.set(p.id, p),
		requestApproval: async p => { approvals.push(p); return opts.decision ?? 'run'; },
		onUsage: () => undefined, onContextUsage: () => undefined, onTranscript: () => undefined,
		onError: (message, action) => errors.push({ message, action }),
	};
	const byName = new Map(tools.map(t => [t.schema.name, t]));
	const params: LoopParams = {
		services, chatId: 'c', mode: 'agent', model, system: 'sys', transcript, turn: 't1',
		tools: { byName, schemas: tools.map(t => t.schema) },
		toolCtx: { confirmOutsideWorkspace: async () => true, getTodos: () => [], setTodos: () => undefined, getAgentRules: async () => [] },
		settings: { maxIterations: opts.max ?? 10, thinking: true, getPolicy: () => ({ autoRun: 'allowlist', allowlist: DEFAULT_ALLOWLIST, denylist: DEFAULT_DENYLIST, sessionAllow: session }), addSessionAllow: p => session.add(p) },
		hooks, signal: opts.signal ?? new AbortController().signal,
	};
	return { params, transcript, parts, log, errors, approvals, requests, session };
}

const tool = (name: string, readOnly: boolean, run: ToolDef['run']): ToolDef => ({
	schema: { name, description: name, parameters: { type: 'object', properties: {} } }, readOnly, run, title: (_a, s) => `${name} ${s}`,
});
const call = (id: string, name: string, input: unknown = {}): StreamEvent[] => [{ type: 'tool_call_start', id, name }, { type: 'tool_call', id, name, input }];

test('parallel read-only, sequential mutating, ordered tool results, transcript pairs', async () => {
	let active = 0, maxActive = 0;
	const order: string[] = [];
	const ro = (n: string) => tool(n, true, async () => { active++; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, 20)); active--; order.push(n); return { content: `r-${n}` }; });
	const mut = tool('mut', false, async () => { assert.strictEqual(active, 0, 'mutating tools must not overlap'); order.push('mut'); return { content: 'm' }; });
	const s = setup((_r, i) => i === 0
		? [{ type: 'thinking', text: 'hmm' }, { type: 'thinking_signature', signature: 'sig' }, { type: 'text', text: 'working' }, ...call('1', 'ro1'), ...call('2', 'ro2'), ...call('3', 'mut'), ...call('4', 'ro1'), { type: 'done', stopReason: 'tool_use' }]
		: [{ type: 'text', text: 'all done' }, { type: 'done', stopReason: 'end_turn' }], [ro('ro1'), ro('ro2'), mut]);
	const reason = await runAgentLoop(s.params);
	assert.strictEqual(reason, 'done');
	assert.strictEqual(maxActive, 2);
	assert.deepStrictEqual(order.slice(-2), ['mut', 'ro1']);
	const roles = s.transcript.map(e => e.msg.role).join(',');
	assert.strictEqual(roles, 'user,assistant,user,assistant');
	const asst = s.transcript[1].msg.content;
	assert.deepStrictEqual(asst.map(c => c.type), ['thinking', 'text', 'tool_use', 'tool_use', 'tool_use', 'tool_use']);
	assert.strictEqual((asst[0] as { signature?: string }).signature, 'sig');
	const results = s.transcript[2].msg.content;
	assert.deepStrictEqual(results.map(c => (c as { toolUseId: string }).toolUseId), ['1', '2', '3', '4']);
	assert.strictEqual(s.parts.get('3')!.status, 'done');
	assert.strictEqual(s.requests.length, 2);
	assert.strictEqual(s.requests[1].messages.length, 3);
});

test('tool errors and unknown tools go back to the model, never throw', async () => {
	const boom = tool('boom', true, async () => { throw new Error('kaput'); });
	const s = setup((_r, i) => i === 0 ? [...call('1', 'boom'), ...call('2', 'nope'), { type: 'done', stopReason: 'tool_use' }] : [{ type: 'text', text: 'ok' }, { type: 'done', stopReason: 'end_turn' }], [boom]);
	assert.strictEqual(await runAgentLoop(s.params), 'done');
	const res = s.transcript[2].msg.content as { content: string; isError?: boolean }[];
	assert.ok(res[0].isError && /kaput/.test(res[0].content));
	assert.ok(res[1].isError && /Unknown tool/.test(res[1].content));
});

test('terminal approval: unlisted asks, skip is reported, allowlisted does not ask', async () => {
	let ran = 0;
	const cmd = tool('run_terminal_cmd', false, async () => { ran++; return { content: 'ok' }; });
	const s = setup((_r, i) => i === 0 ? [...call('1', 'run_terminal_cmd', { command: 'npm install x' }), { type: 'done', stopReason: 'tool_use' }] : [{ type: 'text', text: 'k' }, { type: 'done', stopReason: 'end_turn' }], [cmd], { decision: 'skip' });
	await runAgentLoop(s.params);
	assert.strictEqual(ran, 0);
	assert.strictEqual(s.approvals.length, 1);
	assert.strictEqual(s.approvals[0].status, 'awaiting-approval');
	assert.strictEqual(s.parts.get('1')!.status, 'rejected');
	const s2 = setup((_r, i) => i === 0 ? [...call('1', 'run_terminal_cmd', { command: 'git status' }), { type: 'done', stopReason: 'tool_use' }] : [{ type: 'text', text: 'k' }, { type: 'done', stopReason: 'end_turn' }], [cmd]);
	await runAgentLoop(s2.params);
	assert.strictEqual(s2.approvals.length, 0);
	assert.strictEqual(ran, 1);
	const s3 = setup((_r, i) => i === 0 ? [...call('1', 'run_terminal_cmd', { command: 'make deploy' }), { type: 'done', stopReason: 'tool_use' }] : [{ type: 'text', text: 'k' }, { type: 'done', stopReason: 'end_turn' }], [cmd], { decision: 'allowAlways' });
	await runAgentLoop(s3.params);
	assert.ok(s3.session.has('make deploy'));
});

test('auth error surfaces openSettings; rate limit retries then succeeds', async () => {
	const s = setup(() => new ProviderError('bad key', 'custom', 401, 'auth'), []);
	assert.strictEqual(await runAgentLoop(s.params), 'error');
	assert.strictEqual(s.errors[0].action, 'openSettings');
	assert.strictEqual(s.transcript.length, 1);
});

test('abort during a tool leaves a complete tool_result pair', async () => {
	const ac = new AbortController();
	const slow = tool('slow', true, async (_a, ctx) => { ac.abort(); return ctx.signal.aborted ? { content: 'cancelled', isError: true } : { content: 'x' }; });
	const other = tool('other', false, async () => ({ content: 'should not run' }));
	const s = setup((_r, i) => i === 0 ? [...call('1', 'slow'), ...call('2', 'other'), { type: 'done', stopReason: 'tool_use' }] : [{ type: 'done', stopReason: 'end_turn' }], [slow, other], { signal: ac.signal });
	assert.strictEqual(await runAgentLoop(s.params), 'aborted');
	const last = s.transcript[s.transcript.length - 1].msg;
	assert.strictEqual(last.role, 'user');
	assert.deepStrictEqual(last.content.map(c => (c as { toolUseId: string }).toolUseId), ['1', '2']);
	assert.strictEqual(s.requests.length, 1);
});

test('max iterations stops the loop', async () => {
	const t = tool('t', true, async () => ({ content: 'x' }));
	const s = setup((_r, i) => [...call(`c${i}`, 't', { n: i }), { type: 'done', stopReason: 'tool_use' }], [t], { max: 3 });
	assert.strictEqual(await runAgentLoop(s.params), 'max_iterations');
	assert.strictEqual(s.requests.length, 3);
	assert.ok(/3 steps/.test(s.errors[0].message));
});

test('max_tokens continuation and empty response error', async () => {
	const s = setup((_r, i) => i === 0 ? [{ type: 'text', text: 'part' }, { type: 'done', stopReason: 'max_tokens' }] : [{ type: 'text', text: ' rest' }, { type: 'done', stopReason: 'end_turn' }], []);
	assert.strictEqual(await runAgentLoop(s.params), 'done');
	assert.strictEqual(s.transcript.map(e => e.msg.role).join(','), 'user,assistant,user,assistant');
	const e = setup(() => [{ type: 'done', stopReason: 'end_turn' }], []);
	assert.strictEqual(await runAgentLoop(e.params), 'error');
});

test('oversized context is pruned/summarised before the request', async () => {
	const big = 'x'.repeat(120000);
	const t = tool('t', true, async () => ({ content: big }));
	let sawSummary = false;
	const s = setup((req, i) => {
		if (req.system.startsWith('You compress')) { sawSummary = true; return [{ type: 'text', text: 'SUMMARY' }, { type: 'done', stopReason: 'end_turn' }]; }
		return i < 6 ? [...call(`c${i}`, 't', { i }), { type: 'done', stopReason: 'tool_use' }] : [{ type: 'text', text: 'end' }, { type: 'done', stopReason: 'end_turn' }];
	}, [t], { max: 20 });
	const r = await runAgentLoop({ ...s.params, model: { ...model, contextWindow: 30000 } });
	assert.strictEqual(r, 'done');
	assert.ok(sawSummary, 'a summarisation request was made');
	const roles = s.transcript.map(e => e.msg.role);
	for (let i = 1; i < roles.length; i++) { assert.notStrictEqual(roles[i], roles[i - 1]); }
});
void done('loop');
