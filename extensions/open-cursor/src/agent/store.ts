/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Chat persistence: one JSON file per chat plus an index, debounced writes, titles.
 *--------------------------------------------------------------------------------------------*/

import { ensureValid } from './history';
import * as fs from 'fs';
import * as nodePath from 'path';
import type { ModelInfo } from '../providers/types';
import type { IProviderRegistry } from '../services';
import type { Chat, ChatMode, ChatSummary } from '../shared/protocol';
import type { TranscriptEntry } from './history';

export type MutableChat = { -readonly [K in keyof Chat]: Chat[K] };

export interface StoredChat {
	chat: MutableChat;
	transcript: TranscriptEntry[];
	/** The CLI agent's own session id, for resume. */
	cliSessionId?: string;
	/** Which agent and folder that session belongs to; another CLI, or another folder, cannot resume it. */
	cliSessionAgent?: string;
	cliSessionCwd?: string;
	/** The last message that session saw; turns after it ran on other models and are summarized for it. */
	cliSessionUpTo?: string;
	/** Where a command line agent works for this chat when no folder is open. */
	scratchDir?: string;
	titleSource: 'default' | 'auto' | 'user';
}

interface IndexFile {
	version: 1;
	chats: ChatSummary[];
	openChatIds: string[];
	activeChatId?: string;
}

export const DEFAULT_TITLE = 'New chat';
const SAVE_DELAY_MS = 600;

export function toSummary(c: Chat): ChatSummary {
	return { id: c.id, title: c.title, updatedAt: c.updatedAt, status: c.status === 'running' || c.status === 'awaiting-approval' ? c.status : c.status, mode: c.mode };
}

export function newId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** First words of the prompt as a title. */
export function fallbackTitle(text: string): string {
	const clean = text.replace(/```[\s\S]*?```/g, ' ').replace(/[#*`>_\[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
	if (!clean) { return DEFAULT_TITLE; }
	const words = clean.split(' ').slice(0, 6).join(' ');
	return words.length > 48 ? words.slice(0, 47).trimEnd() + '…' : words;
}

/** Cleans a model written title: strips quotes and trailing punctuation, caps the length. */
export function sanitizeTitle(raw: string): string | undefined {
	const t = raw.split('\n')[0].replace(/^["'`*#\s]+|["'`*.\s]+$/g, '').replace(/^title:\s*/i, '').trim();
	if (!t || t.length < 3) { return undefined; }
	return t.length > 60 ? t.slice(0, 59).trimEnd() + '…' : t;
}

export async function generateTitle(registry: IProviderRegistry, model: ModelInfo | undefined, userText: string, assistantText: string, signal: AbortSignal): Promise<string | undefined> {
	if (!model) { return undefined; }
	try {
		let out = '';
		for await (const ev of registry.stream({
			model, signal, maxTokens: 24, temperature: 0.2,
			system: 'You write short titles for chat conversations. Reply with only the title: 3 to 6 words, no quotes, no trailing punctuation, in the language of the user message.',
			messages: [{ role: 'user', content: [{ type: 'text', text: `User message:\n${userText.slice(0, 600)}\n\nAssistant reply (start):\n${assistantText.slice(0, 400)}\n\nTitle:` }] }],
		})) {
			if (ev.type === 'text') { out += ev.text; }
			if (out.length > 200) { break; }
		}
		return sanitizeTitle(out);
	} catch {
		return undefined;
	}
}

export class ChatStore {
	private index: IndexFile = { version: 1, chats: [], openChatIds: [] };
	private readonly cache = new Map<string, StoredChat>();
	private readonly dirty = new Set<string>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private indexDirty = false;
	private writing: Promise<void> = Promise.resolve();

	constructor(private readonly dir: string) { }

	async init(): Promise<void> {
		try {
			await fs.promises.mkdir(this.dir, { recursive: true });
			const raw = await fs.promises.readFile(nodePath.join(this.dir, 'index.json'), 'utf8');
			const parsed = JSON.parse(raw) as IndexFile;
			if (parsed && Array.isArray(parsed.chats)) {
				this.index = {
					version: 1,
					chats: parsed.chats.filter(c => c && typeof c.id === 'string').map(c => ({ ...c, status: 'idle' as const })),
					openChatIds: Array.isArray(parsed.openChatIds) ? parsed.openChatIds.filter(i => typeof i === 'string') : [],
					activeChatId: typeof parsed.activeChatId === 'string' ? parsed.activeChatId : undefined,
				};
			} else {
				// valid JSON that is not an index (an empty object, a newer layout): rebuild from the chat files
				await this.rebuildIndex();
			}
		} catch {
			// first run or corrupt index: rebuild from files
			await this.rebuildIndex();
		}
	}

	private async rebuildIndex(): Promise<void> {
		try {
			const names = (await fs.promises.readdir(this.dir)).filter(n => n.endsWith('.json') && n !== 'index.json');
			const chats: ChatSummary[] = [];
			for (const n of names) {
				try {
					const sc = JSON.parse(await fs.promises.readFile(nodePath.join(this.dir, n), 'utf8')) as StoredChat;
					if (sc?.chat?.id) { chats.push(toSummary(sc.chat)); }
				} catch { /* skip unreadable chat */ }
			}
			this.index = { version: 1, chats, openChatIds: chats.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3).map(c => c.id) };
		} catch { /* no directory yet */ }
	}

	summaries(): ChatSummary[] {
		return this.index.chats.map(c => this.unreadable.has(c.id) ? { ...c, title: `${c.title} (unreadable)` } : c).sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/** Chats whose file exists but could not be read. */
	private readonly unreadable = new Set<string>();
	/** Set by the owner: chats that must stay in memory (a running turn). */
	isBusy: (id: string) => boolean = () => false;

	isUnreadable(id: string): boolean { return this.unreadable.has(id); }

	/** Moves an unreadable chat file aside (never deletes it) and drops the chat from the list and tabs. */
	async quarantine(id: string): Promise<void> {
		const file = nodePath.join(this.dir, `${id}.json`);
		try { await fs.promises.rename(file, `${file}.unreadable-${Date.now()}`); } catch { /* already gone */ }
		this.unreadable.delete(id);
		this.cache.delete(id);
		this.dirty.delete(id);
		this.deleted.add(id);
		this.index.chats = this.index.chats.filter(c => c.id !== id);
		this.index.openChatIds = this.index.openChatIds.filter(c => c !== id);
		if (this.index.activeChatId === id) { this.index.activeChatId = undefined; }
		this.markIndex();
	}

	/** Drops chats nobody is looking at, so a long session does not hold every chat it ever opened. */
	private evict(): void {
		if (this.cache.size <= 12) { return; }
		const keep = new Set([...this.index.openChatIds, this.index.activeChatId ?? '']);
		for (const id of [...this.cache.keys()]) {
			if (this.cache.size <= 12) { break; }
			if (keep.has(id) || this.dirty.has(id) || this.isBusy(id)) { continue; }
			this.cache.delete(id);
		}
	}

	get openChatIds(): string[] { return this.index.openChatIds; }
	get activeChatId(): string | undefined { return this.index.activeChatId; }

	setOpen(ids: string[], active?: string): void {
		this.index.openChatIds = ids;
		if (active !== undefined) { this.index.activeChatId = active; }
		this.markIndex();
	}

	/** Chats already read from disk this session. */
	loaded(): StoredChat[] {
		return [...this.cache.values()];
	}

	has(id: string): boolean {
		return this.cache.has(id) || this.index.chats.some(c => c.id === id);
	}

	async get(id: string): Promise<StoredChat | undefined> {
		const hit = this.cache.get(id);
		if (hit) { return hit; }
		if (!this.index.chats.some(c => c.id === id)) { return undefined; }
		try {
			const raw = await fs.promises.readFile(nodePath.join(this.dir, `${id}.json`), 'utf8');
			const sc = JSON.parse(raw) as StoredChat;
			if (!sc?.chat || typeof sc.chat !== 'object') { this.unreadable.add(id); return undefined; }
			sc.chat.status = 'idle';
			sc.chat.messages = Array.isArray(sc.chat.messages) ? sc.chat.messages : [];
			sc.chat.queued = Array.isArray(sc.chat.queued) ? sc.chat.queued : [];
			sc.chat.todos = Array.isArray(sc.chat.todos) ? sc.chat.todos : [];
			sc.transcript = Array.isArray(sc.transcript) ? sc.transcript : [];
			// The window closed mid turn: nothing is running any more. Tool rows stop spinning, and a tool call
			// saved without its result is answered, or providers would reject every later message in this chat.
			sc.chat.messages = sc.chat.messages.map(m => m.role !== 'assistant' || m.done ? m : {
				...m, done: true,
				parts: m.parts.map(p => p.type === 'tool' && (p.status === 'running' || p.status === 'streaming' || p.status === 'awaiting-approval') ? { ...p, status: 'cancelled' as const }
					: p.type === 'thinking' && !p.done ? { ...p, done: true } : p),
			});
			sc.transcript = ensureValid(sc.transcript);
			sc.titleSource ??= 'auto';
			const again = this.cache.get(id);
			if (again) { return again; }
			this.cache.set(id, sc);
			this.evict();
			return sc;
		} catch {
			// a file that is missing is just gone; one that exists but will not parse is shown as unreadable
			if (fs.existsSync(nodePath.join(this.dir, `${id}.json`))) { this.unreadable.add(id); }
			return undefined;
		}
	}

	create(init: { mode: ChatMode; modelId: string }): StoredChat {
		const now = Date.now();
		const sc: StoredChat = {
			chat: { id: newId('chat'), title: DEFAULT_TITLE, mode: init.mode, modelId: init.modelId, createdAt: now, updatedAt: now, messages: [], todos: [], status: 'idle', queued: [] },
			transcript: [],
			titleSource: 'default',
		};
		this.cache.set(sc.chat.id, sc);
		this.index.chats.push(toSummary(sc.chat));
		this.markDirty(sc.chat.id);
		return sc;
	}

	/** Mark a chat changed: refreshes its index summary and schedules a write. */
	markDirty(id: string): void {
		const sc = this.cache.get(id);
		if (sc) {
			const sum = toSummary(sc.chat);
			const i = this.index.chats.findIndex(c => c.id === id);
			if (i === -1) { this.index.chats.push(sum); } else { this.index.chats[i] = sum; }
			this.dirty.add(id);
			this.indexDirty = true;
		}
		this.schedule();
	}

	private markIndex(): void {
		this.indexDirty = true;
		this.schedule();
	}

	private schedule(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => { void this.flush(); }, SAVE_DELAY_MS);
	}

	async delete(id: string): Promise<void> {
		this.cache.delete(id);
		this.dirty.delete(id);
		this.deleted.add(id);
		this.index.chats = this.index.chats.filter(c => c.id !== id);
		this.index.openChatIds = this.index.openChatIds.filter(c => c !== id);
		if (this.index.activeChatId === id) { this.index.activeChatId = undefined; }
		this.markIndex();
		await this.writing;
		try { await fs.promises.unlink(nodePath.join(this.dir, `${id}.json`)); } catch { /* already gone */ }
	}

	/** Chats deleted in this window, so a merge with the index on disk does not bring them back. */
	private readonly deleted = new Set<string>();

	/**
	 * Windows without a folder share this store. Before writing the index, chats another window added
	 * are taken in (when their file exists), so neither window erases the other's history.
	 */
	private async mergeDiskIndex(): Promise<void> {
		try {
			const disk = JSON.parse(await fs.promises.readFile(nodePath.join(this.dir, 'index.json'), 'utf8')) as IndexFile;
			if (!disk || !Array.isArray(disk.chats)) { return; }
			// a chat another window deleted: its file is gone, so it leaves this index too (unless open here)
			this.index.chats = this.index.chats.filter(c => this.cache.has(c.id) || fs.existsSync(nodePath.join(this.dir, `${c.id}.json`)));
			const known = new Set(this.index.chats.map(c => c.id));
			for (const c of disk.chats) {
				if (!c?.id || known.has(c.id) || this.deleted.has(c.id)) { continue; }
				if (fs.existsSync(nodePath.join(this.dir, `${c.id}.json`))) { this.index.chats.push({ ...c, status: 'idle' }); }
			}
		} catch { /* no index yet, or unreadable: ours stands */ }
	}

	flush(): Promise<void> {
		clearTimeout(this.timer);
		const ids = [...this.dirty];
		this.dirty.clear();
		const writeIndex = this.indexDirty;
		this.indexDirty = false;
		const snapshot = ids.map(id => ({ id, sc: this.cache.get(id) })).filter((x): x is { id: string; sc: StoredChat } => !!x.sc);
		const run = async (): Promise<void> => {
			try { await fs.promises.mkdir(this.dir, { recursive: true }); } catch { /* ignore */ }
			let failed = false;
			for (const { id, sc } of snapshot) {
				const ok = await atomicWrite(nodePath.join(this.dir, `${id}.json`), serializeChat(sc));
				// a full disk or a locked file: keep the change and try again later instead of dropping it
				if (!ok) { this.dirty.add(id); failed = true; }
			}
			if (writeIndex) {
				await this.mergeDiskIndex();
				if (!(await atomicWrite(nodePath.join(this.dir, 'index.json'), JSON.stringify(this.index)))) { this.indexDirty = true; failed = true; }
			}
			if (failed) { this.timer = setTimeout(() => { void this.flush(); }, SAVE_DELAY_MS * 10); }
		};
		this.writing = this.writing.then(run, run).catch(() => undefined);
		return this.writing;
	}
}

const messageJson = new WeakMap<object, { parts: number; last: unknown; json: string }>();

/** Finished messages never change, so their JSON is kept between saves; only the live message is stringified again. */
function messageToJson(m: StoredChat['chat']['messages'][number]): string {
	if (m.role === 'assistant' && !m.done) { return JSON.stringify(m); }
	const parts = m.role === 'assistant' ? m.parts : undefined;
	const hit = messageJson.get(m);
	if (hit && hit.parts === (parts?.length ?? 0) && hit.last === parts?.[parts.length - 1]) { return hit.json; }
	const json = JSON.stringify(m);
	messageJson.set(m, { parts: parts?.length ?? 0, last: parts?.[parts.length - 1], json });
	return json;
}

/** Same format as JSON.stringify of the stored chat; the messages come from the per message cache. */
export function serializeChat(sc: StoredChat): string {
	const { messages, ...rest } = { ...sc.chat, status: 'idle' as const };
	const head = JSON.stringify({ ...rest, messages: [] });
	const body = messages.map(messageToJson).join(',');
	return `{"chat":${head.slice(0, -2)}${body}]},"transcript":${JSON.stringify(sc.transcript)}${tail(sc)}}`;
}

function tail(sc: StoredChat): string {
	const extra = JSON.stringify({ cliSessionId: sc.cliSessionId, cliSessionAgent: sc.cliSessionAgent, cliSessionCwd: sc.cliSessionCwd, cliSessionUpTo: sc.cliSessionUpTo, scratchDir: sc.scratchDir, titleSource: sc.titleSource });
	return extra.length > 2 ? ',' + extra.slice(1, -1) : '';
}

async function atomicWrite(file: string, data: string): Promise<boolean> {
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		await fs.promises.writeFile(tmp, data, 'utf8');
		await fs.promises.rename(tmp, file);
		return true;
	} catch {
		try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
		return false;
	}
}
