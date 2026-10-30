/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Tool call ids come from whichever provider answered; another provider may reject them.
 *--------------------------------------------------------------------------------------------*/

import type { LLMContent, LLMMessage } from './types';

const ALNUM = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function hash(s: string, salt: number): number {
	let h = 2166136261 ^ salt;
	for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 16777619); }
	return h >>> 0;
}

/** `len` letters and digits derived from `s`; the same input always gives the same output. */
function alnum(s: string, len: number, salt: number): string {
	let out = '';
	for (let i = 0; out.length < len; i++) { out += ALNUM[hash(s + '#' + i, salt + i) % ALNUM.length]; }
	return out;
}

export type IdRule = 'mistral' | 'anthropic';

function convert(id: string, rule: IdRule, salt: number): string {
	if (rule === 'mistral') { return /^[a-zA-Z0-9]{9}$/.test(id) && salt === 0 ? id : alnum(id, 9, salt); }
	const clean = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
	if (clean && clean === id && salt === 0) { return id; }
	return salt === 0 && clean ? clean : (clean.slice(0, 50) || 'call') + '_' + alnum(id, 8, salt);
}

/**
 * Copies `messages` with every tool call id rewritten into the format `rule` accepts. A call and its
 * result always get the same new id, and two different ids never end up the same.
 * Mistral: exactly 9 letters or digits. Anthropic: `^[a-zA-Z0-9_-]+$`, at most 64 characters.
 */
export function remapToolIds(messages: LLMMessage[], rule: IdRule): LLMMessage[] {
	const map = new Map<string, string>();
	const taken = new Map<string, string>();
	const to = (id: string): string => {
		let v = map.get(id);
		if (v !== undefined) { return v; }
		for (let salt = 0; ; salt++) {
			v = convert(id, rule, salt);
			if (!taken.has(v) || taken.get(v) === id) { break; }
		}
		map.set(id, v); taken.set(v, id);
		return v;
	};
	const touches = (c: LLMContent): boolean => c.type === 'tool_use' || c.type === 'tool_result';
	return messages.map(m => m.content.some(touches) ? {
		...m,
		content: m.content.map((c): LLMContent => c.type === 'tool_use' ? { ...c, id: to(c.id) } : c.type === 'tool_result' ? { ...c, toolUseId: to(c.toolUseId) } : c),
	} : m);
}
