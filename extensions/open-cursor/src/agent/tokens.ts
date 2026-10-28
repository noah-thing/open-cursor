/*---------------------------------------------------------------------------------------------
 *  Open Cursor. MIT License.
 *  Token estimation and transcript compaction helpers. Pure.
 *--------------------------------------------------------------------------------------------*/

import type { LLMContent, LLMMessage, ToolSchema } from '../providers/types';

export const CHARS_PER_TOKEN = 3.5;
const IMAGE_TOKENS = 1500;

export function estimateTextTokens(s: string): number {
	return Math.ceil(s.length / CHARS_PER_TOKEN);
}

export function estimateContentTokens(c: LLMContent): number {
	switch (c.type) {
		case 'text': return estimateTextTokens(c.text);
		case 'thinking': return estimateTextTokens(c.text);
		case 'image': return IMAGE_TOKENS;
		case 'tool_use': return estimateTextTokens(c.name) + estimateTextTokens(JSON.stringify(c.input ?? {}));
		case 'tool_result': return estimateTextTokens(c.content) + (c.images?.length ?? 0) * IMAGE_TOKENS;
	}
}

export function estimateMessagesTokens(messages: readonly LLMMessage[]): number {
	let n = 0;
	for (const m of messages) {
		n += 4;
		for (const c of m.content) { n += estimateContentTokens(c); }
	}
	return n;
}

export function estimateToolsTokens(tools: readonly ToolSchema[] | undefined): number {
	return tools ? estimateTextTokens(JSON.stringify(tools)) : 0;
}

export function estimateRequestTokens(system: string, messages: readonly LLMMessage[], tools?: readonly ToolSchema[]): number {
	return estimateTextTokens(system) + estimateMessagesTokens(messages) + estimateToolsTokens(tools);
}

/** Keep head and tail of an oversized string. */
export function capText(s: string, maxChars: number): string {
	if (s.length <= maxChars) { return s; }
	const head = Math.floor(maxChars * 0.65);
	const tail = maxChars - head;
	return `${s.slice(0, head)}\n[... ${s.length - maxChars} characters truncated ...]\n${s.slice(s.length - tail)}`;
}

/** Returns copies of messages where tool results older than the last `keepRecent` messages are shortened. */
export function pruneOldToolResults(messages: readonly LLMMessage[], keepRecent: number, maxChars: number): LLMMessage[] {
	const cutoff = messages.length - keepRecent;
	return messages.map((m, i) => {
		if (i >= cutoff || m.role !== 'user') { return m; }
		let changed = false;
		const content = m.content.map((c): LLMContent => {
			if (c.type === 'tool_result' && (c.content.length > maxChars || c.images?.length)) {
				changed = true;
				return { ...c, content: capText(c.content, maxChars), images: undefined };
			}
			return c;
		});
		return changed ? { role: m.role, content } : m;
	});
}

function isToolResultOnly(m: LLMMessage): boolean {
	return m.role === 'user' && m.content.length > 0 && m.content.every(c => c.type === 'tool_result');
}

/** A user message that starts a new turn (carries user authored text, not just tool results). */
export function isTurnStart(m: LLMMessage): boolean {
	return m.role === 'user' && !isToolResultOnly(m);
}

/**
 * Chooses where to cut for summarisation: messages[0..split) are summarised, [split..] kept verbatim.
 * Prefers keeping the last `keepTurns` user turns; falls back to keeping the last `keepMessages` messages
 * cutting at an assistant message so tool_use/tool_result pairs stay intact. Returns undefined when
 * there is nothing worth summarising.
 */
export function chooseSplit(messages: readonly LLMMessage[], keepTurns = 3, keepMessages = 8): number | undefined {
	let seen = 0;
	let split = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isTurnStart(messages[i])) {
			seen++;
			if (seen === keepTurns) { split = i; break; }
		}
	}
	if (split >= 3) { return split; }
	for (let i = messages.length - keepMessages; i >= 2; i--) {
		if (messages[i].role === 'assistant') { return i; }
	}
	return undefined;
}

/** Combines a summary with the kept tail into a valid alternating transcript. */
export function applySummary(summary: string, kept: readonly LLMMessage[]): LLMMessage[] {
	const note: LLMContent = { type: 'text', text: `<conversation_summary>\n${summary}\n</conversation_summary>\nThe earlier part of this conversation was summarised above to save space. Continue from there.` };
	const first = kept[0];
	if (first && first.role === 'user') {
		return [{ role: 'user', content: [note, ...first.content] }, ...kept.slice(1)];
	}
	return [{ role: 'user', content: [note] }, ...kept];
}

/** Renders messages as plain text for the summariser prompt. */
export function renderForSummary(messages: readonly LLMMessage[], maxChars = 120000): string {
	const parts: string[] = [];
	for (const m of messages) {
		const lines: string[] = [];
		for (const c of m.content) {
			switch (c.type) {
				case 'text': lines.push(c.text); break;
				case 'tool_use': lines.push(`[tool call ${c.name} ${capText(JSON.stringify(c.input ?? {}), 600)}]`); break;
				case 'tool_result': lines.push(`[tool result${c.isError ? ' (error)' : ''}: ${capText(c.content, 700)}]`); break;
				case 'image': lines.push('[image]'); break;
				case 'thinking': break;
			}
		}
		parts.push(`${m.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${lines.join('\n')}`);
	}
	return capText(parts.join('\n\n'), maxChars);
}

/** Appends blocks to the final user message, or adds a new user message. Keeps tool_result blocks first. */
export function appendUserContent(messages: LLMMessage[], blocks: LLMContent[]): void {
	const last = messages[messages.length - 1];
	if (last && last.role === 'user') {
		messages[messages.length - 1] = { role: 'user', content: [...last.content, ...blocks] };
	} else {
		messages.push({ role: 'user', content: blocks });
	}
}

/** Last `maxLines` lines (and at most `maxChars` characters) of a command's output. */
export function tailLines(output: string, maxLines = 200, maxChars = 30000): string {
	const lines = output.replace(/\r\n/g, '\n').split('\n');
	let dropped = 0;
	let out = lines;
	if (lines.length > maxLines) {
		dropped = lines.length - maxLines;
		out = lines.slice(-maxLines);
	}
	let text = out.join('\n');
	if (text.length > maxChars) {
		text = text.slice(-maxChars);
		text = text.slice(text.indexOf('\n') + 1);
		dropped = Math.max(dropped, 1);
	}
	return dropped ? `[earlier output truncated]\n${text}` : text;
}
