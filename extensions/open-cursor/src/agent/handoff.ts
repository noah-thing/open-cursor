/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Moving a chat to another model without losing anything. A command line agent keeps its own
 *  session, so when the chat continues somewhere it has not been, it gets a written account of
 *  everything so far: what was asked, what was answered, and every file and command touched.
 *--------------------------------------------------------------------------------------------*/

import type { ChatMessage, ToolPart, TodoItem } from '../shared/protocol';

/** Usage limits, rate limits and spent credits, as providers and CLIs phrase them. */
export function isLimitError(message: string): boolean {
	return /\brate[ -]?limit|\b429\b|quota|usage limit|limit reached|too many requests|insufficient[ _]?(credits|quota|balance)|credit balance|out of credits|exceeded your|resource[ _]exhausted|overloaded/i.test(message);
}

/** One line for one tool call, in the past tense; undefined for steps that did not happen. */
export function actionLine(p: ToolPart): string | undefined {
	if (p.status === 'streaming' || p.status === 'awaiting-approval' || p.status === 'rejected' || p.status === 'cancelled') { return undefined; }
	const failed = p.status === 'error' ? ' (failed)' : '';
	if (p.edit) {
		const verb = p.edit.deleted ? 'Deleted' : p.edit.isNew ? 'Created' : 'Edited';
		return `${verb} ${p.edit.path}${p.edit.deleted ? '' : ` (+${p.edit.added} -${p.edit.removed})`}${failed}`;
	}
	if (p.command) { return `Ran \`${p.command.text.split('\n')[0].slice(0, 160)}\`${failed}`; }
	const title = p.title.trim();
	return title ? title + failed : undefined;
}

function clip(s: string, n: number): string {
	return s.length > n ? s.slice(0, n) + ' [...]' : s;
}

/** The exchanges as text blocks, oldest first. */
function exchanges(messages: readonly ChatMessage[]): string[] {
	const out: string[] = [];
	for (const m of messages) {
		if (m.role === 'user') {
			const ctx = m.context.length ? ` [attached: ${m.context.map(c => c.label).join(', ')}]` : '';
			out.push(`User: ${clip(m.text.trim(), 4000)}${ctx}`);
			continue;
		}
		const lines: string[] = [];
		const actions: string[] = [];
		const flush = (): void => { if (actions.length) { lines.push('Actions: ' + actions.join('; ')); actions.length = 0; } };
		for (const p of m.parts) {
			if (p.type === 'text' && p.text.trim()) { flush(); lines.push(clip(p.text.trim(), 2500)); }
			else if (p.type === 'tool' && p.name !== 'summarize') { const a = actionLine(p); if (a) { actions.push(a); } }
			else if (p.type === 'error') { flush(); lines.push(`(Stopped with an error: ${clip(p.message, 300)})`); }
		}
		flush();
		if (lines.length) { out.push(`Assistant${m.modelId ? ` (${m.modelId})` : ''}:\n${lines.join('\n')}`); }
	}
	return out;
}

/**
 * Everything a model needs to carry on a conversation that ran elsewhere. Newest exchanges win when it
 * does not all fit in `maxChars`. `since` frames it as an update to a session the model already has.
 */
export function handoffBrief(messages: readonly ChatMessage[], opts: { todos?: readonly TodoItem[]; maxChars?: number; since?: boolean } = {}): string {
	const max = opts.maxChars ?? 40_000;
	const all = exchanges(messages);
	if (!all.length) { return ''; }
	const kept: string[] = [];
	let size = 0;
	for (let i = all.length - 1; i >= 0; i--) {
		if (size + all[i].length > max && kept.length) { break; }
		kept.unshift(all[i]);
		size += all[i].length;
	}
	const dropped = all.length - kept.length;
	const todos = opts.todos?.length ? '\n\nTo-do list so far:\n' + opts.todos.map(t => `- [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`).join('\n') : '';
	const head = opts.since
		? 'Since your last turn, this conversation continued with another model. Here is what happened, so you are up to date:'
		: 'This conversation started with another model and continues with you now. Here is everything so far, so you can pick up exactly where it left off:';
	return [
		'<conversation_so_far>',
		head,
		'File changes and commands listed below already happened; the files on disk include them. Do not redo them.',
		dropped ? `(${dropped} earlier exchange${dropped === 1 ? '' : 's'} left out for length.)` : '',
		'',
		kept.join('\n\n') + todos,
		'</conversation_so_far>',
	].filter((l, i) => l !== '' || i === 4).join('\n');
}

/** The user messages whose turns the stored model transcript does not include, before the current one. */
export function missingTurns(messages: readonly ChatMessage[], transcriptTurns: ReadonlySet<string>): number {
	let n = 0;
	for (const m of messages) { if (m.role === 'user' && !transcriptTurns.has(m.id)) { n++; } }
	return n;
}
