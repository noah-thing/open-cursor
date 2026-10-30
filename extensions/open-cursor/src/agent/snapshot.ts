/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Keeps the chat snapshots posted to the webview small while a turn streams: live command output is capped
 *  to its tail, and pasted images and long finished outputs travel once per webview, then are left out.
 *--------------------------------------------------------------------------------------------*/

import type { Chat, ChatMessage, ContextItem, MessagePart, ToolPart } from '../shared/protocol';

/** A running command shows its last 20k characters; the full text arrives when it finishes. */
export const LIVE_OUTPUT_CAP = 20_000;
/** Finished output longer than this is sent once and referenced after. */
const SEND_ONCE_OVER = 20_000;

export class SnapshotTrimmer {
	private readonly sent = new Map<string, number>();

	/** The webview was (re)loaded and has none of it. */
	reset(): void { this.sent.clear(); }

	trim(chat: Chat): Chat {
		let changed = false;
		const messages = chat.messages.map((m): ChatMessage => {
			const next = this.trimMessage(chat.id, m);
			if (next !== m) { changed = true; }
			return next;
		});
		return changed ? { ...chat, messages } : chat;
	}

	private trimMessage(chatId: string, m: ChatMessage): ChatMessage {
		if (m.role === 'user') {
			if (!m.context.some(c => c.kind === 'image' && c.content)) { return m; }
			const context = m.context.map((c): ContextItem => {
				if (c.kind !== 'image' || !c.content) { return c; }
				const key = `${chatId}/${m.id}/${c.id}`;
				if (this.sent.has(key)) { return { ...c, content: undefined }; }
				this.sent.set(key, c.content.length);
				return c;
			});
			return { ...m, context };
		}
		if (!m.parts.some(p => p.type === 'tool' && p.output && p.output.length > SEND_ONCE_OVER)) { return m; }
		const parts = m.parts.map((p): MessagePart => {
			if (p.type !== 'tool' || !p.output || p.output.length <= SEND_ONCE_OVER) { return p; }
			return this.trimTool(`${chatId}/${m.id}/${p.id}`, p);
		});
		return { ...m, parts };
	}

	private trimTool(key: string, p: ToolPart): ToolPart {
		const output = p.output!;
		if (p.status === 'running' || p.status === 'streaming' || p.status === 'awaiting-approval') {
			return { ...p, output: '…' + output.slice(-LIVE_OUTPUT_CAP) };
		}
		if (this.sent.get(key) === output.length) { return { ...p, output: undefined, outputKept: true }; }
		this.sent.set(key, output.length);
		return p;
	}
}

/**
 * Webview side: puts back what the host left out because this webview already received it
 * (image data, long finished tool output), taking it from the previous copy of the chat.
 */
export function restoreOmitted(prev: Chat | undefined, next: Chat): Chat {
	if (!prev) { return next; }
	let prevById: Map<string, ChatMessage> | undefined;
	let changed = false;
	const messages = next.messages.map((m): ChatMessage => {
		if (m.role === 'user') {
			if (!m.context.some(c => c.kind === 'image' && !c.content)) { return m; }
			prevById ??= new Map(prev.messages.map(x => [x.id, x]));
			const old = prevById.get(m.id);
			if (!old || old.role !== 'user') { return m; }
			const context = m.context.map((c): ContextItem => {
				if (c.kind !== 'image' || c.content) { return c; }
				const was = old.context.find(o => o.id === c.id);
				return was?.content ? { ...c, content: was.content } : c;
			});
			changed = true;
			return { ...m, context };
		}
		if (!m.parts.some(p => p.type === 'tool' && p.outputKept)) { return m; }
		prevById ??= new Map(prev.messages.map(x => [x.id, x]));
		const old = prevById.get(m.id);
		const parts = m.parts.map((p): MessagePart => {
			if (p.type !== 'tool' || !p.outputKept) { return p; }
			const was = old?.role === 'assistant' ? old.parts.find(o => o.type === 'tool' && o.id === p.id) as ToolPart | undefined : undefined;
			const { outputKept: _kept, ...rest } = p;
			void _kept;
			return was?.output ? { ...rest, output: was.output } : rest;
		});
		changed = true;
		return { ...m, parts };
	});
	return changed ? { ...next, messages } : next;
}
