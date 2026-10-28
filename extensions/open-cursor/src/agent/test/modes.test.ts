import './vscodeStub';
import { DEFAULT_ALLOWLIST, DEFAULT_DENYLIST } from '../approval';
import type { TranscriptEntry } from '../history';
import { cleanupReminder, DEBUG_MARKER, findMarkerLines, isReadOnlyCommand, isReadOnlyMode, toolBlockedReason, turnEndReminders } from '../modes';
import { runAgentLoop, MAX_CLEANUP_REMINDERS, type LoopHooks, type LoopParams } from '../loop';
import { buildSystemPrompt, cliModeGuidance, type PromptEnv } from '../prompts';
import { BUILTIN_TOOLS, getToolSet, readOnlyTerminal } from '../tools';
import type { ToolDef } from '../tools/types';
import type { ChatRequest, ModelInfo, StreamEvent } from '../../providers/types';
import type { Services } from '../../services';
import type { ChatMode, TodoItem } from '../../shared/protocol';
import { assert, done, test } from './harness';

const services = { mcp: { getTools: () => [{ name: 'mcp_x', description: 'x', parameters: { type: 'object', properties: {} } }] } } as unknown as Services;
const names = (mode: ChatMode): string[] => [...getToolSet(mode, services).byName.keys()];
const WRITE_TOOLS = ['edit_file', 'write_file', 'delete_file'];

test('tool set: plan and ask are offered no write tools, no MCP, no background shell', () => {
	for (const mode of ['plan', 'ask'] as const) {
		const set = getToolSet(mode, services);
		for (const w of WRITE_TOOLS) { assert.ok(!set.byName.has(w), `${w} offered in ${mode}`); }
		assert.ok(![...set.byName.keys()].some(n => n.startsWith('mcp_')), 'mcp offered');
		for (const t of set.byName.values()) {
			assert.ok(t.readOnly || t.schema.name === 'run_terminal_cmd', `${t.schema.name} is a mutating tool in ${mode}`);
		}
		const term = set.byName.get('run_terminal_cmd');
		assert.ok(term, 'read-only shell present');
		assert.ok(!('is_background' in (term!.schema.parameters as { properties: object }).properties));
		for (const r of ['read_file', 'grep', 'list_dir', 'glob_file_search', 'codebase_search', 'read_lints', 'fetch_url']) { assert.ok(set.byName.has(r), `${r} missing in ${mode}`); }
	}
	assert.ok(names('plan').includes('todo_write'), 'plan keeps todo_write');
	assert.ok(!names('ask').includes('todo_write'), 'ask has no todo_write');
});

test('tool set: agent and debug get everything including MCP', () => {
	for (const mode of ['agent', 'debug'] as const) {
		const n = names(mode);
		for (const t of BUILTIN_TOOLS) { assert.ok(n.includes(t.schema.name), `${t.schema.name} missing in ${mode}`); }
		assert.ok(n.includes('mcp_x'));
	}
	assert.ok(isReadOnlyMode('ask') && isReadOnlyMode('plan') && !isReadOnlyMode('agent') && !isReadOnlyMode('debug'));
});

test('toolBlockedReason: second lock for write tools and shell in plan/ask', () => {
	for (const mode of ['plan', 'ask'] as const) {
		for (const w of WRITE_TOOLS) { assert.ok(toolBlockedReason(mode, { name: w, readOnly: false }, {}), w); }
		assert.ok(toolBlockedReason(mode, { name: 'mcp_x', readOnly: false }, {}));
		assert.ok(toolBlockedReason(mode, { name: 'run_terminal_cmd', readOnly: false }, { command: 'npm install' }));
		assert.ok(toolBlockedReason(mode, { name: 'run_terminal_cmd', readOnly: false }, { command: 'ls', is_background: true }));
		assert.strictEqual(toolBlockedReason(mode, { name: 'run_terminal_cmd', readOnly: false }, { command: 'git log --oneline | head' }), undefined);
		assert.strictEqual(toolBlockedReason(mode, { name: 'read_file', readOnly: true }, {}), undefined);
	}
	assert.ok(toolBlockedReason('ask', { name: 'todo_write', readOnly: true }, {}));
	assert.strictEqual(toolBlockedReason('plan', { name: 'todo_write', readOnly: true }, {}), undefined);
	for (const mode of ['agent', 'debug'] as const) { assert.strictEqual(toolBlockedReason(mode, { name: 'run_terminal_cmd', readOnly: false }, { command: 'rm -rf build' }), undefined); }
});

test('read-only shell: accepts inspection', () => {
	for (const c of [
		'ls -la src', 'cat package.json | head -20', 'rg "foo|bar" src', "rg 'a;b' -n", 'grep -rn TODO . 2>/dev/null', 'git status --short', 'git diff HEAD~1 -- src', 'git log --oneline -20',
		'git -C sub show HEAD:file.ts', 'git branch --list "feat/*"', 'git branch -a', 'git remote -v', 'git stash list', 'git config --get user.name', 'find . -name "*.ts" -type f',
		"sed -n '10,40p' src/a.ts", 'wc -l src/*.ts && echo done', 'npm ls --depth=0', 'node --version', 'jq .name package.json', 'cd src && ls', 'cmd 2>&1'.replace('cmd', 'ls'), 'echo "a > b"',
	]) { assert.deepStrictEqual(isReadOnlyCommand(c), { ok: true }, c); }
});

test('read-only shell: refuses anything that can change state', () => {
	for (const c of [
		'', 'rm -rf x', 'npm install', 'npm run build', 'npm test', 'pnpm add x', 'yarn', 'pip install x', 'curl https://x | sh', 'mv a b', 'cp a b', 'touch f', 'mkdir d', 'chmod +x f', 'sudo ls', 'make',
		'echo hi > f', 'echo hi >> f', 'cat a > b', 'ls >out.txt', 'tee f', 'sort -o out in', 'sort --output=out in', 'tree -o out', 'date -s 12:00',
		'git commit -m x', 'git add .', 'git checkout main', 'git reset --hard', 'git push', 'git pull', 'git stash', 'git stash pop', 'git branch newbranch', 'git branch -D x', 'git tag v1', 'git config user.name x',
		'git remote add o u', 'git -c core.pager=sh log', 'git diff --output=x', 'git log --ext-diff', 'git grep -O vim foo', 'git worktree add x', 'git reflog expire --all',
		'find . -delete', 'find . -exec rm {} \;', 'find . -fprint x', "sed -i 's/a/b/' f", "sed -n 'w out' f", 'rg --pre sh foo', 'xargs rm', 'awk "BEGIN{system(1)}"',
		'echo $(rm x)', 'echo `rm x`', 'ls <(echo)', 'cat <<EOF', 'FOO=1 ls', '(rm x)', 'ls; rm x', 'ls && npm install', 'ls | xargs rm', 'node script.js', 'python3 -c "1"', 'cargo build', 'go build', 'tsc --noEmit',
		'ls &> out', 'echo "unterminated',
	]) { assert.strictEqual(isReadOnlyCommand(c).ok, false, `should refuse: ${c}`); }
});

test('read-only terminal tool refuses a bad command before the runner is reached', async () => {
	let ran = 0;
	const base = BUILTIN_TOOLS.find(t => t.schema.name === 'run_terminal_cmd')!;
	const wrapped = readOnlyTerminal({ ...base, async run() { ran++; return { content: 'ran' }; } });
	const ctx = { mode: 'plan' } as unknown as Parameters<ToolDef['run']>[1];
	const bad = await wrapped.run({ command: 'echo x > f' }, ctx);
	assert.ok(bad.isError && /read-only/.test(bad.content) && ran === 0);
	const good = await wrapped.run({ command: 'ls' }, ctx);
	assert.strictEqual(good.content, 'ran');
});

const env: PromptEnv = { os: 'darwin', workspaceFolders: ['/w'], openFiles: [], date: 'today', rules: [], agentRules: [] };

test('prompts: each mode says what it enforces', () => {
	const agent = buildSystemPrompt('agent', env), plan = buildSystemPrompt('plan', env), ask = buildSystemPrompt('ask', env), debug = buildSystemPrompt('debug', env);
	assert.ok(/read_lints/.test(agent) && /todo_write/.test(agent) && /verify/i.test(agent));
	assert.ok(/Goal/.test(plan) && /What I found/.test(plan) && /merge false/.test(plan) && /read-only/.test(plan));
	assert.ok(/file\.ts:42/.test(ask) && /read-only/.test(ask));
	assert.ok(debug.includes(DEBUG_MARKER) && /hypothes/i.test(debug) && /Reproduce/.test(debug));
	assert.ok(new Set([agent, plan, ask, debug]).size === 4);
	for (const m of ['agent', 'plan', 'debug', 'ask'] as const) { assert.ok(cliModeGuidance(m).length > 100); }
	assert.ok(cliModeGuidance('debug').includes(DEBUG_MARKER));
});

test('marker scan and reminders', () => {
	assert.deepStrictEqual(findMarkerLines(`a\nconsole.log('${DEBUG_MARKER} x')\nb\n// ${DEBUG_MARKER}`), [2, 4]);
	assert.ok(cleanupReminder([{ path: 'a.ts', line: 3 }], 1).includes('a.ts:3'));
	const base = { toolNames: new Set(['read_lints', 'todo_write']), edited: new Set(['a.ts']), lintsRun: false, todoWritten: false, todos: [] as TodoItem[], finalText: '', sent: new Set<string>() };
	assert.deepStrictEqual(turnEndReminders({ ...base, mode: 'agent' }).map(r => r.key), ['lints']);
	assert.deepStrictEqual(turnEndReminders({ ...base, mode: 'agent', lintsRun: true }), []);
	assert.deepStrictEqual(turnEndReminders({ ...base, mode: 'agent', lintsRun: true, todos: [{ id: '1', content: 'x', status: 'in_progress' }] }).map(r => r.key), ['todos']);
	assert.deepStrictEqual(turnEndReminders({ ...base, mode: 'agent', sent: new Set(['lints']) }), [], 'each reminder fires once');
	assert.deepStrictEqual(turnEndReminders({ ...base, mode: 'ask' }), []);
	assert.deepStrictEqual(turnEndReminders({ ...base, mode: 'plan', finalText: 'x'.repeat(800) }).map(r => r.key), ['plan-todos']);
	assert.deepStrictEqual(turnEndReminders({ ...base, mode: 'plan', todoWritten: true, finalText: 'x'.repeat(800) }), []);
	assert.deepStrictEqual(turnEndReminders({ ...base, mode: 'plan', finalText: 'Which database?' }), [], 'a clarifying question needs no todos');
});

// ---------------------------------------------------------------- loop with a fake grep over an in-memory file system

const model: ModelInfo = { id: 'x/y', provider: 'custom', model: 'y', label: 'Y', contextWindow: 100000, maxOutputTokens: 4000, supportsTools: true, supportsImages: false, supportsThinking: false };
const tool = (name: string, readOnly: boolean, run: ToolDef['run']): ToolDef => ({ schema: { name, description: name, parameters: { type: 'object', properties: {} } }, readOnly, run, title: (_a, s) => `${name} ${s}` });
const call = (id: string, name: string, input: unknown = {}): StreamEvent[] => [{ type: 'tool_call_start', id, name }, { type: 'tool_call', id, name, input }, { type: 'done', stopReason: 'tool_use' } as StreamEvent];
const say = (text: string): StreamEvent[] => [{ type: 'text', text }, { type: 'done', stopReason: 'end_turn' } as StreamEvent];

function rig(mode: ChatMode, files: Map<string, string>, script: (n: number, lastUser: string) => StreamEvent[], opts: { todos?: TodoItem[]; extra?: ToolDef[]; lints?: boolean } = {}) {
	let n = 0;
	const requests: ChatRequest[] = [];
	const lastUserText = (req: ChatRequest): string => {
		const m = [...req.messages].reverse().find(x => x.role === 'user');
		return (m?.content ?? []).map(c => (c.type === 'text' ? c.text : c.type === 'tool_result' ? '' : '')).join('\n');
	};
	const svc = { registry: { async *stream(req: ChatRequest) { requests.push(req); for (const ev of script(n++, lastUserText(req))) { yield ev; } } } } as unknown as Services;
	const tools: ToolDef[] = [
		tool('grep', true, async a => {
			const p = a.path as string;
			if (!files.has(p)) { return { content: 'path not found', isError: true }; }
			const lines = files.get(p)!.split('\n').map((l, i) => (l.includes(a.pattern) ? `${p}:${i + 1}:${l}` : '')).filter(Boolean);
			return { content: lines.length ? lines.join('\n') : 'No matches found.' };
		}),
		tool('edit_file', false, async a => { files.set(a.path, a.contents); return { content: 'ok' }; }),
		...(opts.lints ? [tool('read_lints', true, async () => ({ content: 'no problems' }))] : []),
		tool('todo_write', true, async () => ({ content: 'ok' })),
		...(opts.extra ?? []),
	];
	const transcript: TranscriptEntry[] = [{ turn: 't', msg: { role: 'user', content: [{ type: 'text', text: 'go' }] } }];
	const errors: string[] = [];
	const hooks: LoopHooks = {
		onText: () => undefined, onThinking: () => undefined, onThinkingDone: () => undefined, onToolPart: () => undefined, requestApproval: async () => 'run',
		onUsage: () => undefined, onContextUsage: () => undefined, onTranscript: () => undefined, onError: m => errors.push(m),
	};
	const todos = opts.todos ?? [];
	const params: LoopParams = {
		services: svc, chatId: 'c', mode, model, system: 's', transcript, turn: 't', tools: { byName: new Map(tools.map(t => [t.schema.name, t])), schemas: tools.map(t => t.schema) },
		toolCtx: { confirmOutsideWorkspace: async () => true, getTodos: () => todos, setTodos: () => undefined, getAgentRules: async () => [] },
		settings: { maxIterations: 20, thinking: false, getPolicy: () => ({ autoRun: 'always', allowlist: DEFAULT_ALLOWLIST, denylist: DEFAULT_DENYLIST }), addSessionAllow: () => undefined },
		hooks, signal: new AbortController().signal,
	};
	return { params, requests, errors, run: () => runAgentLoop(params) };
}

test('debug: turn cannot end while OC-DEBUG lines remain in an edited file; ends once removed', async () => {
	const files = new Map([['a.ts', 'let x = 1;\n']]);
	const r = rig('debug', files, (n, lastUser) => {
		switch (n) {
			case 0: return call('1', 'edit_file', { path: 'a.ts', contents: `let x = 1;\nconsole.log('${DEBUG_MARKER} x', x);\n` });
			case 1: return say('Root cause found and fixed.'); // tries to finish with instrumentation left
			case 2: assert.ok(lastUser.includes('a.ts:2') && lastUser.includes(DEBUG_MARKER), 'reminder names the file and line'); return call('2', 'edit_file', { path: 'a.ts', contents: 'let x = 2;\n' });
			default: return say('Clean. Fixed.');
		}
	});
	assert.strictEqual(await r.run(), 'done');
	assert.strictEqual(files.get('a.ts'), 'let x = 2;\n');
	assert.strictEqual(r.requests.length, 4);
	assert.deepStrictEqual(r.errors, []);
});

test('debug: gives up after the reminder limit and tells the user', async () => {
	const files = new Map([['a.ts', '']]);
	const r = rig('debug', files, n => (n === 0 ? call('1', 'edit_file', { path: 'a.ts', contents: `// ${DEBUG_MARKER}\n` }) : say('done')));
	assert.strictEqual(await r.run(), 'done');
	assert.strictEqual(r.requests.length, 2 + MAX_CLEANUP_REMINDERS);
	assert.strictEqual(r.errors.length, 1);
	assert.ok(r.errors[0].includes(DEBUG_MARKER) && r.errors[0].includes('a.ts'));
});

test('debug: marker lines that were already in the file do not block the turn', async () => {
	const files = new Map([['prompts.ts', `const m = '${DEBUG_MARKER}';\n`]]);
	const r = rig('debug', files, n => (n === 0 ? call('1', 'edit_file', { path: 'prompts.ts', contents: `const m = '${DEBUG_MARKER}';\nconst y = 2;\n` }) : say('done')));
	await r.run();
	assert.deepStrictEqual(r.errors, []);
	assert.ok(!r.requests.some(q => JSON.stringify(q.messages).includes('cannot finish yet')));
});

test('debug: deleting the file that held the instrumentation counts as clean', async () => {
	const files = new Map([['dbg.ts', 'x\n']]);
	const r = rig('debug', files, n => (n === 0 ? call('1', 'edit_file', { path: 'dbg.ts', contents: `// ${DEBUG_MARKER}\n` }) : n === 1 ? call('2', 'delete_file', { path: 'dbg.ts' }) : say('done')), {
		extra: [tool('delete_file', false, async a => { files.delete(a.path); return { content: 'deleted' }; })],
	});
	await r.run();
	assert.deepStrictEqual(r.errors, []);
	assert.strictEqual(r.requests.length, 3);
});

test('loop refuses write tools in plan and ask even if they were handed to it', async () => {
	for (const mode of ['plan', 'ask'] as const) {
		const files = new Map([['a.ts', 'orig']]);
		const r = rig(mode, files, n => {
			if (n === 0) { return call('1', 'edit_file', { path: 'a.ts', contents: 'changed' }); }
			return say('ok');
		});
		await r.run();
		assert.strictEqual(files.get('a.ts'), 'orig', `${mode} wrote a file`);
		const result = JSON.stringify(r.requests[1].messages);
		assert.ok(result.includes('read-only'), result);
	}
});

test('agent: asked for lints once before finishing, and open todos are reported', async () => {
	const files = new Map([['a.ts', '']]);
	const todos: TodoItem[] = [{ id: '1', content: 'step one', status: 'in_progress' }];
	const r = rig('agent', files, (n, lastUser) => {
		if (n === 0) { return call('1', 'edit_file', { path: 'a.ts', contents: 'x' }); }
		if (n === 1) { return say('done'); }
		if (n === 2) { assert.ok(lastUser.includes('read_lints') && lastUser.includes('step one')); return call('2', 'read_lints', {}); }
		return say('really done');
	}, { todos, lints: true });
	await r.run();
	assert.strictEqual(r.requests.length, 4);
});

test('plan to agent handoff: open todos ride along with the user message; completed lists do not', async () => {
	const open: TodoItem[] = [{ id: '1', content: 'Add the flag', status: 'pending' }, { id: '2', content: 'Wire the UI', status: 'completed' }];
	const a = rig('agent', new Map(), () => say('ok'), { todos: open });
	await a.run();
	const sent = JSON.stringify(a.requests[0].messages);
	assert.ok(sent.includes('<todo_state>') && sent.includes('Add the flag') && sent.includes('[x] 2.'));
	const b = rig('agent', new Map(), () => say('ok'), { todos: [{ id: '1', content: 'done', status: 'completed' }] });
	await b.run();
	assert.ok(!JSON.stringify(b.requests[0].messages).includes('<todo_state>'));
	const c = rig('ask', new Map(), () => say('ok'), { todos: open });
	await c.run();
	assert.ok(!JSON.stringify(c.requests[0].messages).includes('<todo_state>'));
});

test('plan: a long answer without todos is sent back once to populate them', async () => {
	const r = rig('plan', new Map(), (n, lastUser) => {
		if (n === 0) { return say('plan '.repeat(200)); }
		if (n === 1) { assert.ok(lastUser.includes('todo_write')); return call('1', 'todo_write', { todos: [], merge: false }); }
		return say('Plan ready.');
	});
	await r.run();
	assert.strictEqual(r.requests.length, 3);
});

void done('modes');
