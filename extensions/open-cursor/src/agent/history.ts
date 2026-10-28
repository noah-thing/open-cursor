/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Transcript model and rebuilding model history from UI chat messages. Pure.
 *--------------------------------------------------------------------------------------------*/

import type { LLMContent, LLMMessage } from '../providers/types';
import type { ChatMessage } from '../shared/protocol';

/** One LLM message plus the id of the UI user message whose turn it belongs to. */
export interface TranscriptEntry {
	readonly turn: string;
	readonly msg: LLMMessage;
}

export function transcriptMessages(entries: readonly TranscriptEntry[]): LLMMessage[] {
	return entries.map(e => e.msg);
}

/** Drops every entry from the turn of `messageId` onward. Returns undefined when the turn is not in the transcript. */
export function truncateTranscript(entries: readonly TranscriptEntry[], messageId: string): TranscriptEntry[] | undefined {
	const idx = entries.findIndex(e => e.turn === messageId);
	return idx === -1 ? undefined : entries.slice(0, idx);
}

/**
 * Approximates the model-facing history from UI messages. Used when no raw transcript exists for a
 * chat or a turn (old chats, after compaction removed a turn). Tool calls are replayed from their parts.
 */
export function buildHistoryFromChat(messages: readonly ChatMessage[]): TranscriptEntry[] {
	const out: TranscriptEntry[] = [];
	let turn = '';
	for (const m of messages) {
		if (m.role === 'user') {
			turn = m.id;
			const ctx = m.context.length ? `[Attached: ${m.context.map(c => c.label).join(', ')}]\n` : '';
			out.push({ turn, msg: { role: 'user', content: [{ type: 'text', text: ctx + m.text }] } });
			continue;
		}
		let blocks: LLMContent[] = [];
		let results: LLMContent[] = [];
		const flush = (): void => {
			if (blocks.length) {
				out.push({ turn, msg: { role: 'assistant', content: blocks } });
				if (results.length) {
					out.push({ turn, msg: { role: 'user', content: results } });
				}
			}
			blocks = [];
			results = [];
		};
		for (const p of m.parts) {
			if (p.type === 'text') {
				if (results.length) { flush(); }
				if (p.text.trim()) { blocks.push({ type: 'text', text: p.text }); }
			} else if (p.type === 'tool') {
				if (p.name === 'summarize') { continue; }
				if (p.status === 'streaming' || p.status === 'awaiting-approval' || p.status === 'running') { continue; }
				blocks.push({ type: 'tool_use', id: p.id, name: p.name, input: p.args ?? {} });
				const failed = p.status === 'error' || p.status === 'rejected' || p.status === 'cancelled';
				results.push({ type: 'tool_result', toolUseId: p.id, content: p.output ?? p.title, isError: failed || undefined });
			}
		}
		flush();
	}
	return ensureValid(out);
}

/** Makes sure the history starts with a user message and has no dangling tool calls. */
export function ensureValid(entries: TranscriptEntry[]): TranscriptEntry[] {
	const res = entries.slice();
	while (res.length && res[0].msg.role !== 'user') { res.shift(); }
	// every tool_use must be answered by the next message
	for (let i = 0; i < res.length; i++) {
		const m = res[i].msg;
		if (m.role !== 'assistant') { continue; }
		const uses = m.content.filter(c => c.type === 'tool_use');
		if (!uses.length) { continue; }
		const next = res[i + 1]?.msg;
		const answered = new Set(next && next.role === 'user' ? next.content.filter(c => c.type === 'tool_result').map(c => (c as { toolUseId: string }).toolUseId) : []);
		const missing = uses.filter(u => !answered.has((u as { id: string }).id));
		if (missing.length) {
			const fill: LLMContent[] = missing.map(u => ({ type: 'tool_result', toolUseId: (u as { id: string }).id, content: 'Cancelled before it ran.', isError: true }));
			if (next && next.role === 'user') {
				res[i + 1] = { turn: res[i + 1].turn, msg: { role: 'user', content: [...fill, ...next.content] } };
			} else {
				res.splice(i + 1, 0, { turn: res[i].turn, msg: { role: 'user', content: fill } });
			}
		}
	}
	return res;
}
