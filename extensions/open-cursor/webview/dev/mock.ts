/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Fake extension host for developing the chat webview in a plain browser.
 *  Defines window.acquireVsCodeApi before the chat bundle loads.
 *
 *  Query params: ?scenario=static|stream|empty|history|plan   ?theme=dark|light   ?w=400
 *--------------------------------------------------------------------------------------------*/

import type {
	AssistantMessage, Chat, ChatMessage, ChatMode, ChatSummary, ContextItem, HostMessageExt, MessagePart, ModelOption,
	PendingFileEdit, ToolPart, UiSettings, WebviewMessageExt,
} from '../../src/shared/protocol';

const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') ?? 'static';

const MODELS: ModelOption[] = [
	{ id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'anthropic', supportsImages: true, supportsThinking: true, hasKey: true },
	{ id: 'anthropic/claude-opus-5', label: 'Claude Opus 5', provider: 'anthropic', supportsImages: true, supportsThinking: true, hasKey: true },
	{ id: 'openai/gpt-5.2', label: 'GPT-5.2', provider: 'openai', supportsImages: true, supportsThinking: true, hasKey: false },
	{ id: 'openai/gpt-5.2-mini', label: 'GPT-5.2 mini', provider: 'openai', supportsImages: true, supportsThinking: false, hasKey: false },
	{ id: 'google/gemini-3-pro', label: 'Gemini 3 Pro', provider: 'google', supportsImages: true, supportsThinking: true, hasKey: true },
	{ id: 'deepseek/deepseek-chat', label: 'DeepSeek V3', provider: 'deepseek', supportsImages: false, supportsThinking: false, hasKey: true },
	{ id: 'ollama/qwen2.5-coder:7b', label: 'qwen2.5-coder 7b', provider: 'ollama', supportsImages: false, supportsThinking: false, hasKey: true },
	{ id: 'cli:claude-code/default', label: 'Claude Code', provider: 'claude-code', supportsImages: true, supportsThinking: true, hasKey: true },
	{ id: 'cli:codex/default', label: 'Codex', provider: 'codex', supportsImages: false, supportsThinking: true, hasKey: false },
];

const SETTINGS: UiSettings = { autoRun: 'ask', showThinking: true, fontSize: 13, submitWithModEnter: false };

const FILES: ContextItem[] = [
	{ id: 'f1', kind: 'file', label: 'http.ts', detail: 'src/providers', uri: 'file:///w/src/providers/http.ts' },
	{ id: 'f2', kind: 'file', label: 'registry.ts', detail: 'src/providers', uri: 'file:///w/src/providers/registry.ts' },
	{ id: 'f3', kind: 'file', label: 'chatController.ts', detail: 'src/agent', uri: 'file:///w/src/agent/chatController.ts' },
	{ id: 'f4', kind: 'file', label: 'protocol.ts', detail: 'src/shared', uri: 'file:///w/src/shared/protocol.ts' },
	{ id: 'f5', kind: 'folder', label: 'providers', detail: 'src', uri: 'file:///w/src/providers/' },
	{ id: 'c1', kind: 'code', label: 'requestWithRetry', detail: 'function · http.ts', uri: 'file:///w/src/providers/http.ts', range: { startLine: 40, endLine: 88 } },
	{ id: 'g1', kind: 'git', label: 'Working tree', detail: '4 changed files' },
	{ id: 'w1', kind: 'web', label: 'Search the web' },
	{ id: 'l1', kind: 'lints', label: 'Problems', detail: '2 errors, 5 warnings' },
	{ id: 'ch1', kind: 'chat', label: 'Fix flaky MCP reconnect', detail: 'yesterday' },
];

const now = Date.now();
const H = 3_600_000;
const D = 24 * H;
const SUMMARIES: ChatSummary[] = [
	{ id: 'c-main', title: 'Retry with backoff in HTTP client', updatedAt: now - 60_000, status: 'idle', mode: 'agent' },
	{ id: 'c-2', title: 'Fix flaky MCP reconnect', updatedAt: now - 5 * H, status: 'idle', mode: 'agent' },
	{ id: 'c-3', title: 'Why is the index rebuilding on save?', updatedAt: now - 28 * H, status: 'idle', mode: 'ask' },
	{ id: 'c-4', title: 'Plan the settings page', updatedAt: now - 30 * H, status: 'idle', mode: 'plan' },
	{ id: 'c-5', title: 'Tab completion latency', updatedAt: now - 3 * D, status: 'idle', mode: 'debug' },
	{ id: 'c-6', title: 'Rename provider ids', updatedAt: now - 11 * D, status: 'idle', mode: 'agent' },
	{ id: 'c-7', title: 'Dark theme contrast for diff gutters', updatedAt: now - 40 * D, status: 'idle', mode: 'agent' },
];

let seq = 0;
const uid = (p: string): string => p + '-' + (++seq);

const user = (text: string, context: ContextItem[] = [], extra: Partial<ChatMessage> = {}): ChatMessage => ({
	id: uid('u'), role: 'user', text, context, createdAt: now - 50_000, checkpointId: 'cp-' + seq, ...extra,
} as ChatMessage);

const tool = (name: string, title: string, extra: Partial<ToolPart> = {}): ToolPart => ({
	type: 'tool', id: uid('t'), name, title, status: 'done', ...extra,
});

const MD_FINAL = `Done. Requests through \`src/providers/http.ts\` now retry on network errors, \`429\` and \`5xx\` with exponential backoff and jitter, and the attempt count is reported to the status bar.

## What changed

- **\`http.ts\`**: new \`requestWithRetry\` wraps \`request\`. It honours \`Retry-After\`, caps at 4 attempts and never retries on abort.
- **\`registry.ts\`**: forwards the \`onRetry\` callback so the status bar can show \`Retrying 2/4\`.

The core of it:

\`\`\`ts:src/providers/http.ts
export async function requestWithRetry(url: string, init: RequestInit, opts: RetryOptions = {}): Promise<Response> {
	const max = opts.attempts ?? 4;
	for (let attempt = 1; ; attempt++) {
		try {
			const res = await request(url, init);
			if (res.status !== 429 && res.status < 500) { return res; }
			if (attempt >= max) { return res; }
			await sleep(delayFor(attempt, res.headers.get('retry-after')), init.signal);
		} catch (e) {
			if (isAbort(e) || attempt >= max) { throw e; }
			opts.onRetry?.(attempt, max);
			await sleep(delayFor(attempt), init.signal);
		}
	}
}
\`\`\`

To run just the new tests:

\`\`\`bash
npm test -- --run http
\`\`\`

| Status | Retried | Notes |
|---|---|---|
| \`429\` | yes | uses \`Retry-After\` |
| \`5xx\` | yes | jittered backoff |
| \`4xx\` | no | surfaced as-is |

See also [the fetch spec](https://fetch.spec.whatwg.org/) for \`AbortSignal\` semantics.`;

function buildMain(): Chat {
	const msgs: ChatMessage[] = [
		user('Add a retry with exponential backoff to the provider HTTP client, and show the retry count in the status bar.', [FILES[0], FILES[1]]),
	];
	const parts: MessagePart[] = [
		{ type: 'thinking', text: 'The user wants retries in the shared HTTP helper. I should look at how `request` is built first, then find every caller that passes through the registry so the status bar can subscribe to attempts.\n\nBackoff: base 500ms, factor 2, full jitter, cap 8s. Respect `Retry-After`.', durationMs: 4200, done: true },
		{ type: 'text', text: 'I\'ll start with how requests are made today, then wire the retry in.' },
		tool('read_file', 'Read http.ts L1-140', { durationMs: 40 }),
		tool('grep', 'Searched `request(` · 12 results', { durationMs: 90 }),
		tool('read_file', 'Read registry.ts L90-210', { durationMs: 35 }),
		tool('codebase_search', 'Searched "status bar item updates" · 6 results', { durationMs: 480 }),
		{ type: 'text', text: 'Every provider goes through `request`, so one wrapper covers them all. Editing now.' },
		tool('edit_file', 'Edited http.ts', { edit: { uri: 'file:///w/src/providers/http.ts', path: 'src/providers/http.ts', added: 24, removed: 3 }, durationMs: 220 }),
		tool('edit_file', 'Edited registry.ts', { edit: { uri: 'file:///w/src/providers/registry.ts', path: 'src/providers/registry.ts', added: 6, removed: 1 }, durationMs: 180 }),
		tool('write_file', 'Created http.retry.test.ts', { edit: { uri: 'file:///w/src/providers/http.retry.test.ts', path: 'src/providers/http.retry.test.ts', added: 58, removed: 0, isNew: true } }),
		tool('read_lints', 'Read lints · no problems', { durationMs: 700 }),
		tool('run_terminal_cmd', 'Run command', {
			status: 'awaiting-approval',
			command: { text: 'npm test -- --run http && npx tsc --noEmit -p tsconfig.json', cwd: '/Users/dev/open-cursor/extensions/open-cursor' },
		}),
	];
	msgs.push({ id: uid('a'), role: 'assistant', parts, createdAt: now - 40_000, modelId: MODELS[0].id, done: false });
	return {
		id: 'c-main', title: 'Retry with backoff in HTTP client', mode: 'agent', modelId: MODELS[0].id, createdAt: now - 60_000, updatedAt: now - 20_000,
		messages: msgs,
		todos: [
			{ id: 't1', content: 'Read the HTTP helper and its callers', status: 'completed' },
			{ id: 't2', content: 'Add requestWithRetry with jittered backoff', status: 'completed' },
			{ id: 't3', content: 'Surface retry count through the registry', status: 'completed' },
			{ id: 't4', content: 'Run the tests and typecheck', status: 'in_progress' },
			{ id: 't5', content: 'Update the status bar item', status: 'pending' },
		],
		status: 'awaiting-approval',
		queued: [],
		contextUsage: { used: 61_000, limit: 200_000 },
	};
}

function buildDone(): Chat {
	const c = buildMain();
	const a = c.messages[c.messages.length - 1] as AssistantMessage;
	const parts = a.parts.slice(0, -1);
	parts.push(tool('run_terminal_cmd', 'Ran npm test -- --run http', {
		durationMs: 6200, output: ' ✓ http.retry.test.ts (7 tests) 412ms\n   ✓ retries on 429 using Retry-After\n   ✓ retries on network error\n   ✓ does not retry on abort\n\n Test Files  1 passed (1)\n      Tests  7 passed (7)',
	}));
	parts.push({ type: 'text', text: MD_FINAL });
	return {
		...c, status: 'idle', updatedAt: now,
		messages: [...c.messages.slice(0, -1), { ...a, parts, done: true }],
		todos: c.todos.map(t => ({ ...t, status: 'completed' as const })),
		queued: [],
	};
}

function buildPlan(): Chat {
	const base: Chat = {
		id: 'c-main', title: 'Plan the settings page', mode: 'plan', modelId: MODELS[0].id, createdAt: now, updatedAt: now, todos: [], status: 'idle', queued: [],
		messages: [
			user('Plan how to add a settings page with sections for models, rules and MCP.', []),
			{
				id: uid('a'), role: 'assistant', done: true, createdAt: now, parts: [
					tool('list_dir', 'Listed src/settings', { durationMs: 20 }),
					tool('read_file', 'Read package.json L1-60', { durationMs: 20 }),
					{ type: 'text', text: '# Settings page plan\n\n1. Add a webview panel `openCursor.settings.open` with a left nav.\n2. Define a private message protocol for reads and writes.\n3. Wire each section to its service: registry, mcp, index.\n4. Verify with the dev harness in both themes.\n\nOpen question: should API keys be editable inline, or only through the Verify flow?' },
				],
			},
		],
	};
	return base;
}

function buildEmpty(): Chat {
	return { id: 'c-new', title: 'New chat', mode: 'agent', modelId: MODELS[0].id, createdAt: now, updatedAt: now, messages: [], todos: [], status: 'idle', queued: [] };
}

const chats = new Map<string, Chat>();
let activeId = 'c-main';

function seed(): void {
	if (scenario === 'empty') { const c = buildEmpty(); chats.set(c.id, c); activeId = c.id; }
	else if (scenario === 'plan') { const c = buildPlan(); chats.set(c.id, c); activeId = c.id; }
	else if (scenario === 'stream') {
		const c = buildMain();
		chats.set(c.id, { ...c, messages: [], status: 'idle', todos: [] });
	} else { const c = scenario === 'done' ? buildDone() : buildMain(); chats.set(c.id, c); }
}
seed();
if (scenario === 'empty') { SUMMARIES.unshift({ id: 'c-new', title: 'New chat', updatedAt: Date.now(), status: 'idle', mode: 'agent' }); }

const pendingEdits = (): PendingFileEdit[] => scenario === 'empty' || scenario === 'plan' ? [] : [
	{ uri: 'file:///w/src/providers/http.ts', path: 'src/providers/http.ts', added: 24, removed: 3 },
	{ uri: 'file:///w/src/providers/registry.ts', path: 'src/providers/registry.ts', added: 6, removed: 1 },
	{ uri: 'file:///w/src/providers/http.retry.test.ts', path: 'src/providers/http.retry.test.ts', added: 58, removed: 0, isNew: true },
];
let edits: PendingFileEdit[] = scenario === 'stream' ? [] : pendingEdits();

function emit(m: HostMessageExt): void {
	window.postMessage(JSON.parse(JSON.stringify(m)), '*');
}

function snapshot(id: string): void {
	const c = chats.get(id);
	if (c) { emit({ type: 'chat', chat: c }); }
}

function summaries(): ChatSummary[] {
	return SUMMARIES.map(s => {
		const c = chats.get(s.id);
		return c ? { ...s, title: c.title, status: c.status, mode: c.mode } : s;
	});
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

let approval: ((d: 'run' | 'skip' | 'allowAlways') => void) | undefined;
let stopped = false;

function mutate(id: string, fn: (c: Chat) => Chat): void {
	const c = chats.get(id);
	if (!c) { return; }
	chats.set(id, fn(c));
	snapshot(id);
}

function lastAsst(c: Chat): AssistantMessage {
	return c.messages[c.messages.length - 1] as AssistantMessage;
}

function setParts(id: string, parts: MessagePart[], done = false): void {
	mutate(id, c => ({ ...c, messages: [...c.messages.slice(0, -1), { ...lastAsst(c), parts, done }] }));
}

async function streamText(id: string, parts: MessagePart[], text: string): Promise<MessagePart[]> {
	const idx = parts.length;
	const words = text.split(/(\s+)/);
	let acc = '';
	let i = 0;
	while (i < words.length) {
		if (stopped) { break; }
		acc += words.slice(i, i + 3).join('');
		i += 3;
		const next = [...parts];
		next[idx] = { type: 'text', text: acc };
		setParts(id, next);
		await sleep(33);
	}
	return [...parts, { type: 'text', text: acc }];
}

async function runTurn(id: string, prompt: string): Promise<void> {
	stopped = false;
	mutate(id, c => ({
		...c, status: 'running',
		messages: [...c.messages, user(prompt), { id: uid('a'), role: 'assistant', parts: [], createdAt: Date.now(), modelId: c.modelId, done: false }],
	}));
	await sleep(500);
	let parts: MessagePart[] = [{ type: 'thinking', text: '', done: false }];
	setParts(id, parts);
	const thought = 'Looking at what the request involves. I should read the relevant file, check callers with a search, then make the smallest edit that works.';
	for (let i = 0; i < thought.length && !stopped; i += 12) {
		parts = [{ type: 'thinking', text: thought.slice(0, i + 12), done: false }];
		setParts(id, parts);
		await sleep(60);
	}
	parts = [{ type: 'thinking', text: thought, done: true, durationMs: 2600 }];
	setParts(id, parts);
	parts = await streamText(id, parts, 'Let me look at the code involved before changing anything.');
	for (const [name, title, runTitle, ms] of [
		['read_file', 'Read http.ts L1-140', 'Reading http.ts', 700],
		['grep', 'Searched `request(` · 12 results', 'Searching `request(`', 900],
		['read_file', 'Read registry.ts L90-210', 'Reading registry.ts', 600],
	] as const) {
		if (stopped) { break; }
		const t = tool(name, runTitle, { status: 'running' });
		setParts(id, [...parts, t]);
		await sleep(ms);
		parts = [...parts, { ...t, title, status: 'done', durationMs: ms }];
		setParts(id, parts);
	}
	if (!stopped) {
		const e = tool('edit_file', 'Editing http.ts', { status: 'running', edit: { uri: 'file:///w/src/providers/http.ts', path: 'src/providers/http.ts', added: 8, removed: 1 } });
		setParts(id, [...parts, e]);
		await sleep(900);
		parts = [...parts, { ...e, title: 'Edited http.ts', status: 'done', edit: { ...e.edit!, added: 24, removed: 3 } }];
		setParts(id, parts);
		edits = pendingEdits().slice(0, 1);
		emit({ type: 'pendingEdits', files: edits });
		const cmd = tool('run_terminal_cmd', 'Run command', { status: 'awaiting-approval', command: { text: 'npm test -- --run http', cwd: '/Users/dev/open-cursor/extensions/open-cursor' } });
		setParts(id, [...parts, cmd]);
		mutate(id, c => ({ ...c, status: 'awaiting-approval' }));
		const decision = await new Promise<'run' | 'skip' | 'allowAlways'>(r => { approval = r; });
		mutate(id, c => ({ ...c, status: 'running' }));
		if (decision === 'skip') {
			parts = [...parts, { ...cmd, status: 'rejected', title: 'Skipped npm test -- --run http' }];
		} else {
			const out = ' RUN  v3.2.1\n\n ✓ http.retry.test.ts (7 tests) 412ms\n\n Test Files  1 passed (1)\n      Tests  7 passed (7)';
			setParts(id, [...parts, { ...cmd, status: 'running', title: 'Running npm test -- --run http', output: out.slice(0, 40) }]);
			await sleep(1200);
			parts = [...parts, { ...cmd, status: 'done', title: 'Ran npm test -- --run http', output: out, durationMs: 4200 }];
		}
		setParts(id, parts);
	}
	if (!stopped) { parts = await streamText(id, parts, MD_FINAL); }
	setParts(id, parts, true);
	mutate(id, c => ({ ...c, status: 'idle', updatedAt: Date.now() }));
	const q = chats.get(id)?.queued ?? [];
	if (q.length && !stopped) {
		const [first, ...rest] = q;
		mutate(id, c => ({ ...c, queued: rest }));
		void runTurn(id, first.text);
	}
}

function onMessage(m: WebviewMessageExt): void {
	switch (m.type) {
		case 'ready': {
			const c = chats.get(activeId)!;
			emit({
				type: 'init', chats: summaries(), openChatIds: scenario === 'empty' ? ['c-new'] : ['c-main', 'c-2', 'c-4'], activeChat: c, models: MODELS,
				settings: SETTINGS, pendingEdits: edits, workspaceName: 'open-cursor',
			});
			if (scenario === 'history') { setTimeout(() => emit({ type: 'showHistory' }), 30); }
			if (scenario === 'stream') { setTimeout(() => void runTurn('c-main', 'Add a retry with backoff to the HTTP client'), 300); }
			break;
		}
		case 'requestSlashCommands':
			emit({ type: 'slashCommands', commands: [
				{ name: 'review', description: 'Review the working tree for bugs', source: '.cursor/commands/review.md' },
				{ name: 'commit', description: 'Write a conventional commit message', source: '~/.open-cursor/commands/commit.md' },
				{ name: 'tests', description: 'Write tests for the open file', source: '.cursor/commands/tests.md' },
			] });
			break;
		case 'requestActiveEditor':
			emit({ type: 'activeEditor', item: scenario === 'empty' ? null : { id: 'active', kind: 'file', label: 'status.ts', detail: 'src/ui', uri: 'file:///w/src/ui/status.ts' } });
			break;
		case 'searchMentions': {
			const q = m.query.toLowerCase();
			const items = FILES.filter(f => (!m.kind || f.kind === m.kind) && (!q || f.label.toLowerCase().includes(q) || (f.detail ?? '').toLowerCase().includes(q)));
			setTimeout(() => emit({ type: 'mentionResults', requestId: m.requestId, items }), 40);
			break;
		}
		case 'setMode': mutate(m.chatId, c => ({ ...c, mode: m.mode as ChatMode })); break;
		case 'setModel': mutate(m.chatId, c => ({ ...c, modelId: m.modelId })); break;
		case 'send': void runTurn(m.chatId, m.text); break;
		case 'queue':
			mutate(m.chatId, c => ({ ...c, queued: [...c.queued, { id: uid('q'), text: m.text, context: m.context }] }));
			break;
		case 'unqueue': mutate(m.chatId, c => ({ ...c, queued: c.queued.filter(q => q.id !== m.queuedId) })); break;
		case 'stop':
			stopped = true;
			approval?.('skip');
			break;
		case 'approveTool': {
			const a = approval;
			approval = undefined;
			if (a) { a(m.decision); }
			else {
				// Static scenarios: resolve the pending command in place.
				mutate(m.chatId, c => {
					const last = lastAsst(c);
					const parts = last.parts.map(p => p.type === 'tool' && p.status === 'awaiting-approval'
						? { ...p, status: m.decision === 'skip' ? 'rejected' as const : 'done' as const, title: m.decision === 'skip' ? 'Skipped npm test' : 'Ran npm test -- --run http', output: m.decision === 'skip' ? undefined : ' ✓ 7 tests passed' }
						: p);
					return { ...c, status: 'idle', messages: [...c.messages.slice(0, -1), { ...last, parts }] };
				});
			}
			break;
		}
		case 'newChat': {
			const c = { ...buildEmpty(), id: uid('c-new') };
			chats.set(c.id, c);
			SUMMARIES.unshift({ id: c.id, title: 'New chat', updatedAt: Date.now(), status: 'idle', mode: 'agent' });
			activeId = c.id;
			emit({ type: 'chats', chats: summaries(), openChatIds: [c.id, 'c-main', 'c-2'] });
			emit({ type: 'chat', chat: c });
			emit({ type: 'activeChat', chatId: c.id });
			break;
		}
		case 'openChat': {
			if (!chats.has(m.chatId)) {
				const s = SUMMARIES.find(x => x.id === m.chatId);
				chats.set(m.chatId, { ...buildEmpty(), id: m.chatId, title: s?.title ?? 'Chat', mode: s?.mode ?? 'agent', messages: [user('Earlier question for ' + (s?.title ?? 'chat'), []), { id: uid('a'), role: 'assistant', parts: [{ type: 'text', text: 'Here is the earlier answer.' }], createdAt: now, done: true }] });
			}
			emit({ type: 'chat', chat: chats.get(m.chatId)! });
			emit({ type: 'activeChat', chatId: m.chatId });
			break;
		}
		case 'acceptAll': case 'rejectAll': edits = []; emit({ type: 'pendingEdits', files: [] }); break;
		case 'acceptFile': case 'rejectFile': edits = edits.filter(f => f.uri !== m.uri); emit({ type: 'pendingEdits', files: edits }); break;
		default:
			console.info('[mock host]', m);
	}
}

let state: unknown;
(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
	postMessage: (m: WebviewMessageExt) => { setTimeout(() => onMessage(m), 0); },
	getState: () => state,
	setState: (s: unknown) => { state = s; },
});
