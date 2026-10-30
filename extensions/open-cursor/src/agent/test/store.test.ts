import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import { assert, done, test } from './harness';
import { ChatStore, serializeChat, type StoredChat } from '../store';
import { SnapshotTrimmer, restoreOmitted } from '../snapshot';
import type { Chat, ToolPart } from '../../shared/protocol';

const tmp = (): string => fs.mkdtempSync(nodePath.join(os.tmpdir(), 'oc-store-'));
const chatOf = (id: string, extra: Partial<Chat> = {}): Chat => ({ id, title: 'T ' + id, mode: 'agent', modelId: 'm', createdAt: 1, updatedAt: 2, messages: [], todos: [], status: 'idle', queued: [], ...extra });
const write = (dir: string, id: string, chat: Chat, more: object = {}): void => fs.writeFileSync(nodePath.join(dir, `${id}.json`), JSON.stringify({ chat, transcript: [], titleSource: 'auto', ...more }));

test('an index without a chats array is rebuilt from the chat files', async () => {
	const dir = tmp();
	write(dir, 'a', chatOf('a'));
	write(dir, 'b', chatOf('b'));
	fs.writeFileSync(nodePath.join(dir, 'index.json'), '{"version":2}');
	const store = new ChatStore(dir);
	await store.init();
	assert.deepStrictEqual(store.summaries().map(s => s.id).sort(), ['a', 'b']);
});

test('unknown extra fields from a newer version are ignored', async () => {
	const dir = tmp();
	write(dir, 'a', { ...chatOf('a'), brandNew: 1 } as Chat, { future: { x: 1 } });
	fs.writeFileSync(nodePath.join(dir, 'index.json'), JSON.stringify({ version: 9, chats: [{ id: 'a', title: 'T a', updatedAt: 2, status: 'idle', mode: 'agent', extra: true }, null, { nope: 1 }], openChatIds: ['a', 5], activeChatId: 'a', other: 1 }));
	const store = new ChatStore(dir);
	await store.init();
	assert.deepStrictEqual(store.summaries().map(s => s.id), ['a']);
	assert.deepStrictEqual(store.openChatIds, ['a']);
	assert.ok(await store.get('a'));
});

test('a corrupt chat file is listed as unreadable and can be moved aside, never deleted', async () => {
	const dir = tmp();
	write(dir, 'ok', chatOf('ok'));
	fs.writeFileSync(nodePath.join(dir, 'bad.json'), '{"chat": {oops');
	fs.writeFileSync(nodePath.join(dir, 'index.json'), JSON.stringify({ version: 1, chats: [{ id: 'ok', title: 'ok', updatedAt: 1, status: 'idle', mode: 'agent' }, { id: 'bad', title: 'Bad one', updatedAt: 5, status: 'idle', mode: 'agent' }], openChatIds: ['bad', 'ok'], activeChatId: 'bad' }));
	const store = new ChatStore(dir);
	await store.init();
	assert.strictEqual(await store.get('bad'), undefined);
	assert.ok(store.isUnreadable('bad'));
	assert.ok(store.summaries().find(s => s.id === 'bad')!.title.includes('unreadable'));
	await store.quarantine('bad');
	assert.deepStrictEqual(store.summaries().map(s => s.id), ['ok']);
	assert.deepStrictEqual(store.openChatIds, ['ok']);
	assert.ok(fs.readdirSync(dir).some(n => n.startsWith('bad.json.unreadable-')));
	await store.flush();
});

test('queued messages saved before a reload load back as they were, still unsent', async () => {
	const dir = tmp();
	write(dir, 'q', chatOf('q', { status: 'running', queued: [{ id: 'q1', text: 'next', context: [] }] }));
	fs.writeFileSync(nodePath.join(dir, 'index.json'), JSON.stringify({ version: 1, chats: [{ id: 'q', title: 'q', updatedAt: 1, status: 'running', mode: 'agent' }], openChatIds: ['q'] }));
	const store = new ChatStore(dir);
	await store.init();
	const sc = (await store.get('q'))!;
	assert.strictEqual(sc.chat.status, 'idle');
	assert.deepStrictEqual(sc.chat.queued.map(q => q.text), ['next']);
});

test('the cached serialization matches plain JSON and follows changes', () => {
	const done: Chat['messages'][number] = { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hi' }], createdAt: 1, done: true };
	const sc: StoredChat = { chat: { ...chatOf('c'), messages: [{ id: 'u1', role: 'user', text: 'x', context: [], createdAt: 1 }, done] } as StoredChat['chat'], transcript: [], titleSource: 'auto', cliSessionId: 's' };
	const plain = (): unknown => JSON.parse(JSON.stringify({ chat: { ...sc.chat, status: 'idle' }, transcript: sc.transcript, cliSessionId: sc.cliSessionId, cliSessionAgent: sc.cliSessionAgent, titleSource: sc.titleSource }));
	assert.deepStrictEqual(JSON.parse(serializeChat(sc)), plain());
	assert.deepStrictEqual(JSON.parse(serializeChat(sc)), plain());
	(done as { parts: unknown[] }).parts.push({ type: 'text', text: 'more' });
	assert.deepStrictEqual(JSON.parse(serializeChat(sc)), plain());
});

test('live output is capped to its tail and images travel once', () => {
	const t = new SnapshotTrimmer();
	const big = 'x'.repeat(50_000) + 'END';
	const tool = (status: ToolPart['status']): ToolPart => ({ type: 'tool', id: 't', name: 'run_terminal_cmd', status, title: '', output: big });
	const mk = (status: ToolPart['status']): Chat => chatOf('c', { messages: [
		{ id: 'u', role: 'user', text: '', createdAt: 1, context: [{ id: 'i', kind: 'image', label: 'p', content: 'data:image/png;base64,AAAA' }] },
		{ id: 'a', role: 'assistant', parts: [tool(status)], createdAt: 1, done: false },
	] });
	const live = t.trim(mk('running'));
	const part = (live.messages[1] as { parts: ToolPart[] }).parts[0];
	assert.ok(part.output!.length <= 20_001 && part.output!.endsWith('END'));
	assert.ok((live.messages[0] as { context: { content?: string }[] }).context[0].content);
	const first = mk('done');
	const sent = t.trim(first);
	assert.strictEqual((sent.messages[1] as { parts: ToolPart[] }).parts[0].output, big);
	const later = t.trim(mk('done'));
	assert.strictEqual((later.messages[0] as { context: { content?: string }[] }).context[0].content, undefined);
	const kept = (later.messages[1] as { parts: ToolPart[] }).parts[0];
	assert.strictEqual(kept.output, undefined);
	assert.strictEqual(kept.outputKept, true);
	// the webview puts both back from the copy it already has
	const back = restoreOmitted(sent, later);
	assert.strictEqual((back.messages[1] as { parts: ToolPart[] }).parts[0].output, big);
	assert.strictEqual((back.messages[1] as { parts: ToolPart[] }).parts[0].outputKept, undefined);
	assert.ok((restoreOmitted(live, later).messages[0] as { context: { content?: string }[] }).context[0].content);
	t.reset();
	assert.ok((t.trim(mk('done')).messages[0] as { context: { content?: string }[] }).context[0].content);
});

test('a chat evicted from the cache is reloaded and a late change to it is saved', async () => {
	const dir = tmp();
	const ids = Array.from({ length: 16 }, (_, i) => 'c' + i);
	for (const id of ids) { write(dir, id, chatOf(id)); }
	fs.writeFileSync(nodePath.join(dir, 'index.json'), JSON.stringify({ version: 1, chats: ids.map(id => ({ id, title: 'T ' + id, updatedAt: 2, status: 'idle', mode: 'agent' })), openChatIds: [], activeChatId: undefined }));
	const store = new ChatStore(dir);
	await store.init();
	const first = (await store.get('c0'))!;
	for (const id of ids.slice(1)) { await store.get(id); }
	assert.ok(!store.loaded().includes(first), 'c0 was evicted');
	const live = (await store.get('c0'))!;
	live.chat.title = 'Late title';
	store.markDirty('c0');
	await store.flush();
	assert.strictEqual(JSON.parse(fs.readFileSync(nodePath.join(dir, 'c0.json'), 'utf8')).chat.title, 'Late title');
});

void done('store');
