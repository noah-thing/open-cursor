/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  How to ask a provider whether a typed API key works. No VS Code imports, so it can be tested alone.
 *--------------------------------------------------------------------------------------------*/

import type { ProviderId } from '../providers/types';

/** How to ask a provider whether a key works: a cheap authenticated GET. */
export function keyCheckRequest(id: ProviderId, key: string): { url: string; headers: Record<string, string> } | undefined {
	const bearer = { authorization: `Bearer ${key}` };
	switch (id) {
		case 'anthropic': return { url: 'https://api.anthropic.com/v1/models', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } };
		case 'openai': return { url: 'https://api.openai.com/v1/models', headers: bearer };
		case 'google': return { url: 'https://generativelanguage.googleapis.com/v1beta/models', headers: { 'x-goog-api-key': key } };
		case 'openrouter': return { url: 'https://openrouter.ai/api/v1/auth/key', headers: bearer };
		case 'xai': return { url: 'https://api.x.ai/v1/models', headers: bearer };
		case 'deepseek': return { url: 'https://api.deepseek.com/models', headers: bearer };
		case 'mistral': return { url: 'https://api.mistral.ai/v1/models', headers: bearer };
		case 'groq': return { url: 'https://api.groq.com/openai/v1/models', headers: bearer };
		default: return undefined;
	}
}

/** Only a clear "wrong key" answer counts as refused; anything odd (busy, down, a 403 from a restricted key or a network block) is not the key's fault. */
export function judgeKeyStatus(id: ProviderId, status: number): 'ok' | 'refused' | 'unsure' {
	if (status >= 200 && status < 300) { return 'ok'; }
	if (status === 401 || (id === 'google' && status === 400)) { return 'refused'; }
	return 'unsure';
}
