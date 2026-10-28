/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { ChatMode, ChatSummary, ContextKind } from '../../../src/shared/protocol';
import type { IconName } from '../common/icons';

export function basename(p: string): string {
	const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
	return i >= 0 ? p.slice(i + 1) : p;
}

export function dirname(p: string): string {
	const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
	return i > 0 ? p.slice(0, i) : '';
}

export function formatDuration(ms: number | undefined): string {
	if (ms === undefined) { return ''; }
	if (ms < 950) { return ms < 100 ? '' : (ms / 1000).toFixed(1) + 's'; }
	const s = Math.round(ms / 1000);
	if (s < 60) { return s + 's'; }
	return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) { return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'; }
	if (n >= 1000) { return (n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '') + 'k'; }
	return String(n);
}

export function relativeTime(ts: number, now = Date.now()): string {
	const s = Math.max(0, Math.round((now - ts) / 1000));
	if (s < 60) { return 'now'; }
	const m = Math.round(s / 60);
	if (m < 60) { return m + 'm'; }
	const h = Math.round(m / 60);
	if (h < 24) { return h + 'h'; }
	const d = Math.round(h / 24);
	if (d < 30) { return d + 'd'; }
	return Math.round(d / 30) + 'mo';
}

export type HistoryGroup = 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older';

export function groupHistory(chats: readonly ChatSummary[], now = Date.now()): { label: HistoryGroup; items: ChatSummary[] }[] {
	const startOfToday = new Date(now);
	startOfToday.setHours(0, 0, 0, 0);
	const t0 = startOfToday.getTime();
	const day = 86_400_000;
	const buckets: Record<HistoryGroup, ChatSummary[]> = { 'Today': [], 'Yesterday': [], 'Previous 7 days': [], 'Older': [] };
	for (const c of [...chats].sort((a, b) => b.updatedAt - a.updatedAt)) {
		if (c.updatedAt >= t0) { buckets['Today'].push(c); }
		else if (c.updatedAt >= t0 - day) { buckets['Yesterday'].push(c); }
		else if (c.updatedAt >= t0 - 7 * day) { buckets['Previous 7 days'].push(c); }
		else { buckets['Older'].push(c); }
	}
	return (Object.keys(buckets) as HistoryGroup[]).filter(k => buckets[k].length).map(label => ({ label, items: buckets[label] }));
}

/** Subsequence fuzzy score; higher is better, -1 means no match. */
export function fuzzyScore(query: string, text: string): number {
	if (!query) { return 0; }
	const q = query.toLowerCase();
	const t = text.toLowerCase();
	const idx = t.indexOf(q);
	if (idx >= 0) { return 100 - idx - (t.length - q.length) * 0.1 + (idx === 0 ? 20 : 0); }
	let ti = 0;
	let score = 0;
	let last = -2;
	for (const ch of q) {
		const f = t.indexOf(ch, ti);
		if (f < 0) { return -1; }
		score += f === last + 1 ? 3 : 1;
		last = f;
		ti = f + 1;
	}
	return score;
}

export const MODE_META: Record<ChatMode, { label: string; icon: IconName; hint: string; placeholder: string }> = {
	agent: { label: 'Agent', icon: 'infinity', hint: 'Edits and runs code, keeps a todo list, checks its work', placeholder: 'Plan, search, build anything' },
	plan: { label: 'Plan', icon: 'todos', hint: 'Read-only. Researches, writes a plan, then you press Build', placeholder: 'Describe what you want to plan' },
	debug: { label: 'Debug', icon: 'bug', hint: 'Reproduces, tests hypotheses, fixes, removes its logging', placeholder: 'Describe the bug' },
	ask: { label: 'Ask', icon: 'chat', hint: 'Read-only. Answers about your code with file links', placeholder: 'Ask about your code' },
};

export const MODE_ORDER: ChatMode[] = ['agent', 'plan', 'debug', 'ask'];

export const KIND_ICON: Record<ContextKind, IconName> = {
	file: 'file', folder: 'folder', code: 'code', selection: 'code', terminal: 'terminal', git: 'git', web: 'globe',
	docs: 'book', rule: 'rule', chat: 'chat', lints: 'warning', image: 'image',
};

export const KIND_LABEL: Record<ContextKind, string> = {
	file: 'Files', folder: 'Folders', code: 'Code', selection: 'Selection', terminal: 'Terminal', git: 'Git', web: 'Web',
	docs: 'Docs', rule: 'Rules', chat: 'Past chats', lints: 'Lints', image: 'Images',
};

export const PROVIDER_LABEL: Record<string, string> = {
	anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', openrouter: 'OpenRouter', deepseek: 'DeepSeek', xai: 'xAI',
	mistral: 'Mistral', groq: 'Groq', ollama: 'Ollama', lmstudio: 'LM Studio', custom: 'Custom', cli: 'Your subscriptions',
};

export function providerLabel(p: string): string {
	return PROVIDER_LABEL[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
}

let idCounter = 0;
export function localId(prefix: string): string {
	idCounter += 1;
	return prefix + '-' + Date.now().toString(36) + '-' + idCounter;
}
