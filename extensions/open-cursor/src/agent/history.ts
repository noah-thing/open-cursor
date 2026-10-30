/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Transcript model and model history rebuilt from UI messages. Pure.
 *--------------------------------------------------------------------------------------------*/

import type { LLMContent, LLMMessage } from '../providers/types';
import type { ChatMessage } from '../shared/protocol';
import { actionLine } from './handoff';

/** One LLM message plus the id of the UI user message whose turn it belongs to. */
export interface TranscriptEntry {
	readonly turn: string;
	readonly msg: LLMMessage;
	/** Later user messages folded into this entry because the turn before them left no reply (see mergeUserEntry). */
	readonly merged?: readonly { turn: string; content: LLMContent[] }[];
}

/**
 * Adds a user message to the transcript. When the last entry is a user message (the turn before failed
 * without a reply) the two share one model message, but the entry remembers which text came from which turn
 * so that editing the newer message can cut exactly its text. Returns the new last entry.
 */
export function mergeUserEntry(entries: TranscriptEntry[], turn: string, content: LLMContent[]): TranscriptEntry {
	const last = entries[entries.length - 1];
	if (last && last.msg.role === 'user') {
		const merged = last.turn === turn ? last.merged : [...(last.merged ?? []), { turn, content }];
		const e: TranscriptEntry = { turn: last.turn, msg: { role: 'user', content: [...last.msg.content, ...content] }, ...(merged ? { merged } : {}) };
		entries[entries.length - 1] = e;
		return e;
	}
	const e: TranscriptEntry = { turn, msg: { role: 'user', content } };
	entries.push(e);
	return e;
}

export function transcriptMessages(entries: readonly TranscriptEntry[]): LLMMessage[] {
	return entries.map(e => e.msg);
}

/** Drops every entry from the turn of `messageId` onward. Returns undefined when the turn is not in the transcript. */
export function truncateTranscript(entries: readonly TranscriptEntry[], messageId: string): TranscriptEntry[] | undefined {
	const idx = entries.findIndex(e => e.turn === messageId);
	if (idx !== -1) { return entries.slice(0, idx); }
	// the message was merged into an earlier user entry: keep that entry with only the text before it
	const at = entries.findIndex(e => e.merged?.some(x => x.turn === messageId));
	if (at === -1) { return undefined; }
	const e = entries[at];
	const merged = e.merged!;
	const k = merged.findIndex(x => x.turn === messageId);
	const extra = merged.reduce((n, x) => n + x.content.length, 0);
	const base = e.msg.content.slice(0, e.msg.content.length - extra);
	const kept = merged.slice(0, k);
	const content = [...base, ...kept.flatMap(x => x.content)];
	return [...entries.slice(0, at), { turn: e.turn, msg: { role: 'user', content }, ...(kept.length ? { merged: kept } : {}) }];
}

/**
 * Approximates the model facing history from UI messages. Used when no raw transcript exists for a
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
		// A turn a command line agent ran used its own tools, which this model does not have: it reads as
		// text, with one line per file changed and command run, instead of tool calls it cannot match.
		if (m.modelId?.startsWith('cli:')) {
			const lines: string[] = [];
			const acts: string[] = [];
			for (const p of m.parts) {
				if (p.type === 'text' && p.text.trim()) { if (acts.length) { lines.push('[' + acts.splice(0).join('; ') + ']'); } lines.push(p.text.trim()); }
				else if (p.type === 'tool') { const a = actionLine(p); if (a) { acts.push(a); } }
			}
			if (acts.length) { lines.push('[' + acts.join('; ') + ']'); }
			if (lines.length) { out.push({ turn, msg: { role: 'assistant', content: [{ type: 'text', text: lines.join('\n\n') }] } }); }
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
