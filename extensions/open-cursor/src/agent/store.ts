/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Chat persistence: one JSON file per chat plus an index, debounced writes, titles.
 *--------------------------------------------------------------------------------------------*/

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

/** Cleans a model-written title: strips quotes and trailing punctuation, caps the length. */
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
					chats: parsed.chats.map(c => ({ ...c, status: 'idle' as const })),
					openChatIds: Array.isArray(parsed.openChatIds) ? parsed.openChatIds : [],
					activeChatId: parsed.activeChatId,
				};
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
		return [...this.index.chats].sort((a, b) => b.updatedAt - a.updatedAt);
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
			if (!sc?.chat) { return undefined; }
			sc.chat.status = 'idle';
			sc.chat.queued ??= [];
			sc.chat.todos ??= [];
			sc.transcript ??= [];
			sc.titleSource ??= 'auto';
			const again = this.cache.get(id);
			if (again) { return again; }
			this.cache.set(id, sc);
			return sc;
		} catch {
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
		this.index.chats = this.index.chats.filter(c => c.id !== id);
		this.index.openChatIds = this.index.openChatIds.filter(c => c !== id);
		if (this.index.activeChatId === id) { this.index.activeChatId = undefined; }
		this.markIndex();
		await this.writing;
		try { await fs.promises.unlink(nodePath.join(this.dir, `${id}.json`)); } catch { /* already gone */ }
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
			for (const { id, sc } of snapshot) {
				await atomicWrite(nodePath.join(this.dir, `${id}.json`), JSON.stringify({ chat: { ...sc.chat, status: 'idle' }, transcript: sc.transcript, cliSessionId: sc.cliSessionId, titleSource: sc.titleSource }));
			}
			if (writeIndex) { await atomicWrite(nodePath.join(this.dir, 'index.json'), JSON.stringify(this.index)); }
		};
		this.writing = this.writing.then(run, run).catch(() => undefined);
		return this.writing;
	}
}

async function atomicWrite(file: string, data: string): Promise<void> {
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		await fs.promises.writeFile(tmp, data, 'utf8');
		await fs.promises.rename(tmp, file);
	} catch {
		try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
	}
}
