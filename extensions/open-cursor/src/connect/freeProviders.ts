/*---------------------------------------------------------------------------------------------
 *  OpenCursor. MIT License.
 *  Links, steps and limits were checked on each provider's own pages on 2026-10-28.
 *--------------------------------------------------------------------------------------------*/

import type { ProviderId } from '../providers/types';

export interface FreeProviderSpec {
	readonly id: Exclude<ProviderId, 'free'>;
	readonly name: string;
	/** The page where a new person makes an account. */
	readonly signupUrl: string;
	/** The page where the key is created. */
	readonly keyUrl: string;
	/** What to do on the key page, in the provider's own button words. */
	readonly steps: readonly string[];
	readonly models: readonly string[];
	readonly limits: string;
	readonly privacy?: { readonly tone: 'good' | 'note'; readonly text: string };
	/** Source of a regex for the key, used to spot it on the clipboard. */
	readonly keyPattern?: string;
	/** How to prove a key works: a cheap authenticated call. */
	readonly verify: { readonly method: 'GET'; readonly url: string; readonly header: 'bearer' | 'goog' } | { readonly method: 'POST'; readonly url: string; readonly model: string };
	/** One click sign in instead of a pasted key. */
	readonly oauth?: boolean;
}

export const FREE_PROVIDERS: readonly FreeProviderSpec[] = [
	{
		id: 'openrouter', name: 'OpenRouter', oauth: true,
		signupUrl: 'https://openrouter.ai/sign-in', keyUrl: 'https://openrouter.ai/settings/keys',
		steps: ['Sign in', 'Click Create API Key', 'Copy the key'],
		models: ['Nemotron 3 Ultra', 'Poolside Laguna S 2.1', 'North Mini Code'],
		limits: '20 a minute, 50 a day',
		privacy: { tone: 'note', text: 'Some free routes may log prompts' },
		keyPattern: '^sk-or-v1-[A-Za-z0-9]{40,}$',
		verify: { method: 'GET', url: 'https://openrouter.ai/api/v1/key', header: 'bearer' },
	},
	{
		id: 'nvidia', name: 'NVIDIA',
		signupUrl: 'https://build.nvidia.com/', keyUrl: 'https://build.nvidia.com/settings/api-keys',
		steps: ['Sign in with email', 'Click Generate API Key', 'Copy the key'],
		models: ['DeepSeek V4.1 Flash', 'GLM 5.3 Flash', 'Kimi K2.6'],
		limits: 'About 40 a minute',
		privacy: { tone: 'note', text: 'For trying things out' },
		keyPattern: '^nvapi-[A-Za-z0-9_-]{40,}$',
		verify: { method: 'POST', url: 'https://integrate.api.nvidia.com/v1/chat/completions', model: 'deepseek-ai/deepseek-v4.1-flash' },
	},
	{
		id: 'zai', name: 'Z.ai',
		signupUrl: 'https://z.ai/model-api', keyUrl: 'https://z.ai/manage-apikey/apikey-list',
		steps: ['Register or log in', 'Create a Standard API Key', 'Copy the key'],
		models: ['GLM 4.7 Flash', 'GLM 4.5 Flash'],
		limits: 'Free models, one request at a time',
		verify: { method: 'GET', url: 'https://api.z.ai/api/paas/v4/models', header: 'bearer' },
	},
	{
		id: 'groq', name: 'Groq',
		signupUrl: 'https://console.groq.com/', keyUrl: 'https://console.groq.com/keys',
		steps: ['Sign up or log in', 'Click Create API Key', 'Copy the key'],
		models: ['GPT-OSS 120B', 'Qwen 3.8 27B', 'Llama 3.3 70B'],
		limits: '30 a minute, 1,000 a day',
		privacy: { tone: 'good', text: 'No training on your code' },
		keyPattern: '^gsk_[A-Za-z0-9]{40,}$',
		verify: { method: 'GET', url: 'https://api.groq.com/openai/v1/models', header: 'bearer' },
	},
	{
		id: 'google', name: 'Google Gemini',
		signupUrl: 'https://aistudio.google.com/', keyUrl: 'https://aistudio.google.com/apikey',
		steps: ['Sign in with Google', 'Click Create API key', 'Copy the key'],
		models: ['Gemini 3.8 Flash', 'Gemini 3.5 Flash-Lite'],
		limits: 'Shown in AI Studio, small on the newest model',
		privacy: { tone: 'note', text: 'Trains on prompts outside the EU and UK' },
		keyPattern: '^(AIza[0-9A-Za-z_-]{35}|AQ\\.[A-Za-z0-9_.-]{20,})$',
		verify: { method: 'GET', url: 'https://generativelanguage.googleapis.com/v1beta/models', header: 'goog' },
	},
	{
		id: 'mistral', name: 'Mistral',
		signupUrl: 'https://console.mistral.ai/', keyUrl: 'https://console.mistral.ai/api-keys',
		steps: ['Sign in or sign up', 'Click Create new key', 'Copy the key'],
		models: ['Mistral Medium 3.5', 'Codestral'],
		limits: 'Monthly allowance, shown in your console',
		privacy: { tone: 'note', text: 'May train on prompts, opt out in settings' },
		verify: { method: 'GET', url: 'https://api.mistral.ai/v1/models', header: 'bearer' },
	},
	{
		id: 'sambanova', name: 'SambaNova',
		signupUrl: 'https://cloud.sambanova.ai/', keyUrl: 'https://cloud.sambanova.ai/apis',
		steps: ['Sign up or log in', 'Generate an API key', 'Copy the key'],
		models: ['DeepSeek V3.1', 'GPT-OSS 120B'],
		limits: '20 a day, a good backup',
		verify: { method: 'POST', url: 'https://api.sambanova.ai/v1/chat/completions', model: 'DeepSeek-V3.1' },
	},
];

/** Without a documented key shape, accept anything that looks like a single token. */
export function looksLikeKey(spec: FreeProviderSpec, text: string): boolean {
	const t = text.trim();
	if (spec.keyPattern) { return new RegExp(spec.keyPattern).test(t); }
	return /^[A-Za-z0-9._-]{20,200}$/.test(t);
}

export async function verifyFreeKey(spec: FreeProviderSpec, key: string): Promise<{ ok: boolean; message: string }> {
	const v = spec.verify;
	let res: Response;
	try {
		res = v.method === 'GET'
			? await fetch(v.url, { headers: v.header === 'goog' ? { 'x-goog-api-key': key } : { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) })
			: await fetch(v.url, {
				method: 'POST',
				headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
				body: JSON.stringify({ model: v.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
				signal: AbortSignal.timeout(20_000),
			});
	} catch {
		return { ok: false, message: `Could not reach ${spec.name}. Check your connection and try again.` };
	}
	if (res.ok) { return { ok: true, message: 'Connected' }; }
	if (res.status === 429) { return { ok: true, message: 'Connected. It is busy right now, so the first request may wait.' }; }
	// Google answers an unknown key with 400 API_KEY_INVALID rather than 401.
	if (res.status === 401 || res.status === 403 || (res.status === 400 && spec.id === 'google')) { return { ok: false, message: `${spec.name} did not accept that key. Copy it again from the key page.` }; }
	// The test request names one model; if that model moved (404, 422, 400) the key itself still got past auth.
	if (v.method === 'POST' && (res.status === 400 || res.status === 404 || res.status === 422)) { return { ok: true, message: 'Connected' }; }
	return { ok: false, message: `${spec.name} answered with an error (${res.status}). Try again in a moment.` };
}
