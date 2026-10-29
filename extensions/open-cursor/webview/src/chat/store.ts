/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Chat webview state. Host snapshots merge with structural sharing so React.memo can skip unchanged messages.
 *--------------------------------------------------------------------------------------------*/

import type {
	AgentStatus, ApiProviderStatus, Chat, ChatMessage, LocalServerStatus, ChatMode, ChatSummary, ContextItem, HostMessageExt, ModelOption, PendingFileEdit, SlashCommandInfo, UiSettings,
} from '../../../src/shared/protocol';
import { loadUiState } from './host';

export interface Overrides {
	mode?: ChatMode;
	modelId?: string;
}

export interface State {
	ready: boolean;
	chats: Record<string, Chat>;
	summaries: ChatSummary[];
	openIds: string[];
	activeId: string | undefined;
	models: ModelOption[];
	settings: UiSettings;
	pendingEdits: PendingFileEdit[];
	workspaceName: string | undefined;
	slash: SlashCommandInfo[];
	activeFile: ContextItem | null;
	view: 'chat' | 'history';
	overrides: Record<string, Overrides>;
	/** Context pills the user has attached per chat, not sent yet. */
	contexts: Record<string, ContextItem[]>;
	drafts: Record<string, string>;
	/** Context from addContext(newChat) waiting for the next chat to become active. */
	carry: ContextItem[];
	/** Bumped when the host asks to focus the input. */
	focusNonce: number;
	focusText: string | undefined;
	/** Pill ids the user dismissed for the suggested active file, per chat. */
	dismissedSuggest: Record<string, string>;
	/** Agent CLIs on this machine, for connecting subscriptions on the start screen. */
	agents: AgentStatus[];
	connectHidden: boolean;
	/** Local model servers and API providers; undefined until the connect panel asks for them. */
	local: LocalServerStatus[] | undefined;
	providers: ApiProviderStatus[] | undefined;
	/** Last outcome per connect target (a provider id, or 'server'). */
	connectResults: Record<string, { ok: boolean; message: string }>;
}

export type Action =
	| { kind: 'host'; m: HostMessageExt }
	| { kind: 'view'; view: State['view'] }
	| { kind: 'draft'; chatId: string; text: string }
	| { kind: 'contexts'; chatId: string; items: ContextItem[] }
	| { kind: 'override'; chatId: string; o: Overrides }
	| { kind: 'dismissSuggest'; chatId: string; id: string }
	| { kind: 'connectHidden'; hidden: boolean };

export const DEFAULT_SETTINGS: UiSettings = { autoRun: 'ask', effort: 'auto', showThinking: true, fontSize: 13, submitWithModEnter: false };

export function initialState(): State {
	const saved = loadUiState();
	return {
		ready: false,
		chats: {},
		summaries: [],
		openIds: [],
		activeId: undefined,
		models: [],
		settings: DEFAULT_SETTINGS,
		pendingEdits: [],
		workspaceName: undefined,
		slash: [],
		activeFile: null,
		view: 'chat',
		overrides: {},
		contexts: {},
		drafts: saved.drafts,
		carry: [],
		focusNonce: 0,
		focusText: undefined,
		dismissedSuggest: {},
		agents: [],
		connectHidden: !!saved.connectHidden,
		local: undefined,
		providers: undefined,
		connectResults: {},
	};
}

export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) { return true; }
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) { return false; }
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) { return false; }
		for (let i = 0; i < a.length; i++) {
			if (!deepEqual(a[i], b[i])) { return false; }
		}
		return true;
	}
	if (Array.isArray(b)) { return false; }
	const ak = Object.keys(a as object);
	const bk = Object.keys(b as object);
	if (ak.length !== bk.length) { return false; }
	for (const k of ak) {
		if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) { return false; }
	}
	return true;
}

function mergeChat(prev: Chat | undefined, next: Chat): Chat {
	if (!prev) { return next; }
	const prevById = new Map<string, ChatMessage>();
	for (const m of prev.messages) { prevById.set(m.id, m); }
	let same = prev.messages.length === next.messages.length;
	const messages = next.messages.map((m, i) => {
		const old = prevById.get(m.id);
		if (old && deepEqual(old, m)) {
			if (prev.messages[i] !== old) { same = false; }
			return old;
		}
		same = false;
		return m;
	});
	const todos = deepEqual(prev.todos, next.todos) ? prev.todos : next.todos;
	const queued = deepEqual(prev.queued, next.queued) ? prev.queued : next.queued;
	const contextUsage = deepEqual(prev.contextUsage, next.contextUsage) ? prev.contextUsage : next.contextUsage;
	if (
		same && todos === prev.todos && queued === prev.queued && contextUsage === prev.contextUsage &&
		prev.title === next.title && prev.mode === next.mode && prev.modelId === next.modelId && prev.status === next.status &&
		prev.updatedAt === next.updatedAt
	) {
		return prev;
	}
	return { ...next, messages: same ? prev.messages : messages, todos, queued, contextUsage };
}

function applyCarry(s: State, chatId: string): State {
	if (!s.carry.length) { return s; }
	const existing = s.contexts[chatId] ?? [];
	return { ...s, carry: [], contexts: { ...s.contexts, [chatId]: [...existing, ...s.carry] } };
}

function clearOverrides(s: State, chat: Chat, prev?: Chat): State {
	const o = s.overrides[chat.id];
	if (!o) { return s; }
	const next: Overrides = {};
	if (o.mode && o.mode !== chat.mode) { next.mode = o.mode; }
	// When the host moves the chat to another model (a swap to the user's subscription, a retry on a
	// different model), its choice is newer than the one held in the composer.
	const hostMoved = !!prev && prev.modelId !== chat.modelId;
	if (o.modelId && o.modelId !== chat.modelId && !hostMoved) { next.modelId = o.modelId; }
	if (next.mode === o.mode && next.modelId === o.modelId) { return s; }
	return { ...s, overrides: { ...s.overrides, [chat.id]: next } };
}

export function reducer(s: State, a: Action): State {
	switch (a.kind) {
		case 'view':
			return { ...s, view: a.view };
		case 'draft':
			return { ...s, drafts: { ...s.drafts, [a.chatId]: a.text } };
		case 'contexts':
			return { ...s, contexts: { ...s.contexts, [a.chatId]: a.items } };
		case 'override':
			return { ...s, overrides: { ...s.overrides, [a.chatId]: { ...s.overrides[a.chatId], ...a.o } } };
		case 'dismissSuggest':
			return { ...s, dismissedSuggest: { ...s.dismissedSuggest, [a.chatId]: a.id } };
		case 'connectHidden':
			return { ...s, connectHidden: a.hidden };
		case 'host':
			return hostReducer(s, a.m);
	}
}

function hostReducer(s: State, m: HostMessageExt): State {
	switch (m.type) {
		case 'init': {
			const chats = { ...s.chats, [m.activeChat.id]: mergeChat(s.chats[m.activeChat.id], m.activeChat) };
			let n: State = {
				...s, ready: true, chats, summaries: m.chats, openIds: m.openChatIds, activeId: m.activeChat.id,
				models: m.models, settings: m.settings, pendingEdits: m.pendingEdits, workspaceName: m.workspaceName,
			};
			n = clearOverrides(n, m.activeChat);
			return applyCarry(n, m.activeChat.id);
		}
		case 'chat': {
			const merged = mergeChat(s.chats[m.chat.id], m.chat);
			if (merged === s.chats[m.chat.id]) { return s; }
			let n: State = { ...s, chats: { ...s.chats, [m.chat.id]: merged } };
			n = clearOverrides(n, merged, s.chats[m.chat.id]);
			if (!s.chats[m.chat.id] && s.carry.length && (n.activeId === m.chat.id || !n.activeId)) {
				n = applyCarry(n, m.chat.id);
			}
			return n;
		}
		case 'chats': {
			// Drop cached chats the host no longer lists.
			const ids = new Set(m.chats.map(c => c.id));
			const chats: Record<string, Chat> = {};
			for (const [id, c] of Object.entries(s.chats)) { if (ids.has(id)) { chats[id] = c; } }
			return { ...s, summaries: m.chats, openIds: m.openChatIds, chats };
		}
		case 'activeChat': {
			if (s.activeId === m.chatId) { return { ...s, view: 'chat' }; }
			return applyCarry({ ...s, activeId: m.chatId, view: 'chat' }, m.chatId);
		}
		case 'models':
			return { ...s, models: m.models };
		case 'settings':
			return { ...s, settings: m.settings };
		case 'pendingEdits':
			return { ...s, pendingEdits: m.files };
		case 'slashCommands':
			return { ...s, slash: m.commands };
		case 'activeEditor':
			return { ...s, activeFile: m.item };
		case 'agents':
			return { ...s, agents: m.agents };
		case 'connectState':
			return { ...s, local: m.local, providers: m.providers };
		case 'connectResult':
			return { ...s, connectResults: { ...s.connectResults, [m.target]: { ok: m.ok, message: m.message } } };
		case 'addContext': {
			const id = s.activeId;
			if (m.newChat || !id) { return { ...s, carry: [...s.carry, m.item], view: 'chat' }; }
			const cur = s.contexts[id] ?? [];
			if (cur.some(c => c.id === m.item.id || (c.uri && c.uri === m.item.uri && c.label === m.item.label))) { return { ...s, view: 'chat' }; }
			return { ...s, contexts: { ...s.contexts, [id]: [...cur, m.item] }, view: 'chat' };
		}
		case 'focusInput': {
			let n: State = { ...s, view: 'chat', focusNonce: s.focusNonce + 1, focusText: m.text };
			if (m.text !== undefined && s.activeId) { n = { ...n, drafts: { ...n.drafts, [s.activeId]: m.text } }; }
			return n;
		}
		case 'showHistory':
			return { ...s, view: 'history' };
		case 'showConnect':
			return { ...s, view: 'chat', connectHidden: false };
		case 'mentionResults':
			return s; // consumed by the composer through a subscription
	}
}

export function lastAssistant(chat: Chat): Extract<ChatMessage, { role: 'assistant' }> | undefined {
	for (let i = chat.messages.length - 1; i >= 0; i--) {
		const m = chat.messages[i];
		if (m.role === 'assistant') { return m; }
	}
	return undefined;
}
