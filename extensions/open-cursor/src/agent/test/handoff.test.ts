import { assert, done, test } from './harness';
import type { AssistantMessage, ChatMessage, ToolPart, UserMessage } from '../../shared/protocol';
import { actionLine, handoffBrief, isLimitError } from '../handoff';
import { buildHistoryFromChat, mergeUserEntry, truncateTranscript, type TranscriptEntry } from '../history';

const user = (id: string, text: string): UserMessage => ({ id, role: 'user', text, context: [], createdAt: 0 });
const tool = (p: Partial<ToolPart>): ToolPart => ({ type: 'tool', id: 't' + Math.random(), name: 'x', status: 'done', title: '', ...p });
const asst = (id: string, modelId: string, parts: AssistantMessage['parts']): AssistantMessage => ({ id, role: 'assistant', parts, createdAt: 0, modelId, done: true });

test('limits are recognised in the ways providers phrase them', () => {
	for (const m of ['Free usage limit reached. Connect a provider', 'Groq answered 429', 'Rate limit exceeded', 'You exceeded your current quota', 'insufficient_quota', 'Your credit balance is too low', 'RESOURCE_EXHAUSTED']) {
		assert.ok(isLimitError(m), m);
	}
	for (const m of ['File not found', 'Permission denied: shell', 'Invalid API key']) { assert.ok(!isLimitError(m), m); }
});

test('each tool call becomes one past tense line', () => {
	assert.strictEqual(actionLine(tool({ edit: { uri: 'u', path: 'src/cart.ts', added: 5, removed: 2 } })), 'Edited src/cart.ts (+5 -2)');
	assert.strictEqual(actionLine(tool({ edit: { uri: 'u', path: 'a.ts', added: 9, removed: 0, isNew: true } })), 'Created a.ts (+9 -0)');
	assert.strictEqual(actionLine(tool({ edit: { uri: 'u', path: 'old.ts', added: 0, removed: 4, deleted: true } })), 'Deleted old.ts');
	assert.strictEqual(actionLine(tool({ command: { text: 'npm test' }, status: 'error' })), 'Ran `npm test` (failed)');
	assert.strictEqual(actionLine(tool({ title: 'Read cart.ts' })), 'Read cart.ts');
	assert.strictEqual(actionLine(tool({ title: 'Ran rm -rf', status: 'rejected' })), undefined);
});

const chat: ChatMessage[] = [
	user('u1', 'Make remove update the total'),
	asst('a1', 'cli:opencode/big-pickle', [
		{ type: 'text', text: 'Looking at the store.' },
		tool({ title: 'Read src/store/cart.ts' }),
		tool({ edit: { uri: 'u', path: 'src/store/cart.ts', added: 3, removed: 1 } }),
		{ type: 'error', message: 'Free usage limit reached.' },
	]),
];

test('the brief carries the request, the answers, every change and the to-dos', () => {
	const b = handoffBrief(chat, { todos: [{ id: '1', content: 'Fix total', status: 'in_progress' }] });
	assert.ok(b.includes('User: Make remove update the total'));
	assert.ok(b.includes('Looking at the store.'));
	assert.ok(b.includes('Edited src/store/cart.ts (+3 -1)'));
	assert.ok(b.includes('Do not redo them'));
	assert.ok(b.includes('[~] Fix total'));
	assert.ok(b.includes('Stopped with an error'));
	assert.ok(b.startsWith('<conversation_so_far>') && b.trim().endsWith('</conversation_so_far>'));
	assert.strictEqual(handoffBrief([]), '');
});

test('a long chat keeps its newest exchanges and says what it left out', () => {
	const long: ChatMessage[] = [];
	for (let i = 0; i < 50; i++) { long.push(user('u' + i, `Request ${i} ` + 'x'.repeat(900)), asst('a' + i, 'anthropic/x', [{ type: 'text', text: `Answer ${i}` }])); }
	const b = handoffBrief(long, { maxChars: 8000 });
	assert.ok(b.length < 9500);
	assert.ok(b.includes('Request 49') && !b.includes('Request 0 '));
	assert.ok(/earlier exchanges left out/.test(b));
});

test('an update for a session that already exists says so', () => {
	assert.ok(handoffBrief(chat, { since: true }).includes('Since your last turn'));
});

test('a native model replays CLI turns as text, never as tool calls it does not have', () => {
	const h = buildHistoryFromChat(chat);
	const a = h.find(e => e.msg.role === 'assistant')!;
	assert.ok(a.msg.content.every(c => c.type === 'text'));
	const text = a.msg.content.map(c => (c.type === 'text' ? c.text : '')).join('');
	assert.ok(text.includes('Edited src/store/cart.ts (+3 -1)') && text.includes('Looking at the store.'));
});

test('OpenRouter credit errors offer another model', () => {
	for (const m of ['402: Insufficient credits', 'This request requires more credits', 'you can only afford 4000', 'Key spending limit reached']) { assert.ok(isLimitError(m), m); }
});

test('a failed turn merged into the next message can still be cut at the newer message', () => {
	const entries: TranscriptEntry[] = [];
	mergeUserEntry(entries, 't1', [{ type: 'text', text: 'first' }]);
	mergeUserEntry(entries, 't2', [{ type: 'text', text: 'second' }]);
	assert.strictEqual(entries.length, 1);
	assert.strictEqual(entries[0].msg.content.length, 2);
	const cut = truncateTranscript(entries, 't2')!;
	assert.strictEqual(cut.length, 1);
	assert.deepStrictEqual(cut[0].msg.content, [{ type: 'text', text: 'first' }]);
	assert.deepStrictEqual(truncateTranscript(entries, 't1'), []);
	assert.strictEqual(truncateTranscript(entries, 'nope'), undefined);
});

test('editing a replied message that was merged into a failed one cuts the merged entry', () => {
	const entries: TranscriptEntry[] = [];
	mergeUserEntry(entries, 't1', [{ type: 'text', text: 'first' }]);
	mergeUserEntry(entries, 't2', [{ type: 'text', text: 'second' }]);
	entries.push({ turn: 't2', msg: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } });
	const cut = truncateTranscript(entries, 't2')!;
	assert.strictEqual(cut.length, 1);
	assert.deepStrictEqual(cut[0].msg.content, [{ type: 'text', text: 'first' }]);
});

void done('handoff');
